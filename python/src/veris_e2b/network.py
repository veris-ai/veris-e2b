"""Builds the E2B ``network`` option for gateway mode: deny-all + explicit
allowlist + egress proxy, per the one documented shape for domain filtering."""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from typing import TYPE_CHECKING, Any, Literal
from urllib.parse import urlsplit

from e2b import ALL_TRAFFIC

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .control_plane import EgressCredential, ServiceInfo

EgressMode = Literal["strict", "open"]

_HTTP_URL = re.compile(r"^https?:")


def is_http_url(url: str) -> bool:
    """True when a service ``url`` is an HTTP endpoint (vs a wire-protocol DSN)."""
    return bool(_HTTP_URL.match(url or ""))


def vendor_hosts(services: Sequence[ServiceInfo]) -> list[str]:
    """Vendor hostnames the twin answers for, from the live routes the control plane serves."""
    hosts: set[str] = set()
    for svc in services:
        for route in svc.routes or []:
            hosts.add(route.host)
    return sorted(hosts)


_DSN_HOST = re.compile(r"^\[?([A-Za-z0-9_.:-]+?)\]?(?::\d+)?$")


def _hosts_from_dsn(dsn: str) -> list[str]:
    """Every host in a DSN, including the extra ones of a multi-host DSN.

    DSNs come in every shape — with/without credentials, with/without a trailing
    path, redis/kafka/mongo, IPv6 in brackets, comma-separated multi-host — so
    the URL parser does the work and a regex sweeps the authority for the hosts
    it cannot see.
    """
    out: list[str] = []
    try:
        parsed = urlsplit(dsn)
        if parsed.hostname:
            out.append(parsed.hostname.strip("[]"))
    except ValueError:
        pass  # Not URL-parseable — the authority sweep below still tries.
    authority = re.sub(r"^[^:]+://", "", dsn).split("/")[0].split("?")[0]
    after_at = authority[authority.rfind("@") + 1 :] if "@" in authority else authority
    for part in after_at.split(","):
        match = _DSN_HOST.match(part)
        if match and not match.group(1).isdigit():
            out.append(match.group(1).strip("[]"))
    return out


def data_plane_hosts(services: Sequence[ServiceInfo]) -> list[str]:
    """Endpoints of non-HTTP data planes (e.g. the pg-gateway a postgres DSN targets).

    These flows are CIDR/host-matched, not domain-matched, so strict mode must
    allow them explicitly or the data plane silently breaks.
    """
    hosts: set[str] = set()
    for svc in services:
        if not svc.url or is_http_url(svc.url):
            continue
        hosts.update(_hosts_from_dsn(svc.url))
    return sorted(hosts)


#: Env names a data-plane hint may never claim: they steer the sandbox's own
#: processes, and the name comes from a control-plane response.
_PROCESS_CONTROLLING = frozenset(
    {
        "PATH",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "NODE_OPTIONS",
        "BASH_ENV",
        "ENV",
        "PYTHONPATH",
        "PYTHONSTARTUP",
        "SHELL",
        "IFS",
        "HOME",
        "PROMPT_COMMAND",
    }
)
_ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")


def is_safe_env_name(name: str) -> bool:
    """Conventional SCREAMING_SNAKE, and never a process-controlling variable."""
    return bool(_ENV_NAME.match(name or "")) and name not in _PROCESS_CONTROLLING


def data_plane_env(services: Sequence[ServiceInfo]) -> dict[str, str]:
    """``{env_hint: dsn}`` for the twin's non-HTTP data planes — the env the code
    under test reads (e.g. ``DATABASE_URL``)."""
    envs: dict[str, str] = {}
    for svc in services:
        if not svc.env_hint or not svc.url or is_http_url(svc.url):
            continue
        if not is_safe_env_name(svc.env_hint):
            continue
        envs[svc.env_hint] = svc.url
    return envs


def caller_static_allow_out(network: Mapping[str, Any] | None) -> list[str]:
    """The caller's STATIC allow_out entries; a selector callable contributes none."""
    allow = (network or {}).get("allow_out")
    if isinstance(allow, (list, tuple)):
        return [entry for entry in allow if isinstance(entry, str)]
    return []


def build_network(
    *,
    credential: EgressCredential,
    services: Sequence[ServiceInfo],
    mode: EgressMode,
    allow_out: Iterable[str] = (),
) -> dict[str, Any]:
    """Deny-all + allowlist + egress proxy — the only shape E2B documents for
    domain filtering.

    The two egress modes differ only in whether the list ends with a catch-all.
    ``strict`` is the default: it is the only mode in which the receipt has no
    known blind spots (QUIC/HTTP3 and ECH fail closed instead of silently
    reaching the real vendor).
    """
    entries = [
        *vendor_hosts(services),
        credential.canary_host,
        *allow_out,
        *data_plane_hosts(services),
    ]
    if mode == "open":
        entries.append(ALL_TRAFFIC)
    deduped = list(dict.fromkeys(entries))
    return {
        "deny_out": [ALL_TRAFFIC],
        "allow_out": deduped,
        "egress_proxy": {
            "address": credential.socks_address,
            "username": credential.username,
            "password": credential.password,
        },
    }
