"""CA trust for gateway mode: which env vars point which client stacks at the
system bundle, and the single tested install command."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

#: Where the Veris CA certificate lands in the sandbox. E2B's own envd uses this
#: directory for its injected CA, so a resume-time ``update-ca-certificates``
#: rebuilds the bundle with our cert included.
CA_CERT_PATH = "/usr/local/share/ca-certificates/veris-ca.crt"

#: The rebuilt system bundle every path-valued trust var points at.
SYSTEM_BUNDLE = "/etc/ssl/certs/ca-certificates.crt"


def vendored_trust_env() -> dict[str, str]:
    """The vendored trust-env fallback.

    The control plane serves the same map (``trust_env`` in the egress-credential
    response) as the source of truth, so new tools get covered by a control-plane
    deploy; the served copy wins per key.

    Every var is path-valued and points at the SYSTEM bundle (Veris CA + all
    public roots — passthrough hosts keep verifying), except
    ``NODE_EXTRA_CA_CERTS`` which is additive by design and takes the single cert.
    """
    return {
        "SSL_CERT_FILE": SYSTEM_BUNDLE,
        "REQUESTS_CA_BUNDLE": SYSTEM_BUNDLE,
        "CURL_CA_BUNDLE": SYSTEM_BUNDLE,
        "GIT_SSL_CAINFO": SYSTEM_BUNDLE,
        "AWS_CA_BUNDLE": SYSTEM_BUNDLE,
        "CARGO_HTTP_CAINFO": SYSTEM_BUNDLE,
        "DENO_CERT": SYSTEM_BUNDLE,
        "PIP_CERT": SYSTEM_BUNDLE,
        "npm_config_cafile": SYSTEM_BUNDLE,
        "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH": SYSTEM_BUNDLE,
        "BUNDLE_SSL_CA_CERT": SYSTEM_BUNDLE,
        "COMPOSER_CAFILE": SYSTEM_BUNDLE,
        "HEX_CACERTS_PATH": SYSTEM_BUNDLE,
        "JULIA_SSL_CA_ROOTS_PATH": SYSTEM_BUNDLE,
        "NIX_SSL_CERT_FILE": SYSTEM_BUNDLE,
        "PERL_LWP_SSL_CA_FILE": SYSTEM_BUNDLE,
        "CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE": SYSTEM_BUNDLE,
        "NODE_EXTRA_CA_CERTS": CA_CERT_PATH,
    }


#: Probe that the template can host the CA install at all. Prints ok/missing.
CA_TOOLING_PROBE = "command -v update-ca-certificates >/dev/null 2>&1 && echo ok || echo missing"

#: The one root command of gateway mode. Rebuilds the system bundle with the
#: Veris CA (already written to CA_CERT_PATH), then best-effort extras: the JVM
#: cacerts import (``|| true``: no Java -> skipped), and NSS databases for
#: browser stacks when certutil exists (never fatal).
CA_INSTALL_CMD = " && ".join(
    [
        "update-ca-certificates",
        f"(keytool -importcert -noprompt -cacerts -storepass changeit -alias veris "
        f"-file {CA_CERT_PATH} 2>/dev/null || true)",
        "(command -v certutil >/dev/null 2>&1 && "
        'for db in $(find /home /root -maxdepth 4 -name "cert9.db" 2>/dev/null | xargs -r -n1 dirname); do '
        f'certutil -A -n veris -t "C,," -i {CA_CERT_PATH} -d "sql:$db" 2>/dev/null || true; done || true)',
    ]
)

_PATH_VALUE = re.compile(r"^/[\w./+~-]+$")


def sanitize_trust_env(served: Mapping[str, Any] | None) -> dict[str, str]:
    """Sanitize a server-served trust_env map before injecting it into the sandbox.

    A control-plane response must never become arbitrary env-var injection, so
    only known trust variables survive and every value is forced to a path-shaped
    string (the vars are all CA *file paths*). Unknown keys and non-path values
    are dropped, falling back PER KEY to the vendored default rather than leaving
    (e.g.) Python's requests with no CA bundle at all.
    """
    vendored = vendored_trust_env()
    out = dict(vendored)
    for key, value in (served or {}).items():
        if key not in vendored:
            continue  # unknown key: never injected
        if not isinstance(value, str):
            continue
        if not _PATH_VALUE.match(value):
            continue
        out[key] = value
    return out
