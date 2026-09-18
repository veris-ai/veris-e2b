"""The receipt: what the twin actually received, parsed from each service's
``/veris/requests`` log — plus the integrity probe that keeps it honest.

Two things the log does not hand over for free, and both change the number:

    the page      ``GET /veris/requests`` defaults to ``limit=50`` and caps it
                  at 1000. Asking with no query string is asking for 50, so a
                  run that made 200 calls reports 50 and says nothing about it.
                  Read here in pages of 1000 until the log runs out.
    the watermark A twin that was ATTACHED rather than freshly created already
                  has a log. Counting all of it credits this run with traffic
                  from before it began, so the read starts at a mark taken when
                  the run did — see :func:`fetch_watermark`.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

from .control_plane import ServiceInfo
from .errors import ReceiptIntegrityError, VerisError

#: Reading one page of a trace log is a small call; bound it like every other.
RECEIPT_TIMEOUT_S = 30.0
#: The canary probe runs curl in the sandbox; give the command room to time out
#: on its own (--max-time 15) before the transport does.
CANARY_COMMAND_TIMEOUT_S = 30.0
#: The server's own ceiling. Asking for more is asking to be silently capped.
PAGE_LIMIT = 1000
#: A read that needs more pages than this stops and says so rather than looping.
MAX_PAGES = 20
#: Tiers that represent the vendor surface. Control-plane chatter is not traffic
#: the code under test made.
VENDOR_TIERS = frozenset({"handler", "fault", "fallback", "fallback-llm", "fallback-replay"})

ReceiptLeak = Literal["udp-quic-possible", "ech-possible"]

_VERIS_PATH = re.compile(r"^/veris(?:/|$)")


@dataclass(frozen=True)
class ReceiptRequest:
    """One intercepted request, from the twin's trace log."""

    #: Row id. Monotonic per service, and what a later read resumes from.
    id: int
    method: str
    path: str
    #: None = no response sent (fault hang).
    status: int | None
    tier: str


@dataclass(frozen=True)
class ReceiptEntry:
    """One service's share of a receipt."""

    #: Vendor-surface requests the twin received since the watermark. A floor,
    #: not a count, when ``capped`` is set.
    requests: int
    #: The twin service's ``/veris/*`` control plane.
    control_url: str
    #: Typed request list, newest first.
    entries: list[ReceiptRequest] = field(default_factory=list)
    #: The read stopped before the log did, so ``requests`` is "at least this
    #: many". Never silent: a count that is quietly a floor is exactly the bug
    #: this replaced.
    capped: bool = False
    #: Present when this is only a lower bound.
    incomplete_reason: str | None = None
    since_id: int = 0
    until_id: int = 0
    #: The ``/veris/requests`` rows read, verbatim as served, merged across pages.
    raw: Any = None


@dataclass(frozen=True)
class Receipt:
    """What every service in the twin received, and how much to trust the count."""

    #: Keyed by service name.
    services: dict[str, ReceiptEntry]
    #: How the traffic was moved. One tier now: the Veris gateway.
    mode: Literal["gateway", "proxy"]
    #: ``verified`` only when the canary confirmed egress is still tunnelled
    #: through the gateway and demuxed to THIS twin.
    integrity: Literal["verified", "proxy-mode-unverified"]
    #: Known blind spots of THIS receipt.
    leaks: list[ReceiptLeak] = field(default_factory=list)


def rows_of(body: Any) -> list[dict[str, Any]]:
    """The rows of a request-log body, or a failure.

    A malformed read is a failure, never successful empty evidence: "zero
    requests" and "we could not tell" must not print the same.
    """
    rows = body.get("requests") if isinstance(body, Mapping) else None
    if not isinstance(rows, list):
        raise VerisError("invalid request log: expected requests array", phase="receipt")
    for row in rows:
        if (
            not isinstance(row, Mapping)
            or not isinstance(row.get("id"), int)
            or isinstance(row.get("id"), bool)
            or row["id"] <= 0
            or not isinstance(row.get("method"), str)
            or not isinstance(row.get("path"), str)
            or not isinstance(row.get("tier"), str)
            or not (row.get("status") is None or isinstance(row.get("status"), int))
        ):
            raise VerisError(
                "invalid request log row: stable id, method, path, tier and status required",
                phase="receipt",
            )
    return list(rows)


def parse_requests_body(body: Any) -> tuple[int, list[ReceiptRequest], int]:
    """``(count, entries, total)`` — entries being the vendor surface only."""
    rows = rows_of(body)
    entries = [
        ReceiptRequest(
            id=row["id"],
            method=row["method"],
            path=row["path"],
            status=row.get("status"),
            tier=row["tier"],
        )
        for row in rows
        if row["tier"] in VENDOR_TIERS and not _VERIS_PATH.match(row["path"])
    ]
    return len(entries), entries, len(rows)


def _page_url(service: ServiceInfo) -> str:
    return f"{service.control_url.rstrip('/')}/veris/requests"


def _page_rows(service_name: str, status_code: int, text: str) -> list[dict[str, Any]]:
    if status_code >= 300:
        raise VerisError(
            f"could not read receipt for service {service_name!r} ({status_code})", phase="receipt"
        )
    try:
        body = json.loads(text)
    except ValueError as cause:
        raise VerisError(
            f"service {service_name!r} returned a non-JSON receipt body", phase="receipt"
        ) from cause
    return rows_of(body)


def read_page(
    service: ServiceInfo, params: Mapping[str, Any], client: httpx.Client | None = None
) -> list[dict[str, Any]]:
    """One page of a service's trace log."""
    owned = client is None
    http = client or httpx.Client(timeout=RECEIPT_TIMEOUT_S, follow_redirects=False)
    try:
        response = http.get(_page_url(service), params=dict(params), timeout=RECEIPT_TIMEOUT_S)
    finally:
        if owned:
            http.close()
    return _page_rows(service.name, response.status_code, response.text)


async def read_page_async(
    service: ServiceInfo, params: Mapping[str, Any], client: httpx.AsyncClient | None = None
) -> list[dict[str, Any]]:
    if client is not None:
        response = await client.get(
            _page_url(service), params=dict(params), timeout=RECEIPT_TIMEOUT_S
        )
    else:
        async with httpx.AsyncClient(timeout=RECEIPT_TIMEOUT_S, follow_redirects=False) as owned:
            response = await owned.get(_page_url(service), params=dict(params))
    return _page_rows(service.name, response.status_code, response.text)


def _watermark_of(rows: Sequence[Mapping[str, Any]]) -> int:
    if len(rows) > 1:
        raise VerisError("request log ignored watermark limit", phase="receipt")
    return rows[0]["id"] if rows else 0


def fetch_watermark(service: ServiceInfo, client: httpx.Client | None = None) -> int:
    """The newest row id, so a later read can start from here rather than zero."""
    return _watermark_of(read_page(service, {"limit": 1, "order": "desc"}, client))


async def fetch_watermark_async(
    service: ServiceInfo, client: httpx.AsyncClient | None = None
) -> int:
    return _watermark_of(await read_page_async(service, {"limit": 1, "order": "desc"}, client))


class _Window:
    """The paging state machine, shared by the sync and async readers.

    It owns every decision — what to ask for next, whether a page may be
    credited, when to stop and why — so the two readers differ only in how they
    fetch.
    """

    def __init__(self, service: ServiceInfo, since_id: int, end: int) -> None:
        if not isinstance(since_id, int) or isinstance(since_id, bool) or since_id < 0:
            raise VerisError("invalid receipt watermark", phase="receipt")
        if end < since_id:
            raise VerisError(
                "receipt baseline invalid: log moved backwards; take a new baseline",
                phase="receipt",
            )
        self.service = service
        self.since_id = since_id
        self.end = end
        self.mark = since_id
        self.page = 0
        self.entries: list[ReceiptRequest] = []
        self.raw: list[dict[str, Any]] = []
        self.incomplete_reason: str | None = None

    @property
    def done(self) -> bool:
        return self.mark >= self.end or self.incomplete_reason is not None

    def next_params(self) -> dict[str, Any] | None:
        """What to ask for next, or None when the read is over."""
        if self.done:
            return None
        if self.page >= MAX_PAGES:
            self.incomplete_reason = "page-limit"
            return None
        return {"limit": PAGE_LIMIT, "order": "asc", "since_id": self.mark}

    def read_failed(self, error: Exception) -> None:
        """A page that would not read. Fatal only if nothing was read at all."""
        if not self.raw:
            raise error
        self.incomplete_reason = "read-failed"

    def credit(self, rows: list[dict[str, Any]]) -> None:
        """Take a page — unless it shows the cursor is not advancing.

        Duplicate or backwards rows, an ignored cursor, or an ignored order all
        mean there may be entries this read never saw. Do not credit that page
        and do not call the count exact.
        """
        previous = self.mark
        for row in rows:
            if row["id"] <= previous:
                self.incomplete_reason = "pagination-not-progressing"
                return
            previous = row["id"]
        if not rows:
            self.incomplete_reason = "pagination-not-progressing"
            return
        window = [row for row in rows if row["id"] <= self.end]
        self.raw.extend(window)
        self.entries.extend(parse_requests_body({"requests": window})[1])
        self.mark = rows[-1]["id"]
        self.page += 1

    def result(self) -> ReceiptEntry:
        entries = sorted(self.entries, key=lambda r: r.id, reverse=True)
        return ReceiptEntry(
            requests=len(entries),
            control_url=self.service.control_url,
            entries=entries,
            capped=self.incomplete_reason is not None,
            incomplete_reason=self.incomplete_reason,
            since_id=self.since_id,
            until_id=self.end,
            raw={"requests": self.raw},
        )


def fetch_receipt_entry(
    service: ServiceInfo, since_id: int = 0, client: httpx.Client | None = None
) -> ReceiptEntry:
    """Read a finite window of one service's log.

    The newest-id snapshot taken first also detects a server that silently caps
    pages below the requested limit. Row counts are never subtracted.
    """
    window = _Window(service, since_id, fetch_watermark(service, client))
    while (params := window.next_params()) is not None:
        try:
            rows = read_page(service, params, client)
        except VerisError as error:
            window.read_failed(error)
            break
        window.credit(rows)
    return window.result()


async def fetch_receipt_entry_async(
    service: ServiceInfo, since_id: int = 0, client: httpx.AsyncClient | None = None
) -> ReceiptEntry:
    window = _Window(service, since_id, await fetch_watermark_async(service, client))
    while (params := window.next_params()) is not None:
        try:
            rows = await read_page_async(service, params, client)
        except VerisError as error:
            window.read_failed(error)
            break
        window.credit(rows)
    return window.result()


_HOSTNAME = re.compile(r"^[A-Za-z0-9.-]+$")
_CA_PATH = re.compile(r"^/[\w./-]+$")


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
