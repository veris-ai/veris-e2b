"""veris-e2b — Veris dependency-sandbox interception for E2B, in Python.

A drop-in subclass of e2b's ``Sandbox`` whose vendor API calls are answered by a
per-run Veris twin: the code under test dials production hostnames and never
learns it was intercepted, and every run ends with a receipt of what the vendor
actually received.

    from veris_e2b import Sandbox, VerisOpts

    sbx = Sandbox.create(veris=VerisOpts(environment_id="env_…"))
    sbx.commands.run("curl -sS https://api.stripe.com/v1/customers -u sk_test_veris:")
    sbx.veris.assert_touched("stripe")
    sbx.kill()

``AsyncSandbox`` is the same thing for callers already inside an event loop.
"""

from __future__ import annotations

from ._options import VerisOpts
from .async_sandbox import AsyncSandbox
from .control_plane import EgressCredential, RouteEntry, ServiceInfo, TwinSandbox
from .errors import (
    MissingCredentialsError,
    ReceiptIntegrityError,
    TemplateUnsupportedError,
    TwinExpiredError,
    UnsupportedOperationError,
    VerisError,
    VerisGatewayNotOfferedError,
    VerisGatewayUnreachableError,
    VerisUntouchedError,
)
from .network import EgressMode
from .receipt import Receipt, ReceiptEntry, ReceiptLeak, ReceiptRequest
from .sandbox import Sandbox
from .veris_api import AsyncVerisApi, TouchMatcher, VerisApi
from .version import SDK_VERSION

__all__ = [
    "AsyncSandbox",
    "AsyncVerisApi",
    "EgressCredential",
    "EgressMode",
    "MissingCredentialsError",
    "Receipt",
    "ReceiptEntry",
    "ReceiptIntegrityError",
    "ReceiptLeak",
    "ReceiptRequest",
    "RouteEntry",
    "SDK_VERSION",
    "Sandbox",
    "ServiceInfo",
    "TemplateUnsupportedError",
    "TouchMatcher",
    "TwinExpiredError",
    "TwinSandbox",
    "UnsupportedOperationError",
    "VerisApi",
    "VerisError",
    "VerisGatewayNotOfferedError",
    "VerisGatewayUnreachableError",
    "VerisOpts",
    "VerisUntouchedError",
]
