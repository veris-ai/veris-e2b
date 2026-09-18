"""Run-scoped receipts: a baseline taken before execution, so a later read
credits this run with its own traffic and nothing else.

A unique, read-only control request anchors the history, which survives even a
reset that preserves numeric ids. No server-side generation endpoint is assumed.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import httpx

from .control_plane import ServiceInfo
from .errors import VerisError
from .receipt import RECEIPT_TIMEOUT_S, read_page, read_page_async

#: The header whose echo in the trace identifies our anchor row.
BASELINE_HEADER = "x-veris-receipt-baseline"
#: Trace middleware commits after the response is sent. A bounded retry
#: accommodates that commit without ever accepting an absent anchor.
ANCHOR_ATTEMPTS = 5
ANCHOR_BACKOFF_S = 0.05


@dataclass(frozen=True)
class ServiceMark:
    control_url: str
    id: int
    marker: str


@dataclass(frozen=True)
class ReceiptBaseline:
    """Where each service's log stood when the run began."""

    twin_id: str
    sandbox_id: str
    services: dict[str, ServiceMark] = field(default_factory=dict)
    version: int = 1

    def to_dict(self) -> dict[str, Any]:
        """A plain dict, for storing the baseline between processes."""
        return {
            "version": self.version,
            "twin_id": self.twin_id,
            "sandbox_id": self.sandbox_id,
            "services": {
                name: {"control_url": mark.control_url, "id": mark.id, "marker": mark.marker}
                for name, mark in self.services.items()
            },
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> ReceiptBaseline:
        return cls(
            version=data.get("version", 1),
            twin_id=str(data.get("twin_id", "")),
            sandbox_id=str(data.get("sandbox_id", "")),
            services={
                name: ServiceMark(
                    control_url=str(mark.get("control_url", "")),
                    id=int(mark.get("id", 0)),
                    marker=str(mark.get("marker", "")),
                )
                for name, mark in (data.get("services") or {}).items()
            },
        )


def _marker_of(row: Mapping[str, Any]) -> Any:
    """The baseline header this row echoed, if it echoed one."""
    headers = row.get("request_headers")
    if isinstance(headers, str):
        try:
            headers = json.loads(headers)
        except ValueError:
            return None
    return headers.get(BASELINE_HEADER) if isinstance(headers, Mapping) else None


def _anchor_of(rows: Sequence[Mapping[str, Any]], marker: str) -> Mapping[str, Any] | None:
    return next(
        (
            row
            for row in rows
            if _marker_of(row) == marker
            and row.get("tier") == "control"
            and row.get("path") == "/veris/schema"
        ),
        None,
    )


def _anchor_url(service: ServiceInfo) -> str:
    return f"{service.control_url.rstrip('/')}/veris/schema"


def _anchor_failed(service_name: str, status_code: int) -> VerisError:
    return VerisError(
        f"could not establish baseline for {service_name!r} ({status_code})", phase="receipt"
    )


def _no_anchor(service_name: str) -> VerisError:
    return VerisError(
        f"baseline unavailable for {service_name!r}: trace must retain control request headers",
        phase="receipt",
    )


def _invalid() -> VerisError:
    return VerisError(
        "receipt baseline invalid: session, services or history changed; take a new baseline "
        "before execution",
        phase="receipt",
    )


def _shape_ok(
    baseline: ReceiptBaseline, twin_id: str, sandbox_id: str, services: Sequence[ServiceInfo]
) -> None:
    if (
        baseline.version != 1
        or baseline.twin_id != twin_id
        or baseline.sandbox_id != sandbox_id
        or sorted(baseline.services) != sorted(s.name for s in services)
    ):
        raise _invalid()


def _mark_ok(baseline: ReceiptBaseline, service: ServiceInfo) -> ServiceMark:
    mark = baseline.services.get(service.name)
    if mark is None or mark.control_url != service.control_url or mark.id <= 0:
        raise _invalid()
    return mark


def _anchor_still_there(rows: Sequence[Mapping[str, Any]], mark: ServiceMark) -> None:
    if len(rows) != 1 or rows[0].get("id") != mark.id or _marker_of(rows[0]) != mark.marker:
        raise _invalid()


def capture_baseline(
    twin_id: str,
    sandbox_id: str,
    services: Sequence[ServiceInfo],
    client: httpx.Client | None = None,
) -> ReceiptBaseline:
    """Mark where each service's log stands right now."""
    marks: dict[str, ServiceMark] = {}
    owned = client is None
    http = client or httpx.Client(timeout=RECEIPT_TIMEOUT_S, follow_redirects=False)
    try:
        for service in services:
            marker = str(uuid.uuid4())
            response = http.get(
                _anchor_url(service),
                headers={BASELINE_HEADER: marker},
                timeout=RECEIPT_TIMEOUT_S,
            )
            if response.status_code >= 300:
                raise _anchor_failed(service.name, response.status_code)
            for attempt in range(ANCHOR_ATTEMPTS):
                rows = read_page(service, {"limit": 1000, "order": "desc"}, http)
                anchor = _anchor_of(rows, marker)
                if anchor is not None:
                    marks[service.name] = ServiceMark(
                        control_url=service.control_url, id=anchor["id"], marker=marker
                    )
                    break
                if attempt + 1 < ANCHOR_ATTEMPTS:
                    import time

                    time.sleep(ANCHOR_BACKOFF_S)
            else:
                raise _no_anchor(service.name)
    finally:
        if owned:
            http.close()
    return ReceiptBaseline(twin_id=twin_id, sandbox_id=sandbox_id, services=marks)


async def capture_baseline_async(
    twin_id: str,
    sandbox_id: str,
    services: Sequence[ServiceInfo],
    client: httpx.AsyncClient | None = None,
) -> ReceiptBaseline:
    import asyncio
    from contextlib import AsyncExitStack

    marks: dict[str, ServiceMark] = {}
    async with AsyncExitStack() as stack:
        http = client or await stack.enter_async_context(
            httpx.AsyncClient(timeout=RECEIPT_TIMEOUT_S, follow_redirects=False)
        )
        for service in services:
            marker = str(uuid.uuid4())
            response = await http.get(
                _anchor_url(service),
                headers={BASELINE_HEADER: marker},
                timeout=RECEIPT_TIMEOUT_S,
            )
            if response.status_code >= 300:
                raise _anchor_failed(service.name, response.status_code)
            for attempt in range(ANCHOR_ATTEMPTS):
                rows = await read_page_async(service, {"limit": 1000, "order": "desc"}, http)
                anchor = _anchor_of(rows, marker)
                if anchor is not None:
                    marks[service.name] = ServiceMark(
                        control_url=service.control_url, id=anchor["id"], marker=marker
                    )
                    break
                if attempt + 1 < ANCHOR_ATTEMPTS:
                    await asyncio.sleep(ANCHOR_BACKOFF_S)
            else:
                raise _no_anchor(service.name)
    return ReceiptBaseline(twin_id=twin_id, sandbox_id=sandbox_id, services=marks)


def validate_baseline(
    baseline: ReceiptBaseline,
    twin_id: str,
    sandbox_id: str,
    services: Sequence[ServiceInfo],
    client: httpx.Client | None = None,
) -> None:
    """Refuse a baseline whose session, services or history no longer match."""
    _shape_ok(baseline, twin_id, sandbox_id, services)
    for service in services:
        mark = _mark_ok(baseline, service)
        rows = read_page(service, {"limit": 1, "order": "asc", "since_id": mark.id - 1}, client)
        _anchor_still_there(rows, mark)


async def validate_baseline_async(
    baseline: ReceiptBaseline,
    twin_id: str,
    sandbox_id: str,
    services: Sequence[ServiceInfo],
    client: httpx.AsyncClient | None = None,
) -> None:
    _shape_ok(baseline, twin_id, sandbox_id, services)
    for service in services:
        mark = _mark_ok(baseline, service)
        rows = await read_page_async(
            service, {"limit": 1, "order": "asc", "since_id": mark.id - 1}, client
        )
        _anchor_still_there(rows, mark)
