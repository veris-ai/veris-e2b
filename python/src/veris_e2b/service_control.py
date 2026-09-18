"""Scoped reads and writes against one twin service's ``/veris/*`` control plane.

Only advertised services and a fixed set of control resources resolve here.
Lifecycle verbs and arbitrary URLs are deliberately absent: the caller owns the
sandbox, not the twin's existence.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Literal

import httpx

from .control_plane import ServiceInfo
from .errors import VerisError

ControlResource = Literal["manual", "schema", "operations", "data", "requests"]
ControlMethod = Literal["GET", "POST", "PATCH"]

_RESOURCES = frozenset({"manual", "schema", "operations", "data", "requests"})
_METHODS = frozenset({"GET", "POST", "PATCH"})
#: A control call is a small request; bound it like every other.
CONTROL_TIMEOUT_S = 30.0


def _check(service: ServiceInfo, resource: str, method: str, body: Any) -> None:
    """Refuse anything outside the advertised surface.

    Writes are confined to ``data`` — the seed state — because every other
    resource describes the twin rather than its contents, and a redirect is
    refused outright so a control URL cannot be walked somewhere else.
    """
    if (
        resource not in _RESOURCES
        or method not in _METHODS
        or (method != "GET" and resource != "data")
        or (method == "GET" and body is not None)
        or not service.control_url.startswith(("http://", "https://"))
    ):
        raise VerisError("unsupported service control operation", phase="receipt")


def _decode(service_name: str, resource: str, method: str, status_code: int, text: str) -> Any:
    if status_code >= 300:
        raise VerisError(
            f"service {service_name!r} {method} /veris/{resource} failed ({status_code})",
            phase="receipt",
        )
    try:
        return json.loads(text)
    except ValueError as cause:
        raise VerisError(
            f"service {service_name!r} returned invalid control JSON", phase="receipt"
        ) from cause


def _url(service: ServiceInfo, resource: str) -> str:
    return f"{service.control_url.rstrip('/')}/veris/{resource}"


def service_control(
    service: ServiceInfo,
    resource: ControlResource,
    *,
    method: ControlMethod = "GET",
    query: Mapping[str, str] | None = None,
    body: Any = None,
    client: httpx.Client | None = None,
) -> Any:
    """Read (or, for ``data``, write) one of a service's control resources."""
    _check(service, resource, method, body)
    owned = client is None
    http = client or httpx.Client(timeout=CONTROL_TIMEOUT_S, follow_redirects=False)
    try:
        response = http.request(
            method,
            _url(service, resource),
            params=dict(query or {}),
            json=body,
            timeout=CONTROL_TIMEOUT_S,
            headers={"Content-Type": "application/json"},
        )
    finally:
        if owned:
            http.close()
    return _decode(service.name, resource, method, response.status_code, response.text)


async def service_control_async(
    service: ServiceInfo,
    resource: ControlResource,
    *,
    method: ControlMethod = "GET",
    query: Mapping[str, str] | None = None,
    body: Any = None,
    client: httpx.AsyncClient | None = None,
) -> Any:
    _check(service, resource, method, body)
    request = {
        "params": dict(query or {}),
        "json": body,
        "headers": {"Content-Type": "application/json"},
    }
    if client is not None:
        response = await client.request(
            method, _url(service, resource), timeout=CONTROL_TIMEOUT_S, **request
        )
    else:
        async with httpx.AsyncClient(timeout=CONTROL_TIMEOUT_S, follow_redirects=False) as owned:
            response = await owned.request(method, _url(service, resource), **request)
    return _decode(service.name, resource, method, response.status_code, response.text)
