"""The control-plane client: what it sends, and how it reads each answer."""

from __future__ import annotations

import json

import httpx
import pytest

from veris_e2b.control_plane import ServiceInfo, TwinSandbox
from veris_e2b.errors import TwinExpiredError, VerisError, VerisGatewayNotOfferedError

READY_TWIN = {"id": "sb_1", "environment_id": "env_1", "status": "ready", "services": []}


def json_response(status: int, body: object | None = None) -> httpx.Response:
    return httpx.Response(status, json=body) if body is not None else httpx.Response(status)


class TestCreateTwin:
    def test_sends_snapshot_id_when_named(self, control_plane):
        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen.update(json.loads(request.content))
            return json_response(201, READY_TWIN)

        control_plane(handler).create_twin("env_1", ttl_minutes=20, snapshot_id="snap_1")
        assert seen == {"ttl_minutes": 20, "snapshot_id": "snap_1"}

    def test_omits_snapshot_id_for_a_baseline_boot(self, control_plane):
        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen.update(json.loads(request.content))
            return json_response(201, READY_TWIN)

        control_plane(handler).create_twin("env_1", ttl_minutes=20)
        assert "snapshot_id" not in seen

    def test_names_the_snapshot_when_the_control_plane_refuses_it(self, control_plane):
        def handler(_r: httpx.Request) -> httpx.Response:
            return json_response(422, {"detail": "snapshot of another environment"})

        with pytest.raises(VerisError, match="snap_other"):
            control_plane(handler).create_twin("env_1", snapshot_id="snap_other")

    def test_sends_the_sdk_version_header(self, control_plane):
        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen.update(request.headers)
            return json_response(201, READY_TWIN)

        control_plane(handler).create_twin("env_1")
        assert seen["x-api-key"] == "k"
        assert seen["x-veris-sdk"] == "9.9.9"


class TestGatewayCredential:
    def test_absent_route_returns_none(self, control_plane):
        """404 = a control plane with no gateway at all, not a failure."""
        assert (
            control_plane(lambda _r: json_response(404)).mint_egress_credential("env_1", "sb_1")
            is None
        )

    def test_version_refusal_raises_with_min_sdk(self, control_plane):
        def handler(_r: httpx.Request) -> httpx.Response:
            return json_response(409, {"min_sdk": "2.1.0"})

        with pytest.raises(VerisGatewayNotOfferedError) as excinfo:
            control_plane(handler).mint_egress_credential("env_1", "sb_1")
        assert excinfo.value.min_sdk == "2.1.0"

    def test_parses_the_credential(self, control_plane):
        body = {
            "socks_address": "gw:1080",
            "username": "u",
            "password": "p",
            "ca_pem": "PEM",
            "canary_host": "canary.veris",
        }
        credential = control_plane(lambda _r: json_response(200, body)).mint_egress_credential(
            "env_1", "sb_1"
        )
        assert credential is not None
        assert credential.socks_address == "gw:1080"
        assert credential.canary_host == "canary.veris"


class TestReadiness:
    def test_returns_a_ready_twin_immediately(self, control_plane):
        twin = control_plane(lambda _r: json_response(200, READY_TWIN)).wait_ready("sb_1")
        assert twin.status == "ready"

    def test_a_failed_twin_is_terminal_and_carries_the_reason(self, control_plane):
        body = {**READY_TWIN, "status": "failed", "failure_reason": "no capacity"}
        with pytest.raises(VerisError, match="no capacity"):
            control_plane(lambda _r: json_response(200, body)).wait_ready("sb_1")

    def test_a_vanished_twin_raises_twin_expired(self, control_plane):
        with pytest.raises(TwinExpiredError):
            control_plane(lambda _r: json_response(404)).wait_ready("sb_1")

    def test_a_still_provisioning_twin_gives_up_at_the_deadline(self, control_plane):
        body = {**READY_TWIN, "status": "provisioning"}
        with pytest.raises(VerisError, match="provisioning"):
            control_plane(lambda _r: json_response(200, body)).wait_ready("sb_1", timeout_s=-1)


class TestTolerance:
    def test_extend_ttl_swallows_a_405(self, control_plane):
        """A control plane that predates TTL-extend must not fail set_timeout."""
        control_plane(lambda _r: json_response(405)).extend_ttl("env_1", "sb_1", 20)

    def test_a_success_with_no_body_is_a_legible_error(self, control_plane):
        with pytest.raises(VerisError, match="empty response body"):
            control_plane(lambda _r: httpx.Response(200, text="")).get_twin("sb_1")

    def test_a_transport_failure_names_the_route(self, control_plane):
        def handler(_r: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("boom")

        with pytest.raises(VerisError, match="control plane unreachable"):
            control_plane(handler).get_twin("sb_1")


class TestShapes:
    def test_unknown_fields_are_ignored_so_the_server_can_grow(self):
        twin = TwinSandbox.from_dict({**READY_TWIN, "some_new_field": 1})
        assert twin.id == "sb_1"

    def test_routes_are_parsed_into_entries(self):
        svc = ServiceInfo.from_dict(
            {
                "name": "stripe",
                "status": "ready",
                "url": "https://gw/stripe",
                "control_url": "https://gw/stripe",
                "routes": [{"host": "api.stripe.com", "paths": ["/v1"]}],
            }
        )
        assert svc.routes is not None
        assert svc.routes[0].host == "api.stripe.com"


@pytest.mark.asyncio
class TestAsyncParity:
    async def test_async_client_sends_the_same_create_body(self, async_control_plane):
        seen: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen.update(json.loads(request.content))
            return json_response(201, READY_TWIN)

        await async_control_plane(handler).create_twin("env_1", snapshot_id="snap_1")
        assert seen == {"snapshot_id": "snap_1"}

    async def test_async_readiness_agrees_with_sync(self, async_control_plane):
        twin = await async_control_plane(lambda _r: json_response(200, READY_TWIN)).wait_ready(
            "sb_1"
        )
        assert twin.status == "ready"
