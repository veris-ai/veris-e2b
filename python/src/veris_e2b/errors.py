"""Every failure this package raises.

Deliberately NOT subclasses of e2b's ``SandboxException``: ``except VerisError``
cleanly separates Veris failures from E2B failures in one clause.
"""

from __future__ import annotations

from typing import Any, Literal

#: Every failure phase a Veris error can name. Gateway mode has no in-sandbox
#: boot log to dump, so errors carry a structured phase instead.
VerisErrorPhase = Literal[
    "credentials",
    "gateway-preflight",
    "twin-provision",
    "credential-mint",
    "e2b-create",
    "ca-install",
    "canary",
    "receipt",
    "connect",
]


class VerisError(Exception):
    """Base class for every error this package raises."""

    def __init__(
        self,
        message: str,
        *,
        phase: VerisErrorPhase | None = None,
        veris_sandbox_id: str | None = None,
        response_body: Any = None,
    ) -> None:
        super().__init__(message)
        self.phase = phase
        #: The per-run Veris (twin) sandbox id, when one exists yet.
        self.veris_sandbox_id = veris_sandbox_id
        #: Verbatim control-plane response body, when the failure came from an API call.
        self.response_body = response_body


class MissingCredentialsError(VerisError):
    """A required credential/coordinate is missing, named before any network call."""


class VerisGatewayUnreachableError(VerisError):
    """The Veris gateway infrastructure is down (control-plane health said so)."""


class VerisGatewayNotOfferedError(VerisError):
    """The control plane does not offer gateway mode, or this SDK is below min_sdk."""

    def __init__(self, message: str, *, min_sdk: str | None = None, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        #: Server-announced minimum SDK version, when the refusal carried one.
        self.min_sdk = min_sdk


class ReceiptIntegrityError(VerisError):
    """The canary probe failed: egress is not (or no longer) tunneled through the gateway."""


class VerisUntouchedError(VerisError):
    """``assert_touched``: the named service saw zero matching requests."""

    def __init__(self, message: str, service: str, **kwargs: Any) -> None:
        super().__init__(message, **kwargs)
        self.service = service


class TwinExpiredError(VerisError):
    """The E2B sandbox is alive but its Veris twin is gone (TTL expiry, delete, reset)."""


class TemplateUnsupportedError(VerisError):
    """The template cannot host the Veris layer (e.g. no ca-certificates for the CA install)."""


class UnsupportedOperationError(VerisError):
    """An inherited E2B operation that would break the one-sandbox-one-twin invariant."""
