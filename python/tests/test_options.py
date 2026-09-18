"""The create-time decisions: coordinates, guards, metadata and env merging."""

from __future__ import annotations

import json

import pytest

from veris_e2b._options import (
    Meta,
    VerisOpts,
    build_metadata,
    check_caller_network,
    coerce_opts,
    merge_envs,
    read_allow_out,
    rehydrate,
    resolve_coordinates,
    ttl_minutes_for,
    validate,
)
from veris_e2b.errors import MissingCredentialsError, VerisError


class TestCoordinates:
    def test_a_missing_key_names_the_variable(self, monkeypatch):
        monkeypatch.delenv("VERIS_API_KEY", raising=False)
        with pytest.raises(MissingCredentialsError, match="VERIS_API_KEY"):
            resolve_coordinates(VerisOpts(environment_id="env_1"))

    def test_a_missing_environment_names_the_variable(self, monkeypatch):
        monkeypatch.delenv("VERIS_ENVIRONMENT_ID", raising=False)
        with pytest.raises(MissingCredentialsError, match="VERIS_ENVIRONMENT_ID"):
            resolve_coordinates(VerisOpts(api_key="k"))

    def test_attaching_needs_no_environment(self):
        """The twin is named directly, so there is nothing to provision from."""
        coords = resolve_coordinates(VerisOpts(api_key="k", attach_sandbox_id="sb_1"))
        assert coords.environment_id is None

    def test_the_default_control_plane_is_the_host_that_serves_it(self, monkeypatch):
        monkeypatch.delenv("VERIS_API_BASE", raising=False)
        coords = resolve_coordinates(VerisOpts(api_key="k", environment_id="env_1"))
        assert coords.api_base == "https://svc.api.veris.ai"

    def test_the_environment_fills_in_what_the_caller_left_out(self, monkeypatch):
        monkeypatch.setenv("VERIS_API_KEY", "from-env")
        monkeypatch.setenv("VERIS_ENVIRONMENT_ID", "env_env")
        coords = resolve_coordinates(VerisOpts())
        assert (coords.api_key, coords.environment_id) == ("from-env", "env_env")


class TestGuards:
    def test_snapshot_and_attach_are_mutually_exclusive(self):
        """Attaching reuses a twin that is already at some state."""
        with pytest.raises(VerisError, match="mutually exclusive"):
            validate(VerisOpts(attach_sandbox_id="sb_1", snapshot_id="snap_1"))

    def test_proxy_mode_says_which_package_has_it(self):
        with pytest.raises(VerisError, match="@veris-ai/e2b"):
            validate(VerisOpts(mode="proxy"))

    def test_an_unknown_mode_is_refused(self):
        with pytest.raises(VerisError, match="expected 'auto' or 'gateway'"):
            validate(VerisOpts(mode="tunnel"))

    def test_an_unknown_egress_is_refused(self):
        with pytest.raises(VerisError, match="strict"):
            validate(VerisOpts(egress="loose"))

    def test_a_caller_egress_proxy_is_refused_rather_than_clobbered(self):
        with pytest.raises(VerisError, match="Veris owns the egress proxy"):
            check_caller_network({"egress_proxy": {"address": "mine:1080"}}, "sb_1")

    def test_an_unknown_veris_option_is_named(self):
        with pytest.raises(VerisError, match="snapshotId"):
            coerce_opts({"snapshotId": "snap_1"})

    def test_a_plain_dict_is_accepted(self):
        assert coerce_opts({"snapshot_id": "snap_1"}).snapshot_id == "snap_1"


class TestTtl:
    def test_the_twin_outlives_the_sandbox_by_ten_minutes(self):
        assert ttl_minutes_for(15 * 60) == 25

    def test_a_very_short_sandbox_still_gets_a_usable_floor(self):
        assert ttl_minutes_for(5) == 11

    def test_no_timeout_uses_the_e2b_default(self):
        assert ttl_minutes_for(None) == 15


class TestMetadata:
    def test_veris_keys_are_reserved_against_the_caller(self):
        meta = build_metadata(
            {Meta.TWIN_ID: "spoofed", "mine": "kept"},
            twin_id="sb_1",
            environment_id="env_1",
            api_base="https://svc.api.veris.ai",
            egress="strict",
            owns_twin=True,
            allow_out=["npm.example"],
            snapshot_id=None,
        )
        assert meta[Meta.TWIN_ID] == "sb_1"
        assert meta["mine"] == "kept"

    def test_a_snapshot_boot_records_which_snapshot(self):
        meta = build_metadata(
            None,
            twin_id="sb_1",
            environment_id="env_1",
            api_base="https://svc.api.veris.ai",
            egress="strict",
            owns_twin=True,
            allow_out=[],
            snapshot_id="snap_1",
        )
        assert meta[Meta.SNAPSHOT_ID] == "snap_1"

    def test_a_baseline_boot_stamps_no_snapshot_key(self):
        meta = build_metadata(
            None,
            twin_id="sb_1",
            environment_id="env_1",
            api_base="https://svc.api.veris.ai",
            egress="strict",
            owns_twin=True,
            allow_out=[],
            snapshot_id=None,
        )
        assert Meta.SNAPSHOT_ID not in meta

    def test_allow_out_round_trips(self):
        meta = build_metadata(
            None,
            twin_id="sb_1",
            environment_id="env_1",
            api_base="https://svc.api.veris.ai",
            egress="strict",
            owns_twin=False,
            allow_out=["a", "b"],
            snapshot_id=None,
        )
        assert read_allow_out(meta) == ["a", "b"]

    def test_corrupt_allow_out_metadata_reads_as_empty(self):
        assert read_allow_out({Meta.ALLOW_OUT: "{not json"}) == []


class TestEnvMerge:
    def test_veris_managed_vars_beat_caller_values(self):
        """A caller DATABASE_URL would silently point the code at production."""
        envs = merge_envs(
            {"DATABASE_URL": "postgresql://production/db"},
            trust_env={},
            data_plane={"DATABASE_URL": "postgresql://twin/db"},
            twin_id="sb_1",
            install_ca=True,
            inject_data_plane=True,
        )
        assert envs["DATABASE_URL"] == "postgresql://twin/db"

    def test_declining_the_ca_install_skips_the_trust_vars(self):
        envs = merge_envs(
            None,
            trust_env={"SSL_CERT_FILE": "/x"},
            data_plane={},
            twin_id="sb_1",
            install_ca=False,
            inject_data_plane=True,
        )
        assert "SSL_CERT_FILE" not in envs

    def test_the_twin_id_is_always_readable_from_inside(self):
        envs = merge_envs(
            None,
            trust_env={},
            data_plane={},
            twin_id="sb_1",
            install_ca=True,
            inject_data_plane=True,
        )
        assert envs["VERIS_SANDBOX_ID"] == "sb_1"


class TestRehydrate:
    def base_meta(self, **overrides: str) -> dict[str, str]:
        meta = {
            Meta.MODE: "gateway",
            Meta.TWIN_ID: "sb_1",
            Meta.ENV_ID: "env_1",
            Meta.API_BASE: "https://svc.api.veris.ai",
            Meta.EGRESS: "strict",
            Meta.OWNS_TWIN: "true",
            Meta.ALLOW_OUT: json.dumps(["npm.example"]),
        }
        meta.update(overrides)
        return meta

    def test_reads_the_wiring_back(self, monkeypatch):
        monkeypatch.delenv("VERIS_API_BASE", raising=False)
        wiring = rehydrate(self.base_meta(), "e2b_1", "k", None)
        assert wiring.twin_id == "sb_1"
        assert wiring.allow_out == ["npm.example"]
        assert wiring.owns_twin is True

    def test_a_sandbox_not_made_by_this_package_is_named_as_such(self, monkeypatch):
        monkeypatch.setenv("VERIS_API_KEY", "k")
        with pytest.raises(VerisError, match="not created by veris-e2b"):
            rehydrate({}, "e2b_1", "k", None)

    def test_metadata_may_not_redirect_the_api_key(self, monkeypatch):
        """A compromised sandbox could rewrite its own metadata to exfiltrate it."""
        monkeypatch.delenv("VERIS_API_BASE", raising=False)
        meta = self.base_meta(**{Meta.API_BASE: "https://evil.example"})
        with pytest.raises(VerisError, match="refusing to send the API key"):
            rehydrate(meta, "e2b_1", "k", "https://svc.api.veris.ai")

    def test_an_attached_twin_is_not_deleted_on_kill(self, monkeypatch):
        monkeypatch.delenv("VERIS_API_BASE", raising=False)
        wiring = rehydrate(self.base_meta(**{Meta.OWNS_TWIN: "false"}), "e2b_1", "k", None)
        assert wiring.owns_twin is False
