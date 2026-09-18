"""The sbx.veris surface: receipts, assertions, safe network updates, delivery."""

from __future__ import annotations

import json

import httpx
import pytest

from veris_e2b.errors import VerisError, VerisUntouchedError
from veris_e2b.receipt import Receipt, ReceiptEntry
from veris_e2b.veris_api import TouchMatcher, VerisApi, VerisContext

TWIN = "sb_1"
CANARY_OK = json.dumps({"veris_sandbox_id": TWIN})

SERVICES = [
    {
        "name": "stripe",
        "status": "ready",
        "url": "https://twin.veris/stripe",
        "control_url": "https://twin.veris/stripe",
        "routes": [{"host": "api.stripe.com"}],
    },
    {
        "name": "pg",
        "status": "ready",
        "url": "postgresql://pg.gw:5432/app",
        "control_url": "https://twin.veris/pg",
        "env_hint": "DATABASE_URL",
    },
]

CREDENTIAL = {
    "socks_address": "gw:1080",
    "username": "u",
    "password": "p",
    "ca_pem": "PEM",
    "canary_host": "canary.veris",
}


def requests_body(rows: list[dict]) -> dict:
    return {"requests": rows}


@pytest.fixture
def api(control_plane, fake_sandbox):
    """A VerisApi over a scripted control plane and twin."""

    def build(
        *,
        stripe_rows: list[dict] | None = None,
        probe_answered: bool = True,
        canary: str = CANARY_OK,
    ):
        def handler(request: httpx.Request) -> httpx.Response:
            path = request.url.path
            if path.endswith("/services"):
                return httpx.Response(200, json=SERVICES)
            if path.endswith("/egress-credential"):
                return httpx.Response(200, json=CREDENTIAL)
            if path.endswith("/veris/requests"):
                rows = stripe_rows if "stripe" in path else []
                return httpx.Response(200, json=requests_body(rows or []))
            if path.endswith("/veris/client/probe"):
                return httpx.Response(200, json={"answered": probe_answered})
            if request.method == "PATCH":
                return httpx.Response(200, json={"ok": True})
            return httpx.Response(404)

        plane = control_plane(handler)
        sandbox = fake_sandbox({"canary.veris": (canary, "")})
        ctx = VerisContext(
            sandbox=sandbox,
            control_plane=plane,
            environment_id="env_1",
            twin_id=TWIN,
            egress="strict",
            allow_out=["npm.example"],
            owns_twin=True,
            canary_host="canary.veris",
            ca_cert_path="/usr/local/share/ca-certificates/veris-ca.crt",
            http=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        return VerisApi(ctx), sandbox

    return build


class TestReceipt:
    def test_counts_what_the_twin_received(self, api):
        veris, _ = api(stripe_rows=[{"method": "POST", "path": "/v1/charges", "status": 200}])
        entry = veris.receipt("stripe")
        assert isinstance(entry, ReceiptEntry)
        assert entry.requests == 1

    def test_the_whole_receipt_skips_non_http_control_planes(self, api):
        veris, _ = api(stripe_rows=[])
        receipt = veris.receipt()
        assert isinstance(receipt, Receipt)
        assert set(receipt.services) == {"stripe", "pg"}

    def test_strict_egress_has_no_known_blind_spots(self, api):
        veris, _ = api()
        receipt = veris.receipt()
        assert receipt.leaks == []
        assert receipt.integrity == "verified"

    def test_the_canary_runs_before_any_count_is_trusted(self, api):
        """A receipt read from an un-tunneled sandbox would lie."""
        veris, sandbox = api()
        veris.receipt()
        assert any("canary.veris" in cmd for cmd in sandbox.commands.ran)

    def test_a_broken_tunnel_fails_the_read_instead_of_returning_zero(self, api):
        veris, _ = api(canary="")
        with pytest.raises(VerisError, match="not tunneled"):
            veris.receipt()

    def test_an_unknown_service_is_a_typo_not_an_untouched_dependency(self, api):
        veris, _ = api()
        with pytest.raises(VerisError) as excinfo:
            veris.receipt("strype")
        assert not isinstance(excinfo.value, VerisUntouchedError)
        assert "available: stripe, pg" in str(excinfo.value)


class TestAssertTouched:
    def test_passes_when_the_service_was_called(self, api):
        veris, _ = api(stripe_rows=[{"method": "POST", "path": "/v1/charges", "status": 200}])
        veris.assert_touched("stripe")

    def test_fails_loudly_when_nothing_reached_it(self, api):
        """A green suite that skipped its dependency looks identical to one that worked."""
        veris, _ = api(stripe_rows=[])
        with pytest.raises(VerisUntouchedError) as excinfo:
            veris.assert_touched("stripe")
        assert excinfo.value.service == "stripe"

    def test_a_matcher_narrows_to_method_and_path(self, api):
        veris, _ = api(stripe_rows=[{"method": "GET", "path": "/v1/customers", "status": 200}])
        veris.assert_touched("stripe", TouchMatcher(method="get", path="/v1/customers"))
        with pytest.raises(VerisUntouchedError):
            veris.assert_touched("stripe", TouchMatcher(method="POST"))

    def test_min_requests_is_enforced(self, api):
        veris, _ = api(stripe_rows=[{"method": "GET", "path": "/v1/x", "status": 200}])
        with pytest.raises(VerisUntouchedError, match="1/3"):
            veris.assert_touched("stripe", TouchMatcher(min_requests=3))


class TestNetworkUpdate:
    def test_re_asserts_the_egress_proxy_a_raw_update_would_drop(self, api):
        veris, sandbox = api()
        veris.update_network({"allow_public_traffic": True})
        sent = sandbox.networks[-1]
        assert sent["egress_proxy"]["address"] == "gw:1080"
        assert sent["allow_public_traffic"] is True

    def test_the_callers_own_hosts_survive_the_rebuild(self, api):
        veris, sandbox = api()
        veris.update_network({"allow_out": ["mine.example"]})
        assert "mine.example" in sandbox.networks[-1]["allow_out"]
        assert "npm.example" in sandbox.networks[-1]["allow_out"]

    def test_detaching_is_an_explicit_choice_that_is_honored(self, api):
        veris, sandbox = api()
        veris.update_network({"allow_out": ["mine.example"]}, detach_veris=True)
        assert "egress_proxy" not in sandbox.networks[-1]


class TestDeliverTo:
    def test_a_port_resolves_the_sandboxs_own_public_url(self, api):
        veris, _ = api()
        assert veris.deliver_to(3000) == "https://3000-sbx.e2b.app"

    def test_a_url_is_used_as_given(self, api):
        veris, _ = api()
        assert veris.deliver_to("https://my.tunnel.dev") == "https://my.tunnel.dev"

    def test_unregistering_needs_no_probe(self, api):
        veris, _ = api(probe_answered=False)
        assert veris.deliver_to(None) is None

    def test_an_unreachable_destination_is_refused_rather_than_registered_silently(self, api):
        veris, _ = api(probe_answered=False)
        with pytest.raises(VerisError, match="allow_public_traffic"):
            veris.deliver_to(3000)

    def test_the_probe_can_be_skipped(self, api):
        veris, _ = api(probe_answered=False)
        assert veris.deliver_to(3000, probe=False) == "https://3000-sbx.e2b.app"


class TestDataPlane:
    def test_exposes_the_env_the_code_under_test_reads(self, api):
        veris, _ = api()
        assert veris.get_data_plane_env() == {"DATABASE_URL": "postgresql://pg.gw:5432/app"}

    def test_trust_env_falls_back_to_the_vendored_map(self, api):
        veris, _ = api()
        assert veris.get_trust_env()["REQUESTS_CA_BUNDLE"] == "/etc/ssl/certs/ca-certificates.crt"
