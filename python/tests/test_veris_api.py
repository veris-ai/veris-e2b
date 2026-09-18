"""The sbx.veris surface: receipts, assertions, safe network updates, delivery."""

from __future__ import annotations

import json

import httpx
import pytest

from veris_e2b.errors import VerisError, VerisUntouchedError
from veris_e2b.receipt import Receipt, ReceiptEntry
from veris_e2b.run_receipt import ReceiptBaseline
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


class TraceLog:
    """A stand-in for a twin's trace log that honours the paging contract.

    The real thing caps `limit` and orders by id; a fake that ignores either
    would let a reader that ignores them pass, which is the exact bug the paged
    read exists to fix.
    """

    SERVER_CAP = 1000

    def __init__(self) -> None:
        self.rows: dict[str, list[dict]] = {name: [] for name in ("stripe", "pg")}
        self._next_id = 1

    def append(self, service: str, **row) -> dict:
        entry = {"id": self._next_id, "status": 200, **row}
        self._next_id += 1
        self.rows[service].append(entry)
        return entry

    def page(self, service: str, params) -> list[dict]:
        rows = self.rows[service]
        limit = min(int(params.get("limit", 50)), self.SERVER_CAP)
        if params.get("order") == "desc":
            return list(reversed(rows))[:limit]
        since = int(params.get("since_id", 0))
        return [r for r in rows if r["id"] > since][:limit]


@pytest.fixture
def api(control_plane, fake_sandbox):
    """A VerisApi over a scripted control plane and a twin with a real trace log."""

    def build(
        *,
        stripe_calls: int = 0,
        probe_answered: bool = True,
        canary: str = CANARY_OK,
        control_body: dict | None = None,
    ):
        log = TraceLog()
        for n in range(stripe_calls):
            log.append("stripe", method="POST", path=f"/v1/charges/{n}", tier="handler")

        def handler(request: httpx.Request) -> httpx.Response:
            path = request.url.path
            params = dict(request.url.params)
            service = "stripe" if "stripe" in path else "pg"
            if path.endswith("/services"):
                return httpx.Response(200, json=SERVICES)
            if path.endswith("/egress-credential"):
                return httpx.Response(200, json=CREDENTIAL)
            if path.endswith("/veris/requests"):
                return httpx.Response(200, json={"requests": log.page(service, params)})
            if path.endswith("/veris/schema"):
                marker = request.headers.get("x-veris-receipt-baseline")
                if marker:
                    log.append(
                        service,
                        method="GET",
                        path="/veris/schema",
                        tier="control",
                        request_headers=json.dumps({"x-veris-receipt-baseline": marker}),
                    )
                return httpx.Response(200, json={"schema": {}})
            if path.endswith("/veris/manual"):
                return httpx.Response(200, json=control_body or {"manual": "how this twin behaves"})
            if path.endswith("/veris/data"):
                return httpx.Response(200, json={"rows": 3})
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
        return VerisApi(ctx), sandbox, log

    return build


class TestReceipt:
    def test_counts_what_the_twin_received(self, api):
        veris, _, _log = api(stripe_calls=1)
        entry = veris.receipt("stripe")
        assert isinstance(entry, ReceiptEntry)
        assert entry.requests == 1

    def test_the_whole_receipt_skips_non_http_control_planes(self, api):
        veris, _, _log = api(stripe_calls=0)
        receipt = veris.receipt()
        assert isinstance(receipt, Receipt)
        assert set(receipt.services) == {"stripe", "pg"}

    def test_strict_egress_has_no_known_blind_spots(self, api):
        veris, _, _log = api()
        receipt = veris.receipt()
        assert receipt.leaks == []
        assert receipt.integrity == "verified"

    def test_the_canary_runs_before_any_count_is_trusted(self, api):
        """A receipt read from an un-tunneled sandbox would lie."""
        veris, sandbox, _log = api()
        veris.receipt()
        assert any("canary.veris" in cmd for cmd in sandbox.commands.ran)

    def test_a_broken_tunnel_fails_the_read_instead_of_returning_zero(self, api):
        veris, _, _log = api(canary="")
        with pytest.raises(VerisError, match="not tunneled"):
            veris.receipt()

    def test_an_unknown_service_is_a_typo_not_an_untouched_dependency(self, api):
        veris, _, _log = api()
        with pytest.raises(VerisError) as excinfo:
            veris.receipt("strype")
        assert not isinstance(excinfo.value, VerisUntouchedError)
        assert "available: stripe, pg" in str(excinfo.value)


class TestAssertTouched:
    def test_passes_when_the_service_was_called(self, api):
        veris, _, _log = api(stripe_calls=1)
        veris.assert_touched("stripe")

    def test_fails_loudly_when_nothing_reached_it(self, api):
        """A green suite that skipped its dependency looks identical to one that worked."""
        veris, _, _log = api(stripe_calls=0)
        with pytest.raises(VerisUntouchedError) as excinfo:
            veris.assert_touched("stripe")
        assert excinfo.value.service == "stripe"

    def test_a_matcher_narrows_to_method_and_path(self, api):
        veris, _, _log = api(stripe_calls=1)
        veris.assert_touched("stripe", TouchMatcher(method="post", path="/v1/charges"))
        with pytest.raises(VerisUntouchedError):
            veris.assert_touched("stripe", TouchMatcher(method="GET"))
        with pytest.raises(VerisUntouchedError):
            veris.assert_touched("stripe", TouchMatcher(path="/v1/refunds"))

    def test_min_requests_is_enforced(self, api):
        veris, _, _log = api(stripe_calls=1)
        with pytest.raises(VerisUntouchedError, match="1/3"):
            veris.assert_touched("stripe", TouchMatcher(min_requests=3))


class TestNetworkUpdate:
    def test_re_asserts_the_egress_proxy_a_raw_update_would_drop(self, api):
        veris, sandbox, _log = api()
        veris.update_network({"allow_public_traffic": True})
        sent = sandbox.networks[-1]
        assert sent["egress_proxy"]["address"] == "gw:1080"
        assert sent["allow_public_traffic"] is True

    def test_the_callers_own_hosts_survive_the_rebuild(self, api):
        veris, sandbox, _log = api()
        veris.update_network({"allow_out": ["mine.example"]})
        assert "mine.example" in sandbox.networks[-1]["allow_out"]
        assert "npm.example" in sandbox.networks[-1]["allow_out"]

    def test_detaching_is_an_explicit_choice_that_is_honored(self, api):
        veris, sandbox, _log = api()
        veris.update_network({"allow_out": ["mine.example"]}, detach_veris=True)
        assert "egress_proxy" not in sandbox.networks[-1]


class TestDeliverTo:
    def test_a_port_resolves_the_sandboxs_own_public_url(self, api):
        veris, _, _log = api()
        assert veris.deliver_to(3000) == "https://3000-sbx.e2b.app"

    def test_a_url_is_used_as_given(self, api):
        veris, _, _log = api()
        assert veris.deliver_to("https://my.tunnel.dev") == "https://my.tunnel.dev"

    def test_unregistering_needs_no_probe(self, api):
        veris, _, _log = api(probe_answered=False)
        assert veris.deliver_to(None) is None

    def test_an_unreachable_destination_is_refused_rather_than_registered_silently(self, api):
        veris, _, _log = api(probe_answered=False)
        with pytest.raises(VerisError, match="allow_public_traffic"):
            veris.deliver_to(3000)

    def test_the_probe_can_be_skipped(self, api):
        veris, _, _log = api(probe_answered=False)
        assert veris.deliver_to(3000, probe=False) == "https://3000-sbx.e2b.app"


class TestDataPlane:
    def test_exposes_the_env_the_code_under_test_reads(self, api):
        veris, _, _log = api()
        assert veris.get_data_plane_env() == {"DATABASE_URL": "postgresql://pg.gw:5432/app"}

    def test_trust_env_falls_back_to_the_vendored_map(self, api):
        veris, _, _log = api()
        assert veris.get_trust_env()["REQUESTS_CA_BUNDLE"] == "/etc/ssl/certs/ca-certificates.crt"


class TestPagedReads:
    """The two bugs the paged read replaced, each asserted directly."""

    def test_a_run_past_the_default_page_is_counted_in_full(self, api):
        """A single unpaged GET answers with 50 rows and says nothing about the
        rest, so a run that made 200 calls used to report 50."""
        veris, _, _log = api(stripe_calls=200)
        entry = veris.receipt("stripe")
        assert entry.requests == 200
        assert entry.capped is False

    def test_a_read_that_stops_early_says_so_instead_of_reporting_a_floor(self, api, monkeypatch):
        import veris_e2b.receipt as receipt_module

        monkeypatch.setattr(receipt_module, "PAGE_LIMIT", 10)
        monkeypatch.setattr(receipt_module, "MAX_PAGES", 2)
        veris, _, _log = api(stripe_calls=200)
        entry = veris.receipt("stripe")
        assert entry.capped is True
        assert entry.incomplete_reason == "page-limit"
        assert entry.requests < 200

    def test_a_capped_read_cannot_fail_an_assertion_as_untouched(self, api, monkeypatch):
        """'We did not see them' is a different failure from 'never called'."""
        import veris_e2b.receipt as receipt_module

        monkeypatch.setattr(receipt_module, "PAGE_LIMIT", 1)
        monkeypatch.setattr(receipt_module, "MAX_PAGES", 1)
        veris, _, _log = api(stripe_calls=50)
        with pytest.raises(VerisError, match="insufficient evidence"):
            veris.assert_touched("stripe", TouchMatcher(min_requests=50))

    def test_the_watermark_is_taken_before_the_pages_are_read(self, api):
        entry = api(stripe_calls=3)[0].receipt("stripe")
        assert entry.since_id == 0
        assert entry.until_id >= 3


class TestRunScopedReceipts:
    def test_an_attached_twins_prior_traffic_is_not_credited_to_this_run(self, api):
        """Counting the whole log credits this run with someone else's calls —
        which is exactly what an attached twin hands you."""
        veris, _, log = api(stripe_calls=5)
        baseline = veris.receipt_baseline()
        for n in range(2):
            log.append("stripe", method="GET", path=f"/v1/customers/{n}", tier="handler")

        since = veris.receipt_since(baseline)
        assert since.services["stripe"].requests == 2

        whole = veris.receipt("stripe")
        assert whole.requests == 7

    def test_a_baseline_survives_a_round_trip_through_storage(self, api):
        """An explore session outlives the process that opened it."""
        veris, _, log = api(stripe_calls=1)
        baseline = veris.receipt_baseline()
        restored = ReceiptBaseline.from_dict(json.loads(json.dumps(baseline.to_dict())))
        log.append("stripe", method="GET", path="/v1/x", tier="handler")
        assert veris.receipt_since(restored).services["stripe"].requests == 1

    def test_a_baseline_from_another_session_is_refused(self, api):
        veris, _, _log = api(stripe_calls=1)
        baseline = veris.receipt_baseline()
        foreign = ReceiptBaseline(
            twin_id="sb_other", sandbox_id=baseline.sandbox_id, services=baseline.services
        )
        with pytest.raises(VerisError, match="take a new baseline"):
            veris.receipt_since(foreign)

    def test_one_service_can_be_read_alone(self, api):
        veris, _, log = api(stripe_calls=1)
        baseline = veris.receipt_baseline()
        log.append("stripe", method="GET", path="/v1/x", tier="handler")
        assert set(veris.receipt_since(baseline, "stripe").services) == {"stripe"}

    def test_an_unknown_service_is_named(self, api):
        veris, _, _log = api()
        baseline = veris.receipt_baseline()
        with pytest.raises(VerisError, match="unknown HTTP service"):
            veris.receipt_since(baseline, "strype")

    def test_taking_a_baseline_proves_the_tunnel_first(self, api):
        veris, _, _log = api(canary="")
        with pytest.raises(VerisError, match="not tunneled"):
            veris.receipt_baseline()


class TestServiceControl:
    def test_reads_a_services_manual(self, api):
        veris, _, _log = api()
        assert veris.control("stripe", "manual") == {"manual": "how this twin behaves"}

    def test_an_unknown_service_lists_what_there_is(self, api):
        veris, _, _log = api()
        with pytest.raises(VerisError, match="available: stripe, pg"):
            veris.control("strype", "manual")

    def test_writes_are_confined_to_the_seed_data(self, api):
        """Every other resource describes the twin rather than its contents."""
        veris, _, _log = api()
        veris.control("stripe", "data", method="PATCH", body={"rows": []})
        for resource in ("manual", "schema", "operations", "requests"):
            with pytest.raises(VerisError, match="unsupported service control operation"):
                veris.control("stripe", resource, method="PATCH", body={})

    def test_a_resource_outside_the_advertised_set_is_refused(self, api):
        veris, _, _log = api()
        with pytest.raises(VerisError, match="unsupported service control operation"):
            veris.control("stripe", "shutdown")

    def test_a_get_may_not_carry_a_body(self, api):
        veris, _, _log = api()
        with pytest.raises(VerisError, match="unsupported service control operation"):
            veris.control("stripe", "manual", body={"x": 1})
