"""The SDK version sent to the control plane as ``X-Veris-SDK``.

The control plane version-gates gateway mode on it, so it is read from the
installed package metadata rather than hand-maintained; a source checkout that
was never installed falls back to a dev marker.
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version

try:
    SDK_VERSION: str = version("veris-e2b")
except PackageNotFoundError:  # pragma: no cover - source checkout, not installed
    SDK_VERSION = "0.0.0-dev"
