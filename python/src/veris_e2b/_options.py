"""Options, coordinates and the create-time decisions that are pure.

Everything here is IO-free so the blocking and non-blocking sandboxes make the
same choices from the same code — the two ``create`` bodies differ only in how
they await.
"""

from __future__ import annotations

import json
import math
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from .control_plane import DEFAULT_API_BASE
from .errors import MissingCredentialsError, VerisError
from .network import EgressMode

VerisMode = Literal["auto", "gateway"]

#: E2B's own default sandbox lifetime, in seconds — the base for the twin's TTL
#: backstop when the caller names no timeout.
DEFAULT_TIMEOUT_S = 300


@dataclass
class VerisOpts:
    """The Veris half of ``Sandbox.create``. Every field has an env fallback or a default."""

    #: Veris API key. Falls back to ``VERIS_API_KEY``. Required.
    api_key: str | None = None
    #: Veris environment the per-run twin is deployed from. Falls back to ``VERIS_ENVIRONMENT_ID``.
    environment_id: str | None = None
    #: Control plane base. Falls back to ``VERIS_API_BASE``, then svc.api.veris.ai.
    api_base: str | None = None
    #: Attach to an EXISTING twin instead of provisioning one. ``kill()`` will NOT delete it.
    attach_sandbox_id: str | None = None
    #: Boot the twin from one of the environment's snapshots instead of its
    #: baseline, so the run starts from a known state. Mutually exclusive with
    #: ``attach_sandbox_id`` (an existing twin already is at some state).
    snapshot_id: str | None = None
    #: Twin TTL backstop, minutes. Default: derived from the sandbox timeout + 10.
    ttl_minutes: int | None = None
    #: ``strict`` (default): only vendor hosts + allow_out + data planes may leave.
    #: ``open``: everything egresses, with documented QUIC/ECH blind spots.
    egress: EgressMode = "strict"
    #: Extra hosts or CIDRs the code may reach, merged into the allowlist.
    allow_out: list[str] = field(default_factory=list)
    #: Install the CA + inject the trust env family at create.
    install_ca: bool = True
    #: Inject ``{env_hint: dsn}`` for non-HTTP twin services (e.g. ``DATABASE_URL``).
    data_plane_env: bool = True
    #: Only ``auto``/``gateway`` here — see :func:`validate`.
    mode: str = "auto"


def coerce_opts(veris: VerisOpts | Mapping[str, Any] | None) -> VerisOpts:
    """Accept a ``VerisOpts``, a plain dict, or nothing."""
    if veris is None:
        return VerisOpts()
    if isinstance(veris, VerisOpts):
        return veris
    unknown = set(veris) - {f for f in VerisOpts.__dataclass_fields__}
    if unknown:
        raise VerisError(
            f"unknown veris option(s): {', '.join(sorted(unknown))}", phase="credentials"
        )
    return VerisOpts(**dict(veris))


@dataclass(frozen=True)
class Coordinates:
    api_key: str
    api_base: str
    environment_id: str | None


def validate(opts: VerisOpts) -> None:
    """Refuse contradictory or unimplemented combinations before any network call."""
    # An attached twin is already at whatever state it is at — a snapshot to boot
    # it from is a contradiction, not a refinement.
    if opts.snapshot_id and opts.attach_sandbox_id:
        raise VerisError(
            "snapshot_id and attach_sandbox_id are mutually exclusive: attaching reuses an "
            "existing twin, which cannot be re-booted from a snapshot",
            phase="credentials",
        )
    if opts.mode == "proxy":
        raise VerisError(
            "proxy mode is not implemented in the Python SDK — it needs the in-sandbox "
            "veris-proxy machinery that @veris-ai/e2b carries. Use mode='gateway' (or the "
            "default 'auto'), or the TypeScript package for a control plane without the gateway.",
            phase="credentials",
        )
    if opts.mode not in ("auto", "gateway"):
        raise VerisError(
            f"unknown mode {opts.mode!r}: expected 'auto' or 'gateway'", phase="credentials"
        )
    if opts.egress not in ("strict", "open"):
        raise VerisError(
            f"unknown egress {opts.egress!r}: expected 'strict' or 'open'", phase="credentials"
        )


def resolve_coordinates(opts: VerisOpts) -> Coordinates:
    """Credentials, from the options or the environment, naming what is missing."""
    api_key = opts.api_key or os.environ.get("VERIS_API_KEY")
    if not api_key:
        raise MissingCredentialsError(
            "no Veris API key: pass veris.api_key or set VERIS_API_KEY", phase="credentials"
        )
    environment_id = opts.environment_id or os.environ.get("VERIS_ENVIRONMENT_ID")
    # Attaching names the twin directly, so it needs no environment; anything
    # that provisions one does.
    if not opts.attach_sandbox_id and not environment_id:
        raise MissingCredentialsError(
            "no Veris environment: pass veris.environment_id or set VERIS_ENVIRONMENT_ID",
            phase="credentials",
        )
    api_base = opts.api_base or os.environ.get("VERIS_API_BASE") or DEFAULT_API_BASE
    return Coordinates(api_key=api_key, api_base=api_base, environment_id=environment_id)


def ttl_minutes_for(timeout_s: int | None) -> int:
    """Twin TTL backstop for an E2B timeout: outlive the sandbox by 10 minutes."""
    return max(10, math.ceil((timeout_s or DEFAULT_TIMEOUT_S) / 60) + 10)


class Meta:
    """E2B metadata keys this package stamps, so ``connect`` can rehydrate
    without re-asking. Every one is reserved: a caller cannot set them."""

    TWIN_ID = "veris_sandbox_id"
    ENV_ID = "veris_env_id"
    API_BASE = "veris_api_base"
    MODE = "veris_mode"
    EGRESS = "veris_egress"
    OWNS_TWIN = "veris_owns_twin"
    ALLOW_OUT = "veris_allow_out"
    SNAPSHOT_ID = "veris_snapshot_id"


RESERVED_META = frozenset(
    value for key, value in vars(Meta).items() if not key.startswith("_") and isinstance(value, str)
)


def build_metadata(
    caller: Mapping[str, str] | None,
    *,
    twin_id: str,
    environment_id: str,
    api_base: str,
    egress: EgressMode,
    owns_twin: bool,
    allow_out: list[str],
    snapshot_id: str | None,
) -> dict[str, str]:
    """The caller's metadata with Veris-reserved keys stripped, plus ours."""
    out = {k: v for k, v in (caller or {}).items() if k not in RESERVED_META}
    out.update(
        {
            Meta.TWIN_ID: twin_id,
            Meta.ENV_ID: environment_id,
            Meta.API_BASE: api_base,
            Meta.MODE: "gateway",
            Meta.EGRESS: egress,
            Meta.OWNS_TWIN: str(owns_twin).lower(),
            Meta.ALLOW_OUT: json.dumps(allow_out),
        }
    )
    if snapshot_id:
        out[Meta.SNAPSHOT_ID] = snapshot_id
    return out


def read_allow_out(metadata: Mapping[str, str]) -> list[str]:
    """The allow_out list a sandbox was created with, from its metadata."""
    try:
        parsed = json.loads(metadata.get(Meta.ALLOW_OUT, "[]"))
    except ValueError:
        return []
    return [entry for entry in parsed if isinstance(entry, str)] if isinstance(parsed, list) else []


def check_caller_network(network: Mapping[str, Any] | None, twin_id: str) -> None:
    """A caller-supplied egress proxy would fight the one gateway mode installs."""
    if (network or {}).get("egress_proxy"):
        raise VerisError(
            "network.egress_proxy cannot be set on a Veris gateway-mode sandbox — Veris owns "
            "the egress proxy (pass extra allowances via veris.allow_out)",
            phase="e2b-create",
            veris_sandbox_id=twin_id,
        )


def merge_envs(
    caller: Mapping[str, str] | None,
    *,
    trust_env: Mapping[str, str],
    data_plane: Mapping[str, str],
    twin_id: str,
    install_ca: bool,
    inject_data_plane: bool,
) -> dict[str, str]:
    """Caller envs, then the Veris-managed ones.

    Veris-managed WINS: a caller value for a data-plane hint (e.g.
    ``DATABASE_URL``) would silently point the code under test at production.
    """
    out = dict(caller or {})
    if install_ca:
        out.update(trust_env)
    if inject_data_plane:
        out.update(data_plane)
    out["VERIS_SANDBOX_ID"] = twin_id
    return out


@dataclass(frozen=True)
class Rehydrated:
    """What a running sandbox's metadata says about its Veris wiring."""

    api_key: str
    api_base: str
    twin_id: str
    environment_id: str
    egress: EgressMode
    owns_twin: bool
    allow_out: list[str]


def rehydrate(
    meta: Mapping[str, str], sandbox_id: str, api_key: str | None, api_base: str | None
) -> Rehydrated:
    """Read a sandbox's Veris wiring back out of its E2B metadata.

    Where the API key is sent is decided by a trusted source — never by the
    metadata, which a compromised sandbox could rewrite to exfiltrate the key.
    """
    if not meta.get(Meta.MODE):
        raise VerisError(
            f"sandbox {sandbox_id} carries no Veris metadata — it was not created by veris-e2b",
            phase="connect",
        )
    twin_id = meta.get(Meta.TWIN_ID)
    if not twin_id:
        raise VerisError(
            f"sandbox {sandbox_id} has Veris metadata but no resolvable twin id",
            phase="connect",
            response_body=dict(meta),
        )
    key = api_key or os.environ.get("VERIS_API_KEY")
    if not key:
        raise MissingCredentialsError(
            "no Veris API key for reconnect: pass api_key or set VERIS_API_KEY",
            phase="credentials",
        )
    trusted_base = api_base or os.environ.get("VERIS_API_BASE")
    meta_base = meta.get(Meta.API_BASE)
    if trusted_base and meta_base and meta_base != trusted_base:
        raise VerisError(
            f"sandbox metadata names a different Veris control plane ({meta_base}) than your "
            f"configuration ({trusted_base}) — refusing to send the API key to an unverified host",
            phase="connect",
        )
    egress = meta.get(Meta.EGRESS, "strict")
    return Rehydrated(
        api_key=key,
        api_base=trusted_base or meta_base or DEFAULT_API_BASE,
        twin_id=twin_id,
        environment_id=meta.get(Meta.ENV_ID, ""),
        egress="open" if egress == "open" else "strict",
        owns_twin=meta.get(Meta.OWNS_TWIN) != "false",
        allow_out=read_allow_out(meta),
    )
