"""The namespaced Veris surface: everything this package adds hangs off
``sbx.veris``, matching e2b's own ``sbx.commands`` / ``sbx.files`` idiom so a
future e2b minor can never collide with a generic method name."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import httpx

from .control_plane import AsyncControlPlane, ControlPlane, ServiceInfo
from .errors import VerisError, VerisUntouchedError
from .network import (
    EgressMode,
    build_network,
    caller_static_allow_out,
    data_plane_env,
    is_http_url,
)
from .receipt import (
    Receipt,
    ReceiptEntry,
    ReceiptLeak,
    fetch_receipt_entry,
    fetch_receipt_entry_async,
    probe_canary,
    probe_canary_async,
)
from .trust import vendored_trust_env

#: The delivery probe asks each service whether it can reach the destination.
PROBE_TIMEOUT_S = 30.0


@dataclass
class TouchMatcher:
    """Narrow ``assert_touched`` to specific requests. All fields AND together."""

    method: str | None = None
    #: Substring match against the request path.
    path: str | None = None
    #: Minimum matching requests required.
    min_requests: int = 1


@dataclass
class VerisContext:
    """Everything needed to answer Veris queries about a live sandbox."""

    sandbox: Any
    control_plane: ControlPlane | AsyncControlPlane
    environment_id: str
    twin_id: str
    egress: EgressMode
    allow_out: list[str]
    owns_twin: bool
    #: The reserved host the canary probe dials.
    canary_host: str | None = None
    #: The CA file path curl's --cacert uses in the canary.
    ca_cert_path: str | None = None
    #: Server-served trust env (falls back to vendored).
    trust_env: dict[str, str] | None = None
    mode: str = "gateway"
    #: HTTP client for the twins' own endpoints (receipts, delivery probes).
    #: None = one per call; supplying one lets a caller reuse connections.
    http: Any = None


def _leaks(egress: EgressMode) -> list[ReceiptLeak]:
    """Open egress lets a QUIC or ECH client reach a real vendor unseen; strict
    fails both closed, so its receipt has no known blind spots."""
    return ["udp-quic-possible", "ech-possible"] if egress == "open" else []


def _unknown_service(service: str, services: Sequence[ServiceInfo], twin_id: str) -> VerisError:
    available = ", ".join(s.name for s in services) or "none"
    return VerisError(
        f"unknown service {service!r} — the twin has no service by that name "
        f"(available: {available})",
        veris_sandbox_id=twin_id,
    )


def _match(entry: ReceiptEntry, matcher: TouchMatcher | None) -> int:
    if matcher is None:
        return len(entry.entries)
    return sum(
        1
        for request in entry.entries
        if (matcher.method is None or request.method.upper() == matcher.method.upper())
        and (matcher.path is None or matcher.path in request.path)
    )


def _untouched(
    service: str, matcher: TouchMatcher | None, matched: int, need: int, twin_id: str
) -> VerisUntouchedError:
    what = (
        f"matching {matcher.method or 'ANY'} {matcher.path or '*'} ({matched}/{need})"
        if matcher
        else "any intercepted requests"
    )
    return VerisUntouchedError(
        f"service {service!r} saw no {what} — the code under test never reached it "
        f"(a green suite that skipped its dependency looks identical to a working one)",
        service,
        veris_sandbox_id=twin_id,
    )


class VerisApi:
    """``sbx.veris`` on a blocking sandbox."""

    def __init__(self, ctx: VerisContext) -> None:
        self._ctx = ctx

    @property
    def sandbox_id(self) -> str:
        """The per-run Veris (twin) sandbox id."""
        return self._ctx.twin_id

    @property
    def mode(self) -> str:
        return self._ctx.mode

    def services(self) -> list[ServiceInfo]:
        """What is running in this twin."""
        return self._ctx.control_plane.services(self._ctx.twin_id)  # type: ignore[union-attr]

    def receipt(self, service: str | None = None) -> Receipt | ReceiptEntry:
        """What the twin actually received. One service's entry, or all of them.

        The canary proves egress is still tunneled before any count is trusted —
        a receipt from an un-tunneled sandbox would lie.
        """
        if self._ctx.canary_host:
            probe_canary(
                self._ctx.sandbox, self._ctx.canary_host, self._ctx.twin_id, self._ctx.ca_cert_path
            )
        services = self.services()
        if service is not None:
            found = next((s for s in services if s.name == service), None)
            if found is None:
                raise _unknown_service(service, services, self._ctx.twin_id)
            return fetch_receipt_entry(found, self._ctx.http)
        entries = {
            svc.name: fetch_receipt_entry(svc, self._ctx.http)
            for svc in services
            if is_http_url(svc.control_url)
        }
        return Receipt(
            services=entries,
            mode="gateway",
            integrity="verified",
            leaks=_leaks(self._ctx.egress),
        )

    def assert_touched(self, service: str, matcher: TouchMatcher | None = None) -> None:
        """Raise unless the named service saw matching traffic.

        Raises ``VerisError`` (not ``VerisUntouchedError``) for an unknown
        service: a typo is a different failure from a service that saw nothing.
        """
        entry = self.receipt(service)
        assert isinstance(entry, ReceiptEntry)  # receipt(str) always returns one
        need = matcher.min_requests if matcher else 1
        matched = _match(entry, matcher)
        if matched < need:
            raise _untouched(service, matcher, matched, need, self._ctx.twin_id)

    def get_data_plane_env(self) -> dict[str, str]:
        """``{env_hint: dsn}`` for the twin's non-HTTP services."""
        return data_plane_env(self.services())

    def get_trust_env(self) -> dict[str, str]:
        """CA trust variables, for processes that scrub the environment."""
        return self._ctx.trust_env or vendored_trust_env()

    def update_network(self, network: Mapping[str, Any], *, detach_veris: bool = False) -> None:
        """Network update that re-asserts the egress proxy and allowlist.

        A raw ``update_network`` clears omitted fields, which would drop the
        proxy and silently un-intercept the sandbox. This narrows that footgun
        for the path we control; the canary probe stays the load-bearing
        detection.
        """
        rest = dict(network)
        if detach_veris:
            self._ctx.sandbox.update_network(rest)
            return
        credential = self._ctx.control_plane.mint_egress_credential(  # type: ignore[union-attr]
            self._ctx.environment_id, self._ctx.twin_id
        )
        if credential is None:
            # Gateway mode was active at create but the endpoint is gone now —
            # do the raw update rather than pretend we re-asserted.
            self._ctx.sandbox.update_network(rest)
            return
        base = build_network(
            credential=credential,
            services=self.services(),
            mode=self._ctx.egress,
            allow_out=[*self._ctx.allow_out, *caller_static_allow_out(rest)],
        )
        self._ctx.sandbox.update_network({**rest, **base})

    def deliver_to(self, target: int | str | None, *, probe: bool = True) -> str | None:
        """Point every mocked vendor's callbacks at this sandbox.

        Pass a PORT your app listens on and it resolves the sandbox's own public
        URL — the address a vendor would POST to in production. Pass a full URL
        to use that instead, or ``None`` to unregister. One call covers every
        service: a sandbox has one client, and the control plane fans it out.

        The sandbox must accept public traffic for the twin to reach it.
        """
        url = f"https://{self._ctx.sandbox.get_host(target)}" if isinstance(target, int) else target
        self._ctx.control_plane.update_sandbox(  # type: ignore[union-attr]
            self._ctx.environment_id, self._ctx.twin_id, {"client_base_url": url}
        )
        if url is not None and probe:
            self._probe_delivery(url)
        return url

    def _probe_delivery(self, url: str) -> None:
        services = [s for s in self.services() if is_http_url(s.control_url)]
        if not services:
            return
        client = self._ctx.http or httpx.Client(timeout=PROBE_TIMEOUT_S)
        answers: list[Any] = []
        try:
            for svc in services:
                try:
                    response = client.post(
                        f"{svc.control_url}/veris/client/probe", timeout=PROBE_TIMEOUT_S
                    )
                    answers.append(response.json() if response.status_code < 300 else None)
                except (httpx.HTTPError, ValueError):
                    answers.append(None)
        finally:
            if self._ctx.http is None:
                client.close()
        if not any(isinstance(a, Mapping) and a.get("answered") for a in answers):
            raise VerisError(
                f"no service could reach {url} — is your app listening, and was the sandbox "
                f"created with allow_public_traffic: True?",
                phase="receipt",
                veris_sandbox_id=self._ctx.twin_id,
                response_body=answers,
            )


class AsyncVerisApi:
    """``sbx.veris`` on a non-blocking sandbox. Same contract as :class:`VerisApi`."""

    def __init__(self, ctx: VerisContext) -> None:
        self._ctx = ctx

    @property
    def sandbox_id(self) -> str:
        return self._ctx.twin_id

    @property
    def mode(self) -> str:
        return self._ctx.mode

    async def services(self) -> list[ServiceInfo]:
        return await self._ctx.control_plane.services(self._ctx.twin_id)  # type: ignore[union-attr]

    async def receipt(self, service: str | None = None) -> Receipt | ReceiptEntry:
        if self._ctx.canary_host:
            await probe_canary_async(
                self._ctx.sandbox, self._ctx.canary_host, self._ctx.twin_id, self._ctx.ca_cert_path
            )
        services = await self.services()
        if service is not None:
            found = next((s for s in services if s.name == service), None)
            if found is None:
                raise _unknown_service(service, services, self._ctx.twin_id)
            return await fetch_receipt_entry_async(found, self._ctx.http)
        http_services = [svc for svc in services if is_http_url(svc.control_url)]
        fetched = await asyncio.gather(
            *(fetch_receipt_entry_async(svc, self._ctx.http) for svc in http_services)
        )
        return Receipt(
            services={svc.name: entry for svc, entry in zip(http_services, fetched, strict=True)},
            mode="gateway",
            integrity="verified",
            leaks=_leaks(self._ctx.egress),
        )

    async def assert_touched(self, service: str, matcher: TouchMatcher | None = None) -> None:
        entry = await self.receipt(service)
        assert isinstance(entry, ReceiptEntry)
        need = matcher.min_requests if matcher else 1
        matched = _match(entry, matcher)
        if matched < need:
            raise _untouched(service, matcher, matched, need, self._ctx.twin_id)

    async def get_data_plane_env(self) -> dict[str, str]:
        return data_plane_env(await self.services())

    async def get_trust_env(self) -> dict[str, str]:
        return self._ctx.trust_env or vendored_trust_env()

    async def update_network(
        self, network: Mapping[str, Any], *, detach_veris: bool = False
    ) -> None:
        rest = dict(network)
        if detach_veris:
            await self._ctx.sandbox.update_network(rest)
            return
        credential = await self._ctx.control_plane.mint_egress_credential(  # type: ignore[union-attr]
            self._ctx.environment_id, self._ctx.twin_id
        )
        if credential is None:
            await self._ctx.sandbox.update_network(rest)
            return
        base = build_network(
            credential=credential,
            services=await self.services(),
            mode=self._ctx.egress,
            allow_out=[*self._ctx.allow_out, *caller_static_allow_out(rest)],
        )
        await self._ctx.sandbox.update_network({**rest, **base})

    async def deliver_to(self, target: int | str | None, *, probe: bool = True) -> str | None:
        url = f"https://{self._ctx.sandbox.get_host(target)}" if isinstance(target, int) else target
        await self._ctx.control_plane.update_sandbox(  # type: ignore[union-attr]
            self._ctx.environment_id, self._ctx.twin_id, {"client_base_url": url}
        )
        if url is not None and probe:
            await self._probe_delivery(url)
        return url

    async def _probe_delivery(self, url: str) -> None:
        services = [s for s in await self.services() if is_http_url(s.control_url)]
        if not services:
            return

        async def ask(svc: ServiceInfo, client: httpx.AsyncClient) -> Any:
            try:
                response = await client.post(f"{svc.control_url}/veris/client/probe")
                return response.json() if response.status_code < 300 else None
            except (httpx.HTTPError, ValueError):
                return None

        if self._ctx.http is not None:
            answers = await asyncio.gather(*(ask(svc, self._ctx.http) for svc in services))
        else:
            async with httpx.AsyncClient(timeout=PROBE_TIMEOUT_S) as client:
                answers = await asyncio.gather(*(ask(svc, client) for svc in services))
        if not any(isinstance(a, Mapping) and a.get("answered") for a in answers):
            raise VerisError(
                f"no service could reach {url} — is your app listening, and was the sandbox "
                f"created with allow_public_traffic: True?",
                phase="receipt",
                veris_sandbox_id=self._ctx.twin_id,
                response_body=answers,
            )
