"""The Veris API key on a twin service's ``control_url``, and nowhere else.

Split sandboxes serve ``/veris/*`` on ``/c/<sandbox>/<svc>`` and require the same
``X-API-Key`` the SDK sends to ``/v1``; the data-plane ``url`` and the vendor
hostnames it answers for are not authenticated and must never see the key —
they are reachable from the code under test, which is the thing being tested,
not a party to trust with the org's credential. Older (``control_auth: null``)
sandboxes still serve a keyless control URL; sending the key there is harmless,
so the SDK sends it whenever it has one.

Every control call therefore goes through :func:`control_headers`, which only
attaches the key when the request URL is on the control URL's own origin and
under its path, and is made with redirects disabled so a 3xx cannot carry the
key anywhere else — not even on a caller-supplied client that follows them.
"""

from __future__ import annotations

from collections.abc import Mapping

import httpx

from .control_plane import ServiceInfo
from .errors import VerisControlAuthError

API_KEY_HEADER = "X-API-Key"


def _origin(url: str) -> tuple[str, str, int] | None:
    try:
        parsed = httpx.URL(url)
    except (httpx.InvalidURL, TypeError, ValueError):
        return None
    if parsed.scheme not in ("http", "https") or not parsed.host:
        return None
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return parsed.scheme, parsed.host.lower(), port


def is_control_request(url: str, control_url: str) -> bool:
    """True only for a URL on the control URL's own origin *and* under its path.

    Origin alone is not enough: on a split sandbox the data-plane ``url``
    (``/s/…``) shares the host with ``control_url`` (``/c/…``), and it is the
    code under test's address, not the control plane's.
    """
    target, base = _origin(url), _origin(control_url)
    if target is None or target != base:
        return False
    prefix = httpx.URL(control_url).path.rstrip("/") + "/"
    return httpx.URL(url).path.startswith(prefix)


def control_headers(
    service: ServiceInfo,
    url: str,
    api_key: str | None,
    extra: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Headers for one request to ``url`` on behalf of ``service``'s control plane."""
    headers = dict(extra or {})
    if api_key and is_control_request(url, service.control_url):
        headers[API_KEY_HEADER] = api_key
    return headers


def raise_for_control_auth(
    service: ServiceInfo, status_code: int, what: str, api_key: str | None
) -> None:
    """Turn a control-plane 401 into an error that names the credential."""
    if status_code != 401:
        return
    sent = "was rejected" if api_key else "was not sent (no API key available)"
    raise VerisControlAuthError(
        f"service {service.name!r} control plane refused {what} (401): the Veris API key "
        f"{sent} — check VERIS_API_KEY / VerisOpts.api_key, and that the key belongs to "
        f"the org that owns this sandbox",
        service.name,
        phase="receipt",
    )
