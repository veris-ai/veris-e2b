"""The E2B network option gateway mode builds: what may leave the sandbox."""

from __future__ import annotations

from e2b import ALL_TRAFFIC

from veris_e2b.control_plane import EgressCredential, RouteEntry, ServiceInfo
from veris_e2b.network import (
    build_network,
    caller_static_allow_out,
    data_plane_env,
    data_plane_hosts,
    is_safe_env_name,
    vendor_hosts,
)

CREDENTIAL = EgressCredential(
    socks_address="gw:1080", username="u", password="p", ca_pem="PEM", canary_host="canary.veris"
)


def service(
    name: str, url: str, *, hosts: list[str] | None = None, env_hint: str | None = None
) -> ServiceInfo:
    return ServiceInfo(
        name=name,
        status="ready",
        url=url,
        control_url=url if url.startswith("http") else f"https://gw/{name}",
        env_hint=env_hint,
        routes=[RouteEntry(host=h) for h in hosts or []],
    )


class TestVendorHosts:
    def test_collects_every_route_host_sorted_and_deduped(self):
        services = [
            service(
                "google", "https://gw/g", hosts=["www.googleapis.com", "oauth2.googleapis.com"]
            ),
            service("drive", "https://gw/d", hosts=["www.googleapis.com"]),
        ]
        assert vendor_hosts(services) == ["oauth2.googleapis.com", "www.googleapis.com"]

    def test_a_service_with_no_routes_contributes_nothing(self):
        assert vendor_hosts([service("pg", "postgresql://pg.gw:5432/db")]) == []


class TestDataPlanes:
    def test_a_dsn_host_is_allowed_out_explicitly(self):
        """These flows are host-matched, not domain-matched: strict mode must
        name them or the data plane silently breaks."""
        services = [service("pg", "postgresql://user:pw@pg.gw.veris:5432/app")]
        assert data_plane_hosts(services) == ["pg.gw.veris"]

    def test_every_host_of_a_multi_host_dsn_survives(self):
        services = [service("mongo", "mongodb://a.gw:27017,b.gw:27017/db")]
        assert data_plane_hosts(services) == ["a.gw", "b.gw"]

    def test_ipv6_brackets_are_stripped(self):
        services = [service("redis", "redis://[2001:db8::1]:6379")]
        assert data_plane_hosts(services) == ["2001:db8::1"]

    def test_http_services_are_not_data_planes(self):
        assert data_plane_hosts([service("stripe", "https://gw/stripe")]) == []

    def test_env_hint_becomes_the_variable_the_code_reads(self):
        services = [service("pg", "postgresql://pg.gw:5432/app", env_hint="DATABASE_URL")]
        assert data_plane_env(services) == {"DATABASE_URL": "postgresql://pg.gw:5432/app"}

    def test_a_process_controlling_env_hint_is_refused(self):
        """The name comes from a control-plane response and is injected into
        every command — PATH or NODE_OPTIONS would steer the sandbox."""
        assert not is_safe_env_name("PATH")
        assert not is_safe_env_name("NODE_OPTIONS")
        assert not is_safe_env_name("lowercase")
        assert is_safe_env_name("DATABASE_URL")
        services = [service("pg", "postgresql://pg.gw:5432/app", env_hint="PATH")]
        assert data_plane_env(services) == {}


class TestBuildNetwork:
    def test_strict_denies_everything_and_allows_only_what_is_named(self):
        services = [
            service("stripe", "https://gw/stripe", hosts=["api.stripe.com"]),
            service("pg", "postgresql://pg.gw:5432/app"),
        ]
        net = build_network(
            credential=CREDENTIAL, services=services, mode="strict", allow_out=["npm.example"]
        )
        assert net["deny_out"] == [ALL_TRAFFIC]
        assert net["allow_out"] == ["api.stripe.com", "canary.veris", "npm.example", "pg.gw"]
        assert ALL_TRAFFIC not in net["allow_out"]

    def test_open_appends_the_catch_all(self):
        net = build_network(credential=CREDENTIAL, services=[], mode="open")
        assert net["allow_out"][-1] == ALL_TRAFFIC

    def test_the_egress_proxy_carries_the_minted_credential(self):
        net = build_network(credential=CREDENTIAL, services=[], mode="strict")
        assert net["egress_proxy"] == {"address": "gw:1080", "username": "u", "password": "p"}

    def test_the_canary_host_is_always_reachable(self):
        """Without it the probe that proves interception cannot run."""
        net = build_network(credential=CREDENTIAL, services=[], mode="strict")
        assert "canary.veris" in net["allow_out"]

    def test_duplicates_collapse(self):
        services = [service("a", "https://gw/a", hosts=["api.stripe.com"])]
        net = build_network(
            credential=CREDENTIAL, services=services, mode="strict", allow_out=["api.stripe.com"]
        )
        assert net["allow_out"].count("api.stripe.com") == 1


class TestCallerAllowOut:
    def test_static_entries_are_read(self):
        assert caller_static_allow_out({"allow_out": ["a", "b"]}) == ["a", "b"]

    def test_a_selector_callable_contributes_none(self):
        assert caller_static_allow_out({"allow_out": lambda ctx: ["a"]}) == []

    def test_no_network_is_no_entries(self):
        assert caller_static_allow_out(None) == []
