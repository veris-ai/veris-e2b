"""CA trust: which variables are injected, and what a served map may change."""

from __future__ import annotations

from veris_e2b.trust import (
    CA_CERT_PATH,
    CA_INSTALL_CMD,
    SYSTEM_BUNDLE,
    sanitize_trust_env,
    vendored_trust_env,
)


class TestVendoredMap:
    def test_path_valued_vars_point_at_the_rebuilt_system_bundle(self):
        """Not at the bare cert: passthrough hosts must keep verifying against
        the public roots."""
        env = vendored_trust_env()
        assert env["REQUESTS_CA_BUNDLE"] == SYSTEM_BUNDLE
        assert env["CURL_CA_BUNDLE"] == SYSTEM_BUNDLE

    def test_node_extra_ca_certs_takes_the_single_cert(self):
        """It is additive by design, so it gets the cert rather than the bundle."""
        assert vendored_trust_env()["NODE_EXTRA_CA_CERTS"] == CA_CERT_PATH


class TestSanitize:
    def test_a_served_value_wins_for_a_known_key(self):
        env = sanitize_trust_env({"SSL_CERT_FILE": "/etc/other/bundle.crt"})
        assert env["SSL_CERT_FILE"] == "/etc/other/bundle.crt"

    def test_an_unknown_key_is_never_injected(self):
        """A control-plane response must not become arbitrary env injection."""
        env = sanitize_trust_env({"LD_PRELOAD": "/tmp/evil.so"})
        assert "LD_PRELOAD" not in env

    def test_a_non_path_value_falls_back_to_the_vendored_default(self):
        env = sanitize_trust_env({"SSL_CERT_FILE": "$(curl evil)"})
        assert env["SSL_CERT_FILE"] == SYSTEM_BUNDLE

    def test_a_missing_key_keeps_its_default_rather_than_vanishing(self):
        """Dropping it would leave that client stack with no CA bundle at all."""
        env = sanitize_trust_env({"SSL_CERT_FILE": "/etc/other.crt"})
        assert env["REQUESTS_CA_BUNDLE"] == SYSTEM_BUNDLE

    def test_no_served_map_is_the_vendored_map(self):
        assert sanitize_trust_env(None) == vendored_trust_env()


class TestInstallCommand:
    def test_rebuilds_the_bundle_first(self):
        assert CA_INSTALL_CMD.startswith("update-ca-certificates")

    def test_the_optional_stores_can_never_fail_the_install(self):
        """No Java and no certutil is the common case, not an error."""
        assert CA_INSTALL_CMD.count("|| true") >= 2
