// The Veris Sandbox: a drop-in subclass of e2b's Sandbox whose vendor API
// calls are answered by a per-run Veris dependency-sandbox (the "twin"),
// invisibly — the code under test dials production hostnames and never learns
// it was intercepted.
//
// Two routing modes behind one class:
//   gateway (preferred): E2B's native egress tunnels vendor hostnames through
//     a Veris-operated SOCKS5 gateway that MITMs them; nothing Veris runs in
//     the sandbox but one CA file.
//   proxy (fallback): today's verified in-sandbox veris-proxy machinery, for
//     when the control plane does not yet offer gateway mode.
import { Sandbox as BaseSandbox } from 'e2b'
import type {
  SandboxOpts as BaseSandboxOpts,
  SandboxConnectOpts as BaseConnectOpts,
  SandboxNetworkOpts,
} from 'e2b'
import { ControlPlane } from './control-plane'
import type { EgressCredential, TwinSandbox } from './control-plane'
import { VerisApiImpl } from './veris-api'
import type { VerisApi, VerisContext } from './veris-api'
import { buildNetwork } from './network'
import type { EgressMode } from './network'
import { CA_CERT_PATH, CA_INSTALL_CMD, CA_TOOLING_PROBE, sanitizeTrustEnv } from './trust'
import { probeCanary } from './receipt'
import {
  MissingCredentialsError,
  TemplateUnsupportedError,
  TwinExpiredError,
  UnsupportedOperationError,
  VerisError,
  VerisGatewayNotOfferedError,
} from './errors'
import { SDK_VERSION } from './version'
import {
  setupVeris,
  verisTeardown,
  verisSandboxId as legacyVerisSandboxId,
} from './legacy/functions'

export type VerisMode = 'auto' | 'gateway' | 'proxy'

export interface VerisOpts {
  /** Veris API key. Falls back to process.env.VERIS_API_KEY. Required. */
  apiKey?: string
  /** Veris environment the per-run twin is deployed from. Falls back to process.env.VERIS_ENVIRONMENT_ID. */
  environmentId?: string
  /** Control plane base. Falls back to process.env.VERIS_API_BASE, then 'https://api.veris.ai'. */
  apiBase?: string
  /** Attach to an EXISTING twin instead of provisioning one (advanced). kill() will NOT delete it. */
  attachSandboxId?: string
  /** Twin TTL backstop, minutes. Default: derived from timeoutMs + 10, min 10. */
  ttlMinutes?: number
  /** 'strict' (default): only vendor hosts + allowOut + data-plane egress; no QUIC/ECH leak.
   *  'open': everything egresses via the gateway (TCP), with documented UDP/ECH leaks. */
  egress?: EgressMode
  /** Extra allowances merged into allowOut. A hostname domain-matches (interceptable); a CIDR is spliced. */
  allowOut?: string[]
  /** Install the CA + inject the trust env family at create. Default true. */
  installCa?: boolean
  /** Inject { [env_hint]: dsn } for non-HTTP twin services. Default true; caller envs win. */
  dataPlaneEnv?: boolean
  /** 'auto' (default): gateway when offered to this SDK version, else proxy (loud). 'gateway'/'proxy' force one. */
  mode?: VerisMode
}

export type SandboxOpts = BaseSandboxOpts & { veris?: VerisOpts }
export type SandboxConnectOpts = BaseConnectOpts & { veris?: Pick<VerisOpts, 'apiKey' | 'apiBase'> }

interface ResolvedCoordinates {
  apiKey: string
  environmentId?: string
  apiBase: string
}

function resolveCoordinates(v: VerisOpts, requireEnv: boolean): ResolvedCoordinates {
  const apiKey = v.apiKey ?? process.env.VERIS_API_KEY
  if (!apiKey) {
    throw new MissingCredentialsError(
      'no Veris API key: pass veris.apiKey or set VERIS_API_KEY', { phase: 'credentials' })
  }
  const environmentId = v.environmentId ?? process.env.VERIS_ENVIRONMENT_ID
  if (requireEnv && !environmentId) {
    throw new MissingCredentialsError(
      'no Veris environment: pass veris.environmentId or set VERIS_ENVIRONMENT_ID', { phase: 'credentials' })
  }
  const apiBase = v.apiBase ?? process.env.VERIS_API_BASE ?? 'https://api.veris.ai'
  return { apiKey, environmentId, apiBase }
}

// E2B metadata keys the class stamps so connect() can rehydrate without re-asking.
const META = {
  twinId: 'veris_sandbox_id',
  envId: 'veris_env_id',
  apiBase: 'veris_api_base',
  mode: 'veris_mode',
  egress: 'veris_egress',
} as const

export class Sandbox extends BaseSandbox {
  /** Namespaced Veris surface — collision-proof against future e2b minors. */
  declare readonly veris: VerisApi
  /** The per-run Veris (twin) sandbox id. */
  declare readonly verisSandboxId: string
  /** Which routing mode is live on this sandbox. */
  declare readonly verisMode: 'gateway' | 'proxy'

  /** @internal the environment the twin belongs to (for TTL-extend and delete). */
  declare _verisEnvironmentId: string
  /** @internal */
  declare _verisControlPlane: ControlPlane
  /** @internal */
  declare _verisOwnsTwin: boolean

  static override async create<S extends typeof BaseSandbox>(this: S, opts?: SandboxOpts): Promise<InstanceType<S>>
  static override async create<S extends typeof BaseSandbox>(this: S, template: string, opts?: SandboxOpts): Promise<InstanceType<S>>
  static override async create<S extends typeof BaseSandbox>(
    this: S,
    templateOrOpts?: string | SandboxOpts,
    maybeOpts?: SandboxOpts,
  ): Promise<InstanceType<S>> {
    const template = typeof templateOrOpts === 'string' ? templateOrOpts : undefined
    const opts: SandboxOpts = (typeof templateOrOpts === 'string' ? maybeOpts : templateOrOpts) ?? {}
    const v = opts.veris ?? {}
    const mode: VerisMode = v.mode ?? 'auto'

    const coords = resolveCoordinates(v, /* requireEnv */ !v.attachSandboxId)
    const controlPlane = new ControlPlane({ apiKey: coords.apiKey, apiBase: coords.apiBase, sdkVersion: SDK_VERSION })

    // Provision (or attach to) the twin first, host-side: the E2B create needs
    // the twin's vendor-host list and — in gateway mode — its SOCKS credential.
    const ownsTwin = !v.attachSandboxId
    const ttlMinutes = v.ttlMinutes ?? Math.max(10, Math.ceil((opts.timeoutMs ?? 300_000) / 60_000) + 10)
    let twin: TwinSandbox
    if (v.attachSandboxId) {
      const existing = await controlPlane.getTwin(v.attachSandboxId)
      if (!existing) throw new TwinExpiredError(`attach target ${v.attachSandboxId} not found`, { verisSandboxId: v.attachSandboxId })
      twin = existing.status === 'ready' ? existing : await controlPlane.waitReady(v.attachSandboxId, 240_000)
    } else {
      const created = await controlPlane.createTwin(coords.environmentId!, { ttlMinutes })
      twin = await controlPlane.waitReady(created.id, 240_000)
    }

    // Decide gateway vs proxy. In 'auto'/'gateway' we ask the control plane for
    // an egress credential; a 404 (endpoint absent) means "not offered".
    let credential: EgressCredential | null = null
    if (mode === 'gateway' || mode === 'auto') {
      await controlPlane.gatewayHealth().catch((e) => {
        if (mode === 'gateway') throw e
        return undefined // auto: a health failure just means fall to proxy
      })
      credential = await controlPlane.mintEgressCredential(twin.id).catch((e) => {
        if (mode === 'gateway') throw e
        if (e instanceof VerisGatewayNotOfferedError) return null
        throw e
      })
      if (mode === 'gateway' && !credential) {
        if (ownsTwin) await controlPlane.deleteTwin(coords.environmentId!, twin.id).catch(() => {})
        throw new VerisGatewayNotOfferedError(
          'control plane does not offer egress credentials yet — gateway mode is unavailable (use mode: "auto" to fall back to proxy)',
          { phase: 'credential-mint', verisSandboxId: twin.id })
      }
    }

    const egress: EgressMode = v.egress ?? 'strict'
    const allowOut = v.allowOut ?? []

    if (credential) {
      return createGateway(this, {
        template, opts, coords, controlPlane, twin, credential, egress, allowOut,
        ownsTwin, installCaOpt: v.installCa !== false, dataPlaneEnv: v.dataPlaneEnv !== false,
      })
    }

    // Proxy mode (auto fell back, or forced). Loud, because guarantees differ.
    process.emitWarning(
      `@veris-ai/e2b: gateway mode unavailable — falling back to in-sandbox proxy mode. ` +
      `Interception uses the legacy nftables path; receipt integrity is unverifiable in this mode.`,
      { code: 'VERIS_MODE_FALLBACK' })
    return createProxy(this, {
      template, opts, coords, controlPlane, twin, environmentId: coords.environmentId!,
      egress, allowOut, ownsTwin,
    })
  }

  static override async connect<S extends typeof BaseSandbox>(
    this: S, sandboxId: string, opts?: SandboxConnectOpts,
  ): Promise<InstanceType<S>> {
    const instance = await (BaseSandbox.connect as (id: string, o?: BaseConnectOpts) => Promise<InstanceType<S>>)
      .call(this, sandboxId, stripVerisConnect(opts))
    const info = await instance.getInfo()
    const meta = info.metadata ?? {}
    const twinId = meta[META.twinId]
    const mode = (meta[META.mode] as 'gateway' | 'proxy' | undefined) ?? (twinId ? 'gateway' : undefined)
    if (!twinId || !mode) {
      throw new VerisError(
        `sandbox ${sandboxId} carries no Veris metadata — it was not created by @veris-ai/e2b`,
        { phase: 'connect' })
    }
    const apiKey = opts?.veris?.apiKey ?? process.env.VERIS_API_KEY
    if (!apiKey) throw new MissingCredentialsError('no Veris API key for connect: pass veris.apiKey or set VERIS_API_KEY', { phase: 'credentials' })
    // A trusted source decides where the API key is sent — NEVER the sandbox
    // metadata, which a compromised sandbox could rewrite to exfiltrate the key.
    // The baked api_base is only honored when the caller supplied none of their
    // own AND it matches, otherwise it is ignored.
    const trustedBase = opts?.veris?.apiBase ?? process.env.VERIS_API_BASE
    const metaBase = meta[META.apiBase]
    if (trustedBase && metaBase && metaBase !== trustedBase) {
      throw new VerisError(
        `sandbox metadata names a different Veris control plane (${metaBase}) than your configuration (${trustedBase}) — refusing to send the API key to an unverified host`,
        { phase: 'connect' })
    }
    const apiBase = trustedBase ?? metaBase ?? 'https://api.veris.ai'
    const environmentId = meta[META.envId] ?? ''
    const egress = (meta[META.egress] as EgressMode | undefined) ?? 'strict'
    const controlPlane = new ControlPlane({ apiKey, apiBase, sdkVersion: SDK_VERSION })

    // Verify the twin is actually alive — a resumed-after-pause sandbox may
    // have outlived its twin's TTL.
    const twin = await controlPlane.getTwin(twinId)
    if (!twin || twin.status === 'failed') {
      throw new TwinExpiredError(
        `E2B sandbox ${sandboxId} is alive but its Veris twin ${twinId} is gone (expired or deleted). ` +
        `Re-provisioning a twin under an existing E2B sandbox is out of scope for v2.0 — kill and recreate.`,
        { verisSandboxId: twinId })
    }

    attachVeris(instance, {
      controlPlane, environmentId, twinId, mode, egress, allowOut: [], ownsTwin: true,
    })

    // In gateway mode, re-assert egress in case a raw update dropped it, then
    // prove the tunnel with the canary.
    if (mode === 'gateway') {
      const credential = await controlPlane.mintEgressCredential(twinId)
      if (credential) {
        const services = await controlPlane.services(twinId)
        await instance.updateNetwork(buildNetwork({ credential, services, mode: egress, allowOut: [] }))
        // The cert already lives in the resumed snapshot's store; write a fresh
        // copy for --cacert in case this is a cold resume.
        await writeCa(instance, credential.ca_pem)
        await probeCanary(instance, credential.canary_host, twinId, CA_CERT_PATH)
      }
    }
    return instance
  }

  /** Extend the E2B sandbox timeout AND the twin's TTL in lockstep. The twin
   *  is extended FIRST, so if the E2B call then fails the only residue is a
   *  harmlessly longer-lived twin — never a live sandbox whose twin expires
   *  under it. */
  override async setTimeout(timeoutMs: number, opts?: Parameters<BaseSandbox['setTimeout']>[1]): Promise<void> {
    const ttlMinutes = Math.max(10, Math.ceil(timeoutMs / 60_000) + 10)
    await this._verisControlPlane.extendTtl(this._verisEnvironmentId, this.verisSandboxId, ttlMinutes).catch(() => {})
    await super.setTimeout(timeoutMs, opts)
  }

  /** Forking would copy this sandbox's metadata and network config, pointing
   *  every clone at ONE shared twin and credential — breaking the
   *  one-sandbox-one-twin invariant receipts depend on. Refused; provision a
   *  fresh Veris sandbox with create() instead. */
  override fork(): never {
    throw new UnsupportedOperationError(
      'fork() is unsupported on a Veris sandbox: clones would share one twin and corrupt receipts — use Sandbox.create() to provision a fresh twin',
      { verisSandboxId: this.verisSandboxId })
  }

  /** Kill the E2B sandbox AND delete the Veris twin (unless it was attached). */
  override async kill(opts?: Parameters<BaseSandbox['kill']>[0]): Promise<boolean> {
    if (this.verisMode === 'proxy') {
      await verisTeardown(this).catch(() => {})
    }
    if (this._verisOwnsTwin) {
      await this._verisControlPlane.deleteTwin(this._verisEnvironmentId, this.verisSandboxId).catch(() => {})
    }
    return super.kill(opts)
  }
}

export default Sandbox

// ---- module-level helpers (kept off the class so the subclass static side
//      stays assignable to e2b's Sandbox — private statics would break it) ----

function attachVeris(instance: BaseSandbox, ctx: Omit<VerisContext, 'sandbox'>): void {
  const veris = new VerisApiImpl({ ...ctx, sandbox: instance })
  Object.defineProperties(instance, {
    veris: { value: veris, enumerable: true },
    verisSandboxId: { value: ctx.twinId, enumerable: true },
    verisMode: { value: ctx.mode, enumerable: true },
    _verisEnvironmentId: { value: ctx.environmentId },
    _verisControlPlane: { value: ctx.controlPlane },
    _verisOwnsTwin: { value: ctx.ownsTwin, writable: true },
  })
}

async function createGateway<S extends typeof BaseSandbox>(
  Ctor: S,
  p: {
    template?: string; opts: SandboxOpts; coords: ResolvedCoordinates; controlPlane: ControlPlane
    twin: TwinSandbox; credential: EgressCredential; egress: EgressMode; allowOut: string[]
    ownsTwin: boolean; installCaOpt: boolean; dataPlaneEnv: boolean
  },
): Promise<InstanceType<S>> {
  // A caller-supplied egressProxy would fight the one this mode installs;
  // refuse rather than silently clobber. Other network fields (their own
  // allowOut additions) are folded in.
  if (p.opts.network?.egressProxy) {
    throw new VerisError(
      'network.egressProxy cannot be set on a Veris gateway-mode sandbox — Veris owns the egress proxy (pass extra allowances via veris.allowOut)',
      { phase: 'e2b-create', verisSandboxId: p.twin.id })
  }
  const services = await p.controlPlane.services(p.twin.id)
  const network: SandboxNetworkOpts = buildNetwork({
    credential: p.credential, services, mode: p.egress, allowOut: p.allowOut,
  })

  // A control-plane response must never become arbitrary env injection: only
  // known trust vars with path-shaped values survive.
  const trustEnv = sanitizeTrustEnv(p.credential.trust_env)
  // Veris-managed vars WIN over caller envs — a caller value for a data-plane
  // env_hint (e.g. DATABASE_URL) would silently point tests at production.
  const verisManaged: Record<string, string> = { ...(p.installCaOpt ? trustEnv : {}), VERIS_SANDBOX_ID: p.twin.id }
  if (p.dataPlaneEnv) {
    for (const svc of services) {
      if (svc.env_hint && svc.url && !/^https?:/.test(svc.url)) verisManaged[svc.env_hint] = svc.url
    }
  }
  const mergedEnvs = { ...(p.opts.envs ?? {}), ...verisManaged }
  const metadata = {
    ...(p.opts.metadata ?? {}),
    [META.twinId]: p.twin.id, [META.envId]: p.coords.environmentId ?? p.twin.environment_id,
    [META.apiBase]: p.coords.apiBase, [META.mode]: 'gateway', [META.egress]: p.egress,
  }

  const baseOpts: BaseSandboxOpts = { ...stripVeris(p.opts), envs: mergedEnvs, network, metadata }
  let instance: InstanceType<S>
  try {
    instance = p.template !== undefined
      ? await (BaseSandbox.create as (t: string, o: BaseSandboxOpts) => Promise<InstanceType<S>>).call(Ctor, p.template, baseOpts)
      : await (BaseSandbox.create as (o: BaseSandboxOpts) => Promise<InstanceType<S>>).call(Ctor, baseOpts)
  } catch (cause) {
    if (p.ownsTwin) await p.controlPlane.deleteTwin(p.coords.environmentId!, p.twin.id).catch(() => {})
    throw new VerisError('E2B sandbox create failed', { phase: 'e2b-create', verisSandboxId: p.twin.id, cause })
  }

  try {
    // Always write the cert so the canary can --cacert it even when the
    // system-store install was declined; only update-ca-certificates is gated.
    await writeCa(instance, p.credential.ca_pem)
    if (p.installCaOpt) await installCa(instance)
    await probeCanary(instance, p.credential.canary_host, p.twin.id, CA_CERT_PATH)
  } catch (err) {
    await instance.kill().catch(() => {})
    if (p.ownsTwin) await p.controlPlane.deleteTwin(p.coords.environmentId!, p.twin.id).catch(() => {})
    throw err
  }

  attachVeris(instance, {
    controlPlane: p.controlPlane, environmentId: p.coords.environmentId ?? p.twin.environment_id,
    twinId: p.twin.id, mode: 'gateway', egress: p.egress, allowOut: p.allowOut,
    canaryHost: p.credential.canary_host, trustEnv, ownsTwin: p.ownsTwin,
  })
  return instance
}

async function createProxy<S extends typeof BaseSandbox>(
  Ctor: S,
  p: {
    template?: string; opts: SandboxOpts; coords: ResolvedCoordinates; controlPlane: ControlPlane
    twin: TwinSandbox; environmentId: string; egress: EgressMode; allowOut: string[]; ownsTwin: boolean
  },
): Promise<InstanceType<S>> {
  // Proxy mode deploys the twin from inside the sandbox via veris-proxy, so the
  // pre-created twin above is discarded here and setupVeris drives the in-box
  // flow — kept faithful to the verified v1 machinery.
  if (p.ownsTwin) {
    await p.controlPlane.deleteTwin(p.environmentId, p.twin.id).catch(() => {})
  }
  const metadata = { ...(p.opts.metadata ?? {}), [META.mode]: 'proxy', [META.apiBase]: p.coords.apiBase, [META.envId]: p.environmentId }
  const baseOpts: BaseSandboxOpts = { ...stripVeris(p.opts), metadata }
  const instance = p.template !== undefined
    ? await (BaseSandbox.create as (t: string, o: BaseSandboxOpts) => Promise<InstanceType<S>>).call(Ctor, p.template, baseOpts)
    : await (BaseSandbox.create as (o: BaseSandboxOpts) => Promise<InstanceType<S>>).call(Ctor, baseOpts)

  try {
    await setupVeris(instance, {
      apiKey: p.coords.apiKey, environmentId: p.environmentId, apiBase: p.coords.apiBase,
    })
  } catch (err) {
    await instance.kill().catch(() => {})
    throw err
  }
  const twinId = await legacyVerisSandboxId(instance)
  attachVeris(instance, {
    controlPlane: p.controlPlane, environmentId: p.environmentId, twinId, mode: 'proxy',
    egress: p.egress, allowOut: p.allowOut, ownsTwin: true,
  })
  return instance
}

function stripVeris(opts: SandboxOpts): BaseSandboxOpts {
  const { veris: _veris, ...rest } = opts
  return rest
}
function stripVerisConnect(opts?: SandboxConnectOpts): BaseConnectOpts | undefined {
  if (!opts) return undefined
  const { veris: _veris, ...rest } = opts
  return rest
}

/** Drop the CA cert on disk (so curl --cacert can use it) without touching the system store. */
async function writeCa(sandbox: BaseSandbox, caPem: string): Promise<void> {
  await sandbox.files.write([{ path: CA_CERT_PATH, data: caPem }], { user: 'root' })
}

/** Trust the Veris CA system-wide: probe tooling, then one root command. */
async function installCa(sandbox: BaseSandbox): Promise<void> {
  const probe = await sandbox.commands.run(CA_TOOLING_PROBE, { user: 'root' })
  if (!probe.stdout.includes('ok')) {
    throw new TemplateUnsupportedError(
      'template lacks ca-certificates / update-ca-certificates — cannot trust the Veris CA (use a template that ships them)',
      { phase: 'ca-install' })
  }
  await sandbox.commands.run(CA_INSTALL_CMD, { user: 'root', timeoutMs: 60_000 })
}
