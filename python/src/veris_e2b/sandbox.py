"""The blocking Veris Sandbox: a drop-in subclass of e2b's ``Sandbox`` whose
vendor API calls are answered by a per-run Veris dependency sandbox (the
"twin"), invisibly — the code under test dials production hostnames and never
learns it was intercepted.

Interception runs in gateway mode: E2B's native egress tunnels vendor hostnames
through a Veris-operated SOCKS5 gateway that MITMs them, and nothing Veris runs
inside the sandbox but one CA file. The in-sandbox proxy fallback that
``@veris-ai/e2b`` carries is not implemented here; a control plane without the
gateway is refused loudly rather than silently un-intercepted.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from e2b import Sandbox as BaseSandbox

from ._options import (
    VerisOpts,
    build_metadata,
    check_caller_network,
    coerce_opts,
    merge_envs,
    rehydrate,
    resolve_coordinates,
    ttl_minutes_for,
    validate,
)
from .control_plane import ControlPlane, EgressCredential, TwinSandbox
from .errors import (
    TemplateUnsupportedError,
    TwinExpiredError,
    UnsupportedOperationError,
    VerisError,
    VerisGatewayNotOfferedError,
)
from .network import build_network, caller_static_allow_out, data_plane_env
from .receipt import probe_canary
from .trust import CA_CERT_PATH, CA_INSTALL_CMD, CA_TOOLING_PROBE, sanitize_trust_env
from .veris_api import VerisApi, VerisContext
from .version import SDK_VERSION

#: The CA install runs update-ca-certificates plus best-effort extras.
CA_INSTALL_TIMEOUT_S = 60.0

_NO_GATEWAY = (
    "the Veris control plane does not offer gateway mode, and the Python SDK has no "
    "in-sandbox proxy fallback — use @veris-ai/e2b (TypeScript) until the gateway is available "
    "on this control plane"
)


class Sandbox(BaseSandbox):
    """An E2B sandbox whose vendor traffic is answered by a Veris twin."""

    #: ``sbx.veris`` — the namespaced Veris surface.
    veris: VerisApi
    #: The per-run Veris (twin) sandbox id.
    veris_sandbox_id: str
    #: Which routing mode is live on this sandbox.
    veris_mode: str

    @classmethod
    def create(  # type: ignore[override]
        cls,
        template: str | None = None,
        *,
        veris: VerisOpts | Mapping[str, Any] | None = None,
        timeout: int | None = None,
        metadata: Mapping[str, str] | None = None,
        envs: Mapping[str, str] | None = None,
        network: Mapping[str, Any] | None = None,
        **opts: Any,
    ) -> Sandbox:
        """Provision a twin, then an E2B sandbox wired to it.

        Every E2B option still works; the Veris options live under ``veris`` so a
        future e2b release cannot collide with them.

        :raises VerisError: on any Veris-side failure, each naming its phase.
        """
        v = coerce_opts(veris)
        validate(v)
        coords = resolve_coordinates(v)
        control_plane = ControlPlane(
            api_key=coords.api_key, api_base=coords.api_base, sdk_version=SDK_VERSION
        )
        owns_twin = not v.attach_sandbox_id
        ttl_minutes = v.ttl_minutes or ttl_minutes_for(timeout)

        twin = cls._obtain_twin(control_plane, v, coords.environment_id, ttl_minutes)
        environment_id = coords.environment_id or twin.environment_id

        def cleanup() -> None:
            if owns_twin:
                try:
                    control_plane.delete_twin(environment_id, twin.id)
                except VerisError:
                    pass  # TTL is the backstop; the original failure is the story

        try:
            control_plane.gateway_health()
            credential = control_plane.mint_egress_credential(twin.environment_id, twin.id)
            if credential is None:
                raise VerisGatewayNotOfferedError(
                    _NO_GATEWAY, phase="credential-mint", veris_sandbox_id=twin.id
                )
            return cls._create_gateway(
                control_plane=control_plane,
                template=template,
                twin=twin,
                credential=credential,
                opts=v,
                environment_id=environment_id,
                owns_twin=owns_twin,
                timeout=timeout,
                metadata=metadata,
                envs=envs,
                network=network,
                passthrough=opts,
            )
        except BaseException:
            cleanup()
            raise

    # -- create helpers ----------------------------------------------------

    @staticmethod
    def _obtain_twin(
        control_plane: ControlPlane, v: VerisOpts, environment_id: str | None, ttl_minutes: int
    ) -> TwinSandbox:
        """The attached twin, or a freshly provisioned one at the requested state."""
        if v.attach_sandbox_id:
            existing = control_plane.get_twin(v.attach_sandbox_id)
            if existing is None:
                raise TwinExpiredError(
                    f"attach target {v.attach_sandbox_id} not found",
                    veris_sandbox_id=v.attach_sandbox_id,
                )
            if existing.status == "ready":
                return existing
            return control_plane.wait_ready(v.attach_sandbox_id)
        assert environment_id is not None  # resolve_coordinates guarantees it
        created = control_plane.create_twin(
            environment_id, ttl_minutes=ttl_minutes, snapshot_id=v.snapshot_id
        )
        try:
            return control_plane.wait_ready(created.id)
        except BaseException:
            try:
                control_plane.delete_twin(environment_id, created.id)
            except VerisError:
                pass
            raise

    @classmethod
    def _create_gateway(
        cls,
        *,
        control_plane: ControlPlane,
        template: str | None,
        twin: TwinSandbox,
        credential: EgressCredential,
        opts: VerisOpts,
        environment_id: str,
        owns_twin: bool,
        timeout: int | None,
        metadata: Mapping[str, str] | None,
        envs: Mapping[str, str] | None,
        network: Mapping[str, Any] | None,
        passthrough: Mapping[str, Any],
    ) -> Sandbox:
        check_caller_network(network, twin.id)
        services = twin.services or control_plane.services(twin.id)
        veris_net = build_network(
            credential=credential,
            services=services,
            mode=opts.egress,
            # Fold any static allow_out the caller put on network into the
            # builder, so their extra hosts survive rather than being dropped.
            allow_out=[*opts.allow_out, *caller_static_allow_out(network)],
        )
        # Preserve the caller's other network fields (allow_public_traffic,
        # rules, …); Veris owns only allow_out / deny_out / egress_proxy.
        merged_network = {**(network or {}), **veris_net}
        trust_env = sanitize_trust_env(credential.trust_env)
        merged_envs = merge_envs(
            envs,
            trust_env=trust_env,
            data_plane=data_plane_env(services),
            twin_id=twin.id,
            install_ca=opts.install_ca,
            inject_data_plane=opts.data_plane_env,
        )
        merged_metadata = build_metadata(
            metadata,
            twin_id=twin.id,
            environment_id=environment_id,
            api_base=control_plane.api_base,
            egress=opts.egress,
            owns_twin=owns_twin,
            allow_out=list(opts.allow_out),
            snapshot_id=opts.snapshot_id,
        )

        create_kwargs: dict[str, Any] = dict(passthrough)
        if timeout is not None:
            create_kwargs["timeout"] = timeout
        try:
            instance = super().create(  # type: ignore[misc]
                template,
                metadata=merged_metadata,
                envs=merged_envs,
                network=merged_network,
                **create_kwargs,
            )
        except BaseException as cause:
            # Twin cleanup belongs to create()'s wrapper; only the E2B sandbox
            # failed here, so there is nothing else to tear down.
            raise VerisError(
                "E2B sandbox create failed", phase="e2b-create", veris_sandbox_id=twin.id
            ) from cause

        try:
            # Always write the cert so the canary can --cacert it even when the
            # system-store install was declined; only the install is gated.
            _write_ca(instance, credential.ca_pem)
            if opts.install_ca:
                _install_ca(instance)
            probe_canary(instance, credential.canary_host, twin.id, CA_CERT_PATH)
        except BaseException:
            try:
                BaseSandbox.kill(instance)
            except Exception:  # noqa: BLE001 - the original failure is the story
                pass
            raise

        _attach(
            instance,
            VerisContext(
                sandbox=instance,
                control_plane=control_plane,
                environment_id=environment_id,
                twin_id=twin.id,
                egress=opts.egress,
                allow_out=list(opts.allow_out),
                owns_twin=owns_twin,
                canary_host=credential.canary_host,
                ca_cert_path=CA_CERT_PATH,
                trust_env=trust_env,
            ),
        )
        return instance

    # -- reconnecting ------------------------------------------------------

    @classmethod
    def reconnect(
        cls,
        sandbox_id: str,
        *,
        api_key: str | None = None,
        api_base: str | None = None,
        **opts: Any,
    ) -> Sandbox:
        """Reattach to a running Veris sandbox, restoring the Veris surface from
        its metadata.

        Named ``reconnect`` rather than ``connect`` because e2b's ``connect`` is
        also an instance method (resume this sandbox); overriding it would make
        one name mean two things.

        :raises TwinExpiredError: when the E2B sandbox outlived its twin.
        """
        instance = cls.connect(sandbox_id, **opts)  # type: ignore[misc]
        meta = dict(instance.get_info().metadata or {})
        wiring = rehydrate(meta, sandbox_id, api_key, api_base)
        control_plane = ControlPlane(
            api_key=wiring.api_key, api_base=wiring.api_base, sdk_version=SDK_VERSION
        )
        twin = control_plane.get_twin(wiring.twin_id)
        if twin is None or twin.status == "failed":
            raise TwinExpiredError(
                f"E2B sandbox {sandbox_id} is alive but its Veris twin {wiring.twin_id} is gone "
                f"(expired or deleted). Re-provisioning a twin under an existing E2B sandbox is "
                f"out of scope — kill and recreate.",
                veris_sandbox_id=wiring.twin_id,
            )

        # Re-assert egress in case a raw update dropped it, prove the tunnel, and
        # carry the canary host forward so receipt() keeps verifying integrity.
        credential = control_plane.mint_egress_credential(twin.environment_id, twin.id)
        canary_host = ca_cert_path = None
        trust_env = None
        if credential is not None:
            services = twin.services or control_plane.services(twin.id)
            instance.update_network(
                build_network(
                    credential=credential,
                    services=services,
                    mode=wiring.egress,
                    allow_out=wiring.allow_out,
                )
            )
            _write_ca(instance, credential.ca_pem)
            probe_canary(instance, credential.canary_host, twin.id, CA_CERT_PATH)
            canary_host = credential.canary_host
            ca_cert_path = CA_CERT_PATH
            trust_env = sanitize_trust_env(credential.trust_env)

        _attach(
            instance,
            VerisContext(
                sandbox=instance,
                control_plane=control_plane,
                environment_id=wiring.environment_id,
                twin_id=twin.id,
                egress=wiring.egress,
                allow_out=wiring.allow_out,
                owns_twin=wiring.owns_twin,
                canary_host=canary_host,
                ca_cert_path=ca_cert_path,
                trust_env=trust_env,
            ),
        )
        return instance

    # -- lifecycle ---------------------------------------------------------

    def set_timeout(self, timeout: int, **opts: Any) -> None:  # type: ignore[override]
        """Extend the E2B sandbox and the twin's TTL in lockstep.

        The twin goes first: if the E2B call then fails, the only residue is a
        harmlessly longer-lived twin, never a live sandbox whose twin expires
        under it.
        """
        try:
            self._veris_control_plane.extend_ttl(
                self._veris_environment_id, self.veris_sandbox_id, ttl_minutes_for(timeout)
            )
        except TwinExpiredError:
            # Extending a sandbox to outlive a twin that is already gone is the
            # one case the caller must hear about.
            raise
        except VerisError:
            pass
        super().set_timeout(timeout, **opts)

    def fork(self, *args: Any, **kwargs: Any):  # type: ignore[override]
        """Refused: clones would share one twin and corrupt each other's receipts."""
        raise UnsupportedOperationError(
            "fork() is unsupported on a Veris sandbox: clones would share one twin and corrupt "
            "receipts — use Sandbox.create() to provision a fresh twin",
            veris_sandbox_id=getattr(self, "veris_sandbox_id", None),
        )

    def kill(self, **opts: Any) -> bool:  # type: ignore[override]
        """Kill the E2B sandbox and delete the Veris twin (unless it was attached)."""
        if getattr(self, "_veris_owns_twin", False):
            try:
                self._veris_control_plane.delete_twin(
                    self._veris_environment_id, self.veris_sandbox_id
                )
            except VerisError:
                pass  # TTL is the backstop; killing the sandbox still matters
        return super().kill(**opts)


def _attach(instance: Any, ctx: VerisContext) -> None:
    instance.veris = VerisApi(ctx)
    instance.veris_sandbox_id = ctx.twin_id
    instance.veris_mode = ctx.mode
    instance._veris_environment_id = ctx.environment_id
    instance._veris_control_plane = ctx.control_plane
    instance._veris_owns_twin = ctx.owns_twin


def _write_ca(sandbox: Any, ca_pem: str) -> None:
    """Drop the CA on disk (so ``curl --cacert`` can use it) without touching the system store."""
    sandbox.files.write(CA_CERT_PATH, ca_pem, user="root")


def _install_ca(sandbox: Any) -> None:
    """Trust the Veris CA system-wide: probe tooling, then one root command."""
    probe = sandbox.commands.run(CA_TOOLING_PROBE, user="root")
    if "ok" not in probe.stdout:
        raise TemplateUnsupportedError(
            "template lacks ca-certificates / update-ca-certificates — cannot trust the Veris CA "
            "(use a template that ships them)",
            phase="ca-install",
        )
    sandbox.commands.run(CA_INSTALL_CMD, user="root", timeout=CA_INSTALL_TIMEOUT_S)


__all__ = ["Sandbox"]
