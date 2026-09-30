"""The keyed control URL: the Veris API key goes to each service's ``control_url``
and nowhere else, and a refused key says which credential it was.

Split sandboxes serve the data plane on ``/s/<sandbox>/<svc>`` (where ``/veris/*``
now answers the vendor's 404) and the control plane on ``/c/<sandbox>/<svc>``,
which requires ``X-API-Key``. The fake twin below enforces exactly that, so a
call that goes to the wrong place or without the key fails here the way it
would against the real thing.
"""

from __future__ import annotations

import json

import httpx
import pytest

from veris_e2b import VerisControlAuthError
from veris_e2b.control_auth import control_headers, is_control_request
from veris_e2b.control_plane import ServiceInfo
from veris_e2b.veris_api import AsyncVerisApi, VerisApi, VerisContext

KEY = "k"  # what conftest's control planes authenticate with
TWIN = "sb_1"
HOST = "svc.dev.api.veris.ai"
DATA = f"https://{HOST}/s/{TWIN}/stripe"
CONTROL = f"https://{HOST}/c/{TWIN}/stripe"

SPLIT_SERVICES = [
    {
        "name": "stripe",
        "status": "ready",
        "url": DATA,
        "control_url": CONTROL,
        "control_auth": "api_key",
        "routes": [{"host": "api.stripe.com"}],
    }
]


class SplitTwin:
    """A split twin: keyed /c/ control plane, vendor-only /s/ data plane."""

    def __init__(self, *, accept_key: str = KEY, redirect_control: bool = False) -> None:
        self.accept_key = accept_key
        self.redirect_control = redirect_control
        self.seen: list[httpx.Request] = []
        self.rows: list[dict] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        path = request.url.path
        if request.url.host == "svc.api.veris.ai":  # the /v1 API
            if path.endswith("/services"):
                return httpx.Response(200, json=SPLIT_SERVICES)
            return httpx.Response(200, json={"ok": True})
        if request.url.host != HOST:
            return httpx.Response(200, json={"leaked": True})
        if path.startswith(f"/s/{TWIN}/"):
            return httpx.Response(404, json={"error": "vendor 404"})
        if not path.startswith(f"/c/{TWIN}/"):
            return httpx.Response(404)
        if request.headers.get("x-api-key") != self.accept_key:
            return httpx.Response(401, json={"detail": "invalid or missing API key"})
        if self.redirect_control:
            return httpx.Response(307, headers={"location": "https://elsewhere.example/steal"})
        if path.endswith("/veris/requests"):
            since = int(request.url.params.get("since_id", 0))
            rows = [r for r in self.rows if r["id"] > since]
            if request.url.params.get("order") == "desc":
                rows = list(reversed(self.rows))
            return httpx.Response(
                200, json={"requests": rows[: int(request.url.params.get("limit", 50))]}
            )
        if path.endswith("/veris/schema"):
            marker = request.headers.get("x-veris-receipt-baseline")
            if marker:
                self.rows.append(
                    {
                        "id": len(self.rows) + 1,
                        "method": "GET",
                        "path": "/veris/schema",
                        "status": 200,
                        "tier": "control",
                        "request_headers": json.dumps({"x-veris-receipt-baseline": marker}),
                    }
                )
            return httpx.Response(200, json={"tables": {}})
        if path.endswith("/veris/client/probe"):
            return httpx.Response(200, json={"answered": True})
        return httpx.Response(200, json={"ok": True})

    def twin_requests(self) -> list[httpx.Request]:
        return [r for r in self.seen if r.url.host != "svc.api.veris.ai"]


def _ctx(control_plane, fake_sandbox, twin: SplitTwin, *, http) -> VerisContext:
    return VerisContext(
        sandbox=fake_sandbox({"canary.veris": (json.dumps({"veris_sandbox_id": TWIN}), "")}),
        control_plane=control_plane(twin.handler),
        environment_id="env_1",
        twin_id=TWIN,
        egress="strict",
        allow_out=[],
        owns_twin=True,
        canary_host="canary.veris",
        http=http,
    )


@pytest.fixture
def split(control_plane, fake_sandbox):
    def build(**kwargs) -> tuple[VerisApi, SplitTwin]:
        twin = SplitTwin(**kwargs)
        http = httpx.Client(transport=httpx.MockTransport(twin.handler))
        return VerisApi(_ctx(control_plane, fake_sandbox, twin, http=http)), twin

    return build


def _exercise(veris: VerisApi) -> None:
    """Every control call the SDK makes."""
    veris.receipt()
    veris.receipt("stripe")
    baseline = veris.receipt_baseline()
    veris.receipt_since(baseline)
    for resource in ("manual", "schema", "operations", "data", "requests"):
        veris.control("stripe", resource)
    veris.control("stripe", "data", method="POST", body={"rows": []})
    veris.deliver_to(3000)


class TestTheKeyGoesToTheControlUrl:
    def test_every_control_call_sends_the_key_to_the_control_url(self, split):
        veris, twin = split()
        _exercise(veris)
        calls = twin.twin_requests()
        paths = {r.url.path.rsplit("/veris/", 1)[-1] for r in calls}
        assert {"requests", "schema", "manual", "operations", "data", "client/probe"} <= paths
        for request in calls:
            assert str(request.url).startswith(f"{CONTROL}/veris/"), request.url
            assert request.headers.get("x-api-key") == KEY, request.url

    def test_nothing_is_sent_to_the_data_url_or_a_vendor_host(self, split):
        veris, twin = split()
        _exercise(veris)
        assert not [r for r in twin.seen if r.url.path.startswith(f"/s/{TWIN}/")]
        assert not [r for r in twin.seen if r.url.host == "api.stripe.com"]

    def test_a_redirect_is_not_followed_even_by_a_client_that_follows(
        self, control_plane, fake_sandbox
    ):
        twin = SplitTwin(redirect_control=True)
        http = httpx.Client(transport=httpx.MockTransport(twin.handler), follow_redirects=True)
        veris = VerisApi(_ctx(control_plane, fake_sandbox, twin, http=http))
        with pytest.raises(Exception):  # noqa: B017 - any failure; the point is where it went
            veris.control("stripe", "manual")
        assert not [r for r in twin.seen if r.url.host == "elsewhere.example"]

    @pytest.mark.asyncio
    async def test_the_async_surface_sends_it_too(self, async_control_plane, fake_sandbox):
        twin = SplitTwin()
        http = httpx.AsyncClient(transport=httpx.MockTransport(twin.handler))
        sandbox = fake_sandbox({"canary.veris": (json.dumps({"veris_sandbox_id": TWIN}), "")})

        class AsyncSandboxStub:
            sandbox_id = sandbox.sandbox_id

            class commands:  # noqa: N801 - mirrors e2b's attribute name
                @staticmethod
                async def run(cmd: str, **kwargs):
                    return sandbox.commands.run(cmd, **kwargs)

            @staticmethod
            def get_host(port: int) -> str:
                return sandbox.get_host(port)

        veris = AsyncVerisApi(
            VerisContext(
                sandbox=AsyncSandboxStub(),
                control_plane=async_control_plane(twin.handler),
                environment_id="env_1",
                twin_id=TWIN,
                egress="strict",
                allow_out=[],
                owns_twin=True,
                canary_host="canary.veris",
                http=http,
            )
        )
        await veris.receipt()
        baseline = await veris.receipt_baseline()
        await veris.receipt_since(baseline)
        await veris.control("stripe", "manual")
        await veris.deliver_to(3000)
        calls = twin.twin_requests()
        assert calls
        for request in calls:
            assert str(request.url).startswith(f"{CONTROL}/veris/")
            assert request.headers.get("x-api-key") == KEY


class TestScoping:
    SVC = ServiceInfo(name="stripe", status="ready", url=DATA, control_url=CONTROL)

    @pytest.mark.parametrize(
        "url",
        [
            DATA + "/veris/requests",  # same host, data plane
            "https://api.stripe.com/c/sb_1/stripe/veris/requests",  # vendor host
            f"http://{HOST}/c/{TWIN}/stripe/veris/requests",  # downgraded scheme
            f"https://{HOST}:8443/c/{TWIN}/stripe/veris/requests",  # other port
            f"https://{HOST}/c/{TWIN}/stripe-evil/veris/requests",  # prefix, not a path
            f"https://{HOST}.evil.example/c/{TWIN}/stripe/veris/requests",
        ],
    )
    def test_the_key_is_withheld_from_anything_but_the_control_url(self, url):
        assert not is_control_request(url, CONTROL)
        assert "X-API-Key" not in control_headers(self.SVC, url, KEY)

    def test_it_is_attached_under_the_control_url(self):
        url = f"{CONTROL}/veris/requests"
        assert control_headers(self.SVC, url, KEY, {"A": "b"}) == {"A": "b", "X-API-Key": KEY}

    def test_no_key_no_header(self):
        assert control_headers(self.SVC, f"{CONTROL}/veris/requests", None) == {}


class TestRefusedKey:
    @pytest.mark.parametrize(
        "call",
        [
            lambda v: v.control("stripe", "manual"),
            lambda v: v.receipt("stripe"),
            lambda v: v.receipt_baseline(),
            lambda v: v.deliver_to(3000),
        ],
        ids=["control", "receipt", "baseline", "deliver_to-probe"],
    )
    def test_a_401_names_the_credential(self, split, call):
        veris, _twin = split(accept_key="someone-elses-key")
        with pytest.raises(VerisControlAuthError) as excinfo:
            call(veris)
        message = str(excinfo.value)
        assert "Veris API key" in message
        assert "VERIS_API_KEY" in message
        assert "401" in message
        assert excinfo.value.service == "stripe"


class TestModel:
    def test_control_auth_is_parsed(self):
        assert ServiceInfo.from_dict(SPLIT_SERVICES[0]).control_auth == "api_key"

    def test_control_auth_is_optional_and_nullable(self):
        legacy = {"name": "s", "status": "ready", "url": DATA, "control_url": DATA}
        assert ServiceInfo.from_dict(legacy).control_auth is None
        assert ServiceInfo.from_dict({**legacy, "control_auth": None}).control_auth is None

    def test_a_legacy_keyless_control_url_still_gets_the_key(self):
        """control_auth: null means /veris/* still lives on the /s/ URL; the key
        there is harmless, and not sending it would break the day it flips."""
        legacy = ServiceInfo(name="s", status="ready", url=DATA, control_url=DATA)
        assert control_headers(legacy, f"{DATA}/veris/requests", KEY) == {"X-API-Key": KEY}
