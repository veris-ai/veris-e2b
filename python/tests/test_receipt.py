"""Receipts, and the canary that decides whether a receipt may be believed."""

from __future__ import annotations

import json

import pytest

from veris_e2b.errors import ReceiptIntegrityError
from veris_e2b.receipt import canary_command, canary_verdict, parse_requests_body, probe_canary


class TestParsing:
    def test_counts_and_types_the_rows(self):
        count, entries = parse_requests_body(
            {"requests": [{"method": "post", "path": "/v1/charges", "status": 200}]}
        )
        assert count == 1
        assert entries[0].method == "post"
        assert entries[0].status == 200

    def test_a_request_with_no_response_has_a_null_status(self):
        """A fault hang is a real outcome, not a missing row."""
        _, entries = parse_requests_body({"requests": [{"method": "GET", "path": "/x"}]})
        assert entries[0].status is None

    def test_a_body_with_no_requests_key_is_empty_not_an_error(self):
        assert parse_requests_body({}) == (0, [])
        assert parse_requests_body("nonsense") == (0, [])


class TestCanaryCommand:
    def test_a_malformed_canary_host_never_reaches_the_shell(self):
        with pytest.raises(ReceiptIntegrityError):
            canary_command("evil.com; rm -rf /", "sb_1", None)

    def test_a_malformed_ca_path_never_reaches_the_shell(self):
        with pytest.raises(ReceiptIntegrityError):
            canary_command("canary.veris", "sb_1", "/etc/ca.crt; curl evil")

    def test_the_cert_is_passed_so_the_probe_works_without_a_system_install(self):
        cmd = canary_command(
            "canary.veris", "sb_1", "/usr/local/share/ca-certificates/veris-ca.crt"
        )
        assert "--cacert /usr/local/share/ca-certificates/veris-ca.crt" in cmd

    def test_a_curl_failure_is_printed_rather_than_raised_by_the_shell(self):
        """The exit code has to come back as output so a failed tunnel surfaces
        as ReceiptIntegrityError, not an opaque command error."""
        assert "__VERIS_CANARY_FAIL__" in canary_command("canary.veris", "sb_1", None)


class TestCanaryVerdict:
    def test_the_right_twin_passes(self):
        canary_verdict(json.dumps({"veris_sandbox_id": "sb_1"}), "", "sb_1")

    def test_another_twin_fails(self):
        """The credential demuxing to the wrong twin is exactly what this catches."""
        with pytest.raises(ReceiptIntegrityError):
            canary_verdict(json.dumps({"veris_sandbox_id": "sb_2"}), "", "sb_1")

    def test_no_answer_fails(self):
        with pytest.raises(ReceiptIntegrityError, match="not tunneled"):
            canary_verdict("", "curl: (7) could not connect", "sb_1")

    def test_a_probe_that_cannot_run_at_all_is_a_failed_probe(self):
        class Exploding:
            class commands:  # noqa: N801 - mirrors the sdk's attribute shape
                @staticmethod
                def run(*_a, **_k):
                    raise RuntimeError("sandbox gone")

        with pytest.raises(ReceiptIntegrityError):
            probe_canary(Exploding(), "canary.veris", "sb_1")

    def test_a_green_probe_runs_the_command_in_the_sandbox(self, fake_sandbox):
        sandbox = fake_sandbox({"canary.veris": (json.dumps({"veris_sandbox_id": "sb_1"}), "")})
        probe_canary(sandbox, "canary.veris", "sb_1")
        assert any("canary.veris" in cmd for cmd in sandbox.commands.ran)
