"""Typed client for the Veris control plane (svc.api.veris.ai).

Only the routes the SDK needs; shapes mirror the platform's public models and
ignore unknown fields so the control plane can grow without breaking us. Sync
and async clients share every pure part — request shaping, response parsing,
readiness logic — so a contract change lands in one place.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

import httpx

from .errors import (
    TwinExpiredError,
    VerisError,
    VerisGatewayNotOfferedError,
    VerisGatewayUnreachableError,
)

#: Every control-plane call is bounded; a hung twin must not hang a caller.
REQUEST_TIMEOUT_S = 30.0
#: How long ``wait_ready`` polls before giving up, and how often it asks.
READY_TIMEOUT_S = 240.0
POLL_INTERVAL_S = 1.5

DEFAULT_API_BASE = "https://svc.api.veris.ai"


@dataclass(frozen=True)
class RouteEntry:
    """A real vendor hostname a service answers for; paths narrow the claim when
    several services share the host."""

    host: str
    paths: list[str] | None = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> RouteEntry:
        return cls(host=str(data.get("host", "")), paths=data.get("paths"))


@dataclass(frozen=True)
class ServiceInfo:
    """One twinned service as the control plane reports it."""

    name: str
    status: str
    #: What the code under test points at: a gateway URL for http services, a DSN
    #: for e.g. postgres.
    url: str
    #: Where ``/veris/*`` lives — always an http URL.
    control_url: str
    env_hint: str | None = None
    routes: list[RouteEntry] | None = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> ServiceInfo:
        raw_routes = data.get("routes")
        return cls(
            name=str(data.get("name", "")),
            status=str(data.get("status", "")),
            url=str(data.get("url", "")),
            control_url=str(data.get("control_url", "")),
            env_hint=data.get("env_hint"),
            routes=[RouteEntry.from_dict(r) for r in raw_routes] if raw_routes else None,
        )


@dataclass(frozen=True)
class TwinSandbox:
    """A Veris dependency sandbox — the "twin" one E2B sandbox talks to."""

    id: str
    environment_id: str
    status: str
    services: list[ServiceInfo] = field(default_factory=list)
    failure_reason: str | None = None
    snapshot_id: str | None = None
    created_at: str | None = None
    expires_at: str | None = None
    metadata: dict[str, str] | None = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> TwinSandbox:
        return cls(
            id=str(data.get("id", "")),
            environment_id=str(data.get("environment_id", "")),
            status=str(data.get("status", "")),
            services=[ServiceInfo.from_dict(s) for s in data.get("services") or []],
            failure_reason=data.get("failure_reason"),
            snapshot_id=data.get("snapshot_id"),
            created_at=data.get("created_at"),
            expires_at=data.get("expires_at"),
            metadata=data.get("metadata"),
        )


@dataclass(frozen=True)
class EgressCredential:
    """Response of ``POST /v1/.../egress-credential`` — gateway mode's whole wiring."""

    socks_address: str
    username: str
    password: str
    ca_pem: str
    canary_host: str
    min_sdk: str | None = None
    expires_at: str | None = None
    #: Server-served CA trust env map; the SDK's vendored list is the fallback.
    trust_env: dict[str, str] | None = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> EgressCredential:
        return cls(
            socks_address=str(data.get("socks_address", "")),
            username=str(data.get("username", "")),
            password=str(data.get("password", "")),
            ca_pem=str(data.get("ca_pem", "")),
            canary_host=str(data.get("canary_host", "")),
            min_sdk=data.get("min_sdk"),
            expires_at=data.get("expires_at"),
            trust_env=data.get("trust_env"),
        )


class _ControlPlaneShared:
    """Everything both clients do that is not the IO itself."""

    def __init__(self, *, api_key: str, api_base: str, sdk_version: str) -> None:
        self.api_base = api_base.rstrip("/")
        self._headers = {
            "X-API-Key": api_key,
            "X-Veris-SDK": sdk_version,
            "Content-Type": "application/json",
        }

    # -- request shaping ---------------------------------------------------

    @staticmethod
    def _create_body(
        ttl_minutes: int | None, metadata: Mapping[str, str] | None, snapshot_id: str | None
    ) -> dict[str, Any]:
        """The create-sandbox body. Omitted keys are omitted, not sent as null:
        an explicit ``snapshot_id: null`` reads differently to some servers than
        no snapshot at all."""
        body: dict[str, Any] = {}
        if ttl_minutes is not None:
            body["ttl_minutes"] = ttl_minutes
        if metadata is not None:
            body["metadata"] = dict(metadata)
        if snapshot_id is not None:
            body["snapshot_id"] = snapshot_id
        return body

    @staticmethod
    def _create_context(environment_id: str, snapshot_id: str | None) -> str:
        # Name the snapshot in the failure text: "environment env_1" alone reads
        # as a broken environment when the fault is a snapshot of another one.
        suffix = f" from snapshot {snapshot_id}" if snapshot_id else ""
        return f"create sandbox in environment {environment_id}{suffix}"

    # -- response parsing --------------------------------------------------

    @staticmethod
    def _decode(response: httpx.Response, context: str, phase: str | None = None) -> Any:
        text = response.text
        try:
            parsed: Any = response.json() if text else None
        except ValueError:
            parsed = text
        if response.status_code >= 300:
            raise VerisError(
                f"{context}: {response.status_code}", phase=phase, response_body=parsed
            )
        # A success with no body would surface downstream as an opaque attribute
        # error — turn it into a legible failure here.
        if parsed is None:
            raise VerisError(f"{context}: empty response body", phase=phase, response_body=text)
        return parsed

    @staticmethod
    def _ready_verdict(
        twin: TwinSandbox | None, sandbox_id: str, expired: bool
    ) -> TwinSandbox | None:
        """One poll's verdict: the twin when ready, None to keep waiting, or raise."""
        if twin is None:
            raise TwinExpiredError(
                f"Veris sandbox {sandbox_id} disappeared while provisioning",
                veris_sandbox_id=sandbox_id,
            )
        if twin.status == "ready":
            return twin
        if twin.status == "failed":
            raise VerisError(
                f"Veris sandbox {sandbox_id} failed to provision: "
                f"{twin.failure_reason or 'no failure_reason'}",
                phase="twin-provision",
                veris_sandbox_id=sandbox_id,
            )
        if expired:
            raise VerisError(
                f"Veris sandbox {sandbox_id} not ready after the readiness budget "
                f"(status: {twin.status})",
                phase="twin-provision",
                veris_sandbox_id=sandbox_id,
            )
        return None

    @staticmethod
    def _mint_verdict(response: httpx.Response, sandbox_id: str) -> EgressCredential | None:
        """404 = the control plane has no gateway route at all, so ``auto`` may
        fall back; 409 = an explicit version refusal, which never falls back."""
        if response.status_code == 404:
            return None
        if response.status_code == 409:
            try:
                body = response.json()
            except ValueError:
                body = {}
            min_sdk = body.get("min_sdk") if isinstance(body, dict) else None
            suffix = f" (min_sdk {min_sdk})" if min_sdk else ""
            raise VerisGatewayNotOfferedError(
                f"this SDK version is below the control plane's minimum for gateway mode"
                f"{suffix} — upgrade veris-e2b",
                min_sdk=min_sdk,
                phase="credential-mint",
                veris_sandbox_id=sandbox_id,
                response_body=body,
            )
        return EgressCredential.from_dict(
            _ControlPlaneShared._decode(
                response, f"mint egress credential for {sandbox_id}", "credential-mint"
            )
        )

    @staticmethod
    def _health_verdict(response: httpx.Response) -> None:
        if response.status_code == 404:
            return  # control plane predates gateway mode; the credential probe decides
        if response.status_code >= 300:
            raise VerisGatewayUnreachableError(
                f"Veris gateway reported unhealthy ({response.status_code})",
                phase="gateway-preflight",
            )


class ControlPlane(_ControlPlaneShared):
    """Blocking control-plane client."""

    def __init__(
        self, *, api_key: str, api_base: str, sdk_version: str, client: httpx.Client | None = None
    ) -> None:
        super().__init__(api_key=api_key, api_base=api_base, sdk_version=sdk_version)
        self._client = client or httpx.Client(timeout=REQUEST_TIMEOUT_S)
        self._owns_client = client is None

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def _request(self, method: str, path: str, body: Any = None) -> httpx.Response:
        try:
            return self._client.request(
                method, f"{self.api_base}{path}", headers=self._headers, json=body
            )
        except httpx.HTTPError as cause:
            raise VerisError(f"Veris control plane unreachable ({method} {path})") from cause

    def create_twin(
        self,
        environment_id: str,
        *,
        ttl_minutes: int | None = None,
        metadata: Mapping[str, str] | None = None,
        snapshot_id: str | None = None,
    ) -> TwinSandbox:
        """Provision a twin. ``snapshot_id`` boots it from one of the environment's
        snapshots instead of its baseline; the control plane refuses a snapshot
        belonging to a different environment."""
        response = self._request(
            "POST",
            f"/v1/environments/{environment_id}/sandboxes",
            self._create_body(ttl_minutes, metadata, snapshot_id),
        )
        return TwinSandbox.from_dict(
            self._decode(
                response, self._create_context(environment_id, snapshot_id), "twin-provision"
            )
        )

    def get_twin(self, sandbox_id: str) -> TwinSandbox | None:
        response = self._request("GET", f"/v1/sandboxes/{sandbox_id}")
        if response.status_code == 404:
            return None
        return TwinSandbox.from_dict(self._decode(response, f"get sandbox {sandbox_id}"))

    def wait_ready(self, sandbox_id: str, timeout_s: float = READY_TIMEOUT_S) -> TwinSandbox:
        """Poll until the twin reports ready. ``failed`` is terminal per the API docs."""
        deadline = time.monotonic() + timeout_s
        while True:
            twin = self.get_twin(sandbox_id)
            verdict = self._ready_verdict(twin, sandbox_id, time.monotonic() > deadline)
            if verdict is not None:
                return verdict
            time.sleep(POLL_INTERVAL_S)

    def services(self, sandbox_id: str) -> list[ServiceInfo]:
        response = self._request("GET", f"/v1/sandboxes/{sandbox_id}/services")
        if response.status_code == 404:
            raise TwinExpiredError(
                f"Veris sandbox {sandbox_id} not found — expired or deleted",
                veris_sandbox_id=sandbox_id,
            )
        rows = self._decode(response, f"services of sandbox {sandbox_id}", "receipt")
        return [ServiceInfo.from_dict(row) for row in rows]

    def delete_twin(self, environment_id: str, sandbox_id: str) -> bool:
        response = self._request(
            "DELETE", f"/v1/environments/{environment_id}/sandboxes/{sandbox_id}"
        )
        if response.status_code == 404:
            return False
        if response.status_code >= 300:
            self._decode(response, f"delete sandbox {sandbox_id}")
        return True

    def mint_egress_credential(
        self, environment_id: str, sandbox_id: str
    ) -> EgressCredential | None:
        """Mint (or re-mint) the gateway egress credential for a twin."""
        response = self._request(
            "POST", f"/v1/environments/{environment_id}/sandboxes/{sandbox_id}/egress-credential"
        )
        return self._mint_verdict(response, sandbox_id)

    def update_sandbox(
        self, environment_id: str, sandbox_id: str, patch: Mapping[str, Any]
    ) -> None:
        """PATCH the twin resource. Omitted fields are untouched by the server; an
        explicit ``client_base_url: None`` unregisters."""
        response = self._request(
            "PATCH", f"/v1/environments/{environment_id}/sandboxes/{sandbox_id}", dict(patch)
        )
        if response.status_code == 404:
            raise TwinExpiredError(
                f"Veris sandbox {sandbox_id} not found", veris_sandbox_id=sandbox_id
            )
        if response.status_code >= 300:
            self._decode(response, f"update sandbox {sandbox_id}")

    def extend_ttl(self, environment_id: str, sandbox_id: str, ttl_minutes: int) -> None:
        """Extend a twin's TTL so it stays in lockstep with an extended E2B sandbox."""
        response = self._request(
            "PATCH",
            f"/v1/environments/{environment_id}/sandboxes/{sandbox_id}",
            {"ttl_minutes": ttl_minutes},
        )
        if response.status_code == 404:
            raise TwinExpiredError(
                f"Veris sandbox {sandbox_id} not found — cannot extend TTL",
                veris_sandbox_id=sandbox_id,
            )
        # 405 = a control plane that does not accept this field yet: tolerated,
        # the original TTL keeps its backstop role and kill() still cleans up.
        if response.status_code >= 300 and response.status_code != 405:
            self._decode(response, f"extend TTL of {sandbox_id}")

    def gateway_health(self) -> None:
        """Create-time preflight: is the gateway infrastructure up, per the control plane?"""
        self._health_verdict(self._request("GET", "/v1/gateway/health"))


class AsyncControlPlane(_ControlPlaneShared):
    """Non-blocking control-plane client. Same contract as :class:`ControlPlane`."""

    def __init__(
        self,
        *,
        api_key: str,
        api_base: str,
        sdk_version: str,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        super().__init__(api_key=api_key, api_base=api_base, sdk_version=sdk_version)
        self._client = client or httpx.AsyncClient(timeout=REQUEST_TIMEOUT_S)
        self._owns_client = client is None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _request(self, method: str, path: str, body: Any = None) -> httpx.Response:
        try:
            return await self._client.request(
                method, f"{self.api_base}{path}", headers=self._headers, json=body
            )
        except httpx.HTTPError as cause:
            raise VerisError(f"Veris control plane unreachable ({method} {path})") from cause

    async def create_twin(
        self,
        environment_id: str,
        *,
        ttl_minutes: int | None = None,
        metadata: Mapping[str, str] | None = None,
        snapshot_id: str | None = None,
    ) -> TwinSandbox:
        response = await self._request(
            "POST",
            f"/v1/environments/{environment_id}/sandboxes",
            self._create_body(ttl_minutes, metadata, snapshot_id),
        )
        return TwinSandbox.from_dict(
            self._decode(
                response, self._create_context(environment_id, snapshot_id), "twin-provision"
            )
        )

    async def get_twin(self, sandbox_id: str) -> TwinSandbox | None:
        response = await self._request("GET", f"/v1/sandboxes/{sandbox_id}")
        if response.status_code == 404:
            return None
        return TwinSandbox.from_dict(self._decode(response, f"get sandbox {sandbox_id}"))

    async def wait_ready(self, sandbox_id: str, timeout_s: float = READY_TIMEOUT_S) -> TwinSandbox:
        deadline = time.monotonic() + timeout_s
        while True:
            twin = await self.get_twin(sandbox_id)
            verdict = self._ready_verdict(twin, sandbox_id, time.monotonic() > deadline)
            if verdict is not None:
                return verdict
            await asyncio.sleep(POLL_INTERVAL_S)

    async def services(self, sandbox_id: str) -> list[ServiceInfo]:
        response = await self._request("GET", f"/v1/sandboxes/{sandbox_id}/services")
        if response.status_code == 404:
            raise TwinExpiredError(
                f"Veris sandbox {sandbox_id} not found — expired or deleted",
                veris_sandbox_id=sandbox_id,
            )
        rows = self._decode(response, f"services of sandbox {sandbox_id}", "receipt")
        return [ServiceInfo.from_dict(row) for row in rows]

    async def delete_twin(self, environment_id: str, sandbox_id: str) -> bool:
        response = await self._request(
            "DELETE", f"/v1/environments/{environment_id}/sandboxes/{sandbox_id}"
        )
        if response.status_code == 404:
            return False
        if response.status_code >= 300:
            self._decode(response, f"delete sandbox {sandbox_id}")
        return True

    async def mint_egress_credential(
        self, environment_id: str, sandbox_id: str
    ) -> EgressCredential | None:
        response = await self._request(
            "POST", f"/v1/environments/{environment_id}/sandboxes/{sandbox_id}/egress-credential"
        )
        return self._mint_verdict(response, sandbox_id)

    async def update_sandbox(
        self, environment_id: str, sandbox_id: str, patch: Mapping[str, Any]
    ) -> None:
        response = await self._request(
            "PATCH", f"/v1/environments/{environment_id}/sandboxes/{sandbox_id}", dict(patch)
        )
        if response.status_code == 404:
            raise TwinExpiredError(
                f"Veris sandbox {sandbox_id} not found", veris_sandbox_id=sandbox_id
            )
        if response.status_code >= 300:
            self._decode(response, f"update sandbox {sandbox_id}")

    async def extend_ttl(self, environment_id: str, sandbox_id: str, ttl_minutes: int) -> None:
        response = await self._request(
            "PATCH",
            f"/v1/environments/{environment_id}/sandboxes/{sandbox_id}",
            {"ttl_minutes": ttl_minutes},
        )
        if response.status_code == 404:
            raise TwinExpiredError(
                f"Veris sandbox {sandbox_id} not found — cannot extend TTL",
                veris_sandbox_id=sandbox_id,
            )
        if response.status_code >= 300 and response.status_code != 405:
            self._decode(response, f"extend TTL of {sandbox_id}")

    async def gateway_health(self) -> None:
        self._health_verdict(await self._request("GET", "/v1/gateway/health"))


AnyControlPlane = ControlPlane | AsyncControlPlane
__all__ = [
    "AsyncControlPlane",
    "ControlPlane",
    "DEFAULT_API_BASE",
    "EgressCredential",
    "RouteEntry",
    "ServiceInfo",
    "TwinSandbox",
]
