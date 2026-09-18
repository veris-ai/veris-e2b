"""The receipt: what the twin actually received, parsed from each service's
``/veris/requests`` log — plus the canary probe that keeps a gateway-mode
receipt honest."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

import httpx

from .control_plane import ServiceInfo
from .errors import ReceiptIntegrityError, VerisError

#: Reading one service's trace log is a small call; bound it like every other.
RECEIPT_TIMEOUT_S = 30.0
#: The canary probe runs curl in the sandbox; give the command room to time out
#: on its own (--max-time 15) before the transport does.
CANARY_COMMAND_TIMEOUT_S = 30.0

ReceiptLeak = Literal["udp-quic-possible", "ech-possible"]


@dataclass(frozen=True)
class ReceiptRequest:
    """One intercepted request, from the twin's trace log."""

    method: str
    path: str
    #: None = no response sent (fault hang).
    status: int | None = None


@dataclass(frozen=True)
class ReceiptEntry:
    """One service's share of a receipt."""

    #: Count of intercepted requests (a real parse, not a regex).
    requests: int
    #: The twin service's ``/veris/*`` control plane.
    control_url: str
    #: Typed request list, newest first.
    entries: list[ReceiptRequest] = field(default_factory=list)
    #: Verbatim ``/veris/requests`` body.
    raw: Any = None


@dataclass(frozen=True)
class Receipt:
    """What every service in the twin received, and how much to trust the count."""

    #: Keyed by service name.
    services: dict[str, ReceiptEntry]
    #: Which routing mode produced this receipt — the guarantees differ.
    mode: Literal["gateway", "proxy"]
    #: ``verified`` only when the canary proved egress is still tunneled.
    integrity: Literal["verified", "proxy-mode-unverified"]
    #: Known blind spots of THIS receipt. Empty in strict gateway mode.
    leaks: list[ReceiptLeak] = field(default_factory=list)


def parse_requests_body(body: Any) -> tuple[int, list[ReceiptRequest]]:
    """``(count, entries)`` from a ``/veris/requests`` body, tolerating junk."""
    rows = body.get("requests") if isinstance(body, Mapping) else None
    if not isinstance(rows, Sequence) or isinstance(rows, (str, bytes)):
        rows = []
    entries = []
    for row in rows:
        data = row if isinstance(row, Mapping) else {}
        status = data.get("status")
        entries.append(
            ReceiptRequest(
                method=str(data.get("method", "")),
                path=str(data.get("path", "")),
                status=status if isinstance(status, int) and not isinstance(status, bool) else None,
            )
        )
    return len(entries), entries


def _entry_from_response(
    service_name: str, control_url: str, status_code: int, text: str
) -> ReceiptEntry:
    if status_code >= 300:
        raise VerisError(
            f"could not read receipt for service '{service_name}' ({status_code})",
            phase="receipt",
            response_body=text[:500],
        )
    try:
        raw = json.loads(text)
    except ValueError as cause:
        raise VerisError(
            f"service '{service_name}' returned a non-JSON receipt body",
            phase="receipt",
            response_body=text[:500],
        ) from cause
    count, entries = parse_requests_body(raw)
    return ReceiptEntry(requests=count, control_url=control_url, entries=entries, raw=raw)


def fetch_receipt_entry(service: ServiceInfo, client: httpx.Client | None = None) -> ReceiptEntry:
    url = f"{service.control_url}/veris/requests"
    if client is not None:
        response = client.get(url, timeout=RECEIPT_TIMEOUT_S)
    else:
        response = httpx.get(url, timeout=RECEIPT_TIMEOUT_S)
    return _entry_from_response(
        service.name, service.control_url, response.status_code, response.text
    )


async def fetch_receipt_entry_async(
    service: ServiceInfo, client: httpx.AsyncClient | None = None
) -> ReceiptEntry:
    url = f"{service.control_url}/veris/requests"
    if client is not None:
        response = await client.get(url, timeout=RECEIPT_TIMEOUT_S)
    else:
        async with httpx.AsyncClient(timeout=RECEIPT_TIMEOUT_S) as owned:
            response = await owned.get(url)
    return _entry_from_response(
        service.name, service.control_url, response.status_code, response.text
    )


_HOSTNAME = re.compile(r"^[A-Za-z0-9.-]+$")
_CA_PATH = re.compile(r"^/[\w./-]+$")


class _CommandResult(Protocol):  # pragma: no cover - structural typing only
    stdout: str
    stderr: str


def canary_command(canary_host: str, expected_twin_id: str, ca_cert_path: str | None) -> str:
    """The shell the canary probe runs, with both interpolations shape-checked.

    A control-plane response becomes part of a command here, so a canary host
    that is not a hostname — or a CA path that is not a path — is refused before
    the shell ever sees it.
    """
    if not _HOSTNAME.match(canary_host or ""):
        raise ReceiptIntegrityError(
            f"refusing to probe a malformed canary host from the control plane: {canary_host!r}",
            phase="canary",
            veris_sandbox_id=expected_twin_id,
        )
    if ca_cert_path and not _CA_PATH.match(ca_cert_path):
        raise ReceiptIntegrityError(
            f"malformed CA path: {ca_cert_path!r}",
            phase="canary",
            veris_sandbox_id=expected_twin_id,
        )
    ca_flag = f"--cacert {ca_cert_path} " if ca_cert_path else ""
    # A non-zero curl exit (no tunnel -> no HTTPS listener) must surface as a
    # ReceiptIntegrityError, not the raw exit exception the SDK would raise, so
    # the failure is printed and the exit code inspected here instead.
    return (
        f'curl -sS {ca_flag}--max-time 15 https://{canary_host}/ || echo "__VERIS_CANARY_FAIL__:$?"'
    )


def canary_verdict(stdout: str, stderr: str, expected_twin_id: str) -> None:
    """Raise unless the canary answered for exactly this twin."""
    try:
        body = json.loads(stdout)
    except ValueError:
        body = {}
    if not isinstance(body, Mapping) or body.get("veris_sandbox_id") != expected_twin_id:
        answered = (stdout or stderr or "nothing")[:200]
        raise ReceiptIntegrityError(
            f"canary probe failed: egress from this E2B sandbox is not tunneled through the "
            f"Veris gateway (expected twin {expected_twin_id}, canary answered: {answered})",
            phase="canary",
            veris_sandbox_id=expected_twin_id,
        )


def probe_canary(
    sandbox: Any, canary_host: str, expected_twin_id: str, ca_cert_path: str | None = None
) -> None:
    """One in-sandbox HTTPS request to a reserved hostname only the gateway answers.

    Green proves, in a single request: egress is actually tunneled, the
    credential demuxes to the right twin, and the CA install worked. Dialed
    outside the tunnel the host has no HTTPS listener, so it can never pass by
    accident.
    """
    command = canary_command(canary_host, expected_twin_id, ca_cert_path)
    try:
        result = sandbox.commands.run(command, timeout=CANARY_COMMAND_TIMEOUT_S)
        stdout, stderr = result.stdout, result.stderr
    except Exception as exc:  # noqa: BLE001 - any failure to run IS a failed probe
        stdout, stderr = "", str(exc)
    canary_verdict(stdout, stderr, expected_twin_id)


async def probe_canary_async(
    sandbox: Any, canary_host: str, expected_twin_id: str, ca_cert_path: str | None = None
) -> None:
    command = canary_command(canary_host, expected_twin_id, ca_cert_path)
    try:
        result = await sandbox.commands.run(command, timeout=CANARY_COMMAND_TIMEOUT_S)
        stdout, stderr = result.stdout, result.stderr
    except Exception as exc:  # noqa: BLE001 - any failure to run IS a failed probe
        stdout, stderr = "", str(exc)
    canary_verdict(stdout, stderr, expected_twin_id)
