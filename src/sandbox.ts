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
  setupProxy,
  proxyTeardown,
  proxySandboxId,
} from './proxy-mode'

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
  ownsTwin: 'veris_owns_twin',
  allowOut: 'veris_allow_out',
} as const

/** All keys the class reserves in E2B metadata. */
const VERIS_META_KEYS: readonly string[] = Object.values(META)

function warnProxyFallback(reason: string): void {
  process.emitWarning(
    `@veris-ai/e2b: using in-sandbox proxy mode (${reason}). Interception is the legacy ` +
    `nftables path; receipt integrity is unverifiable and QUIC/ECH bypass it.`,
    { code: 'VERIS_PROXY_MODE' })
}

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
    const egress: EgressMode = v.egress ?? 'strict'
    const allowOut = v.allowOut ?? []

    const coords = resolveCoordinates(v, /* requireEnv */ mode === 'proxy' ? true : !v.attachSandboxId)
    const controlPlane = new ControlPlane({ apiKey: coords.apiKey, apiBase: coords.apiBase, sdkVersion: SDK_VERSION })

    // Explicit proxy mode never touches the gateway path and never
    // pre-provisions a twin (proxy deploys its own, in-sandbox). attach is a
    // gateway-only feature — refuse it here rather than silently ignoring it.
    if (mode === 'proxy') {
      if (v.attachSandboxId) {
        throw new VerisError('attachSandboxId is only supported in gateway mode', { phase: 'credentials' })
      }
      warnProxyFallback('mode: "proxy"')
      return createProxy(this, {
        template, opts, coords, controlPlane, environmentId: coords.environmentId!, egress, allowOut,
      })
    }

    // gateway | auto: provision the twin first — the E2B create needs its
    // vendor-host list and SOCKS credential. Everything from here is wrapped so
    // any failure deletes the twin we created (only the TTL backstop otherwise).
    const ownsTwin = !v.attachSandboxId
    const ttlMinutes = v.ttlMinutes ?? Math.max(10, Math.ceil((opts.timeoutMs ?? 300_000) / 60_000) + 10)
    let twin: TwinSandbox
    if (v.attachSandboxId) {
      const existing = await controlPlane.getTwin(v.attachSandboxId)
      if (!existing) throw new TwinExpiredError(`attach target ${v.attachSandboxId} not found`, { verisSandboxId: v.attachSandboxId })
      twin = existing.status === 'ready' ? existing : await controlPlane.waitReady(v.attachSandboxId, 240_000)
    } else {
      const created = await controlPlane.createTwin(coords.environmentId!, { ttlMinutes })
      try {
        twin = await controlPlane.waitReady(created.id, 240_000)
      } catch (e) {
        await controlPlane.deleteTwin(coords.environmentId!, created.id).catch(() => {})
        throw e
      }
    }

    const cleanupTwin = async () => { if (ownsTwin) await controlPlane.deleteTwin(coords.environmentId!, twin.id).catch(() => {}) }

    let credential: EgressCredential | null = null
    try {
      // Gateway health: fatal in gateway mode; in auto a failure just means the
      // gateway is degraded — fall through to proxy WITHOUT minting.
      let gatewayHealthy = true
      try {
        await controlPlane.gatewayHealth()
      } catch (e) {
        if (mode === 'gateway') throw e
        gatewayHealthy = false
      }
      if (gatewayHealthy) {
        credential = await controlPlane.mintEgressCredential(twin.environment_id, twin.id).catch((e) => {
          if (mode === 'gateway') throw e
          if (e instanceof VerisGatewayNotOfferedError) return null // auto: fall back
          throw e
        })
      }
      if (mode === 'gateway' && !credential) {
        throw new VerisGatewayNotOfferedError(
          'control plane does not offer egress credentials yet — gateway mode is unavailable (use mode: "auto" to fall back to proxy)',
          { phase: 'credential-mint', verisSandboxId: twin.id })
      }
    } catch (e) {
      await cleanupTwin()
      throw e
    }

    if (credential) {
      // createGateway owns E2B-sandbox teardown on post-create failure; twin
      // cleanup on any of its throws is handled here.
      try {
        return await createGateway(this, {
          template, opts, coords, controlPlane, twin, credential, egress, allowOut,
          ownsTwin, installCaOpt: v.installCa !== false, dataPlaneEnv: v.dataPlaneEnv !== false,
        })
      } catch (e) {
        await cleanupTwin()
        throw e
      }
    }

    // auto fell back to proxy: the pre-provisioned twin is unused (proxy
    // re-provisions in-sandbox), so drop it, then run the proxy path.
    if (v.attachSandboxId) {
      await cleanupTwin()
      throw new VerisGatewayNotOfferedError(
        'gateway mode is unavailable and attachSandboxId cannot be honored in proxy mode — retry without attach or once the gateway ships',
        { phase: 'credential-mint', verisSandboxId: twin.id })
    }
    await cleanupTwin()
    warnProxyFallback('gateway mode unavailable')
    return createProxy(this, {
      template, opts, coords, controlPlane, environmentId: coords.environmentId!, egress, allowOut,
    })
  }

  static override async connect<S extends typeof BaseSandbox>(
    this: S, sandboxId: string, opts?: SandboxConnectOpts,
  ): Promise<InstanceType<S>> {
    const instance = await (BaseSandbox.connect as (id: string, o?: BaseConnectOpts) => Promise<InstanceType<S>>)
      .call(this, sandboxId, stripVerisConnect(opts))
    const info = await instance.getInfo()
    const meta = info.metadata ?? {}
    const mode = meta[META.mode] as 'gateway' | 'proxy' | undefined
    if (!mode) {
      throw new VerisError(
        `sandbox ${sandboxId} carries no Veris metadata — it was not created by @veris-ai/e2b`,
        { phase: 'connect' })
    }
    const apiKey = opts?.veris?.apiKey ?? process.env.VERIS_API_KEY
    if (!apiKey) throw new MissingCredentialsError('no Veris API key for connect: pass veris.apiKey or set VERIS_API_KEY', { phase: 'credentials' })
    // A trusted source decides where the API key is sent — NEVER the sandbox
    // metadata, which a compromised sandbox could rewrite to exfiltrate the key.
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
    const ownsTwin = meta[META.ownsTwin] !== 'false'
    let allowOut: string[] = []
    try { const parsed = JSON.parse(meta[META.allowOut] ?? '[]'); if (Array.isArray(parsed)) allowOut = parsed } catch { /* keep [] */ }
    const controlPlane = new ControlPlane({ apiKey, apiBase, sdkVersion: SDK_VERSION })

    // Proxy mode never stamped a twin id into metadata (it isn't known until the
    // in-sandbox proxy is up) — read it back from the running proxy's log.
    let twinId = meta[META.twinId]
    if (!twinId && mode === 'proxy') {
      twinId = await proxySandboxId(instance).catch(() => '')
    }
    if (!twinId) {
      throw new VerisError(`sandbox ${sandboxId} has Veris metadata but no resolvable twin id`, { phase: 'connect', responseBody: meta })
    }

    // Verify the twin is actually alive — a resumed-after-pause sandbox may
    // have outlived its twin's TTL.
    const twin = await controlPlane.getTwin(twinId)
    if (!twin || twin.status === 'failed') {
      throw new TwinExpiredError(
        `E2B sandbox ${sandboxId} is alive but its Veris twin ${twinId} is gone (expired or deleted). ` +
        `Re-provisioning a twin under an existing E2B sandbox is out of scope for v2.0 — kill and recreate.`,
        { verisSandboxId: twinId })
    }

    // Gateway mode: re-assert egress in case a raw update dropped it, prove the
    // tunnel, and carry the canary host into the context so receipt() can keep
    // verifying integrity.
    let canaryHost: string | undefined
    let caCertPath: string | undefined
    let trustEnv: Record<string, string> | undefined
    if (mode === 'gateway') {
      const credential = await controlPlane.mintEgressCredential(twin.environment_id, twinId)
      if (credential) {
        const services = await controlPlane.services(twinId)
        await instance.updateNetwork(buildNetwork({ credential, services, mode: egress, allowOut }))
        await writeCa(instance, credential.ca_pem)
        await probeCanary(instance, credential.canary_host, twinId, CA_CERT_PATH)
        canaryHost = credential.canary_host
        caCertPath = CA_CERT_PATH
        trustEnv = sanitizeTrustEnv(credential.trust_env)
      }
    }

    attachVeris(instance, {
      controlPlane, environmentId, twinId, mode, egress, allowOut, ownsTwin, canaryHost, caCertPath, trustEnv,
    })
    return instance
  }

  /** Extend the E2B sandbox timeout AND the twin's TTL in lockstep. The twin
   *  is extended FIRST, so if the E2B call then fails the only residue is a
   *  harmlessly longer-lived twin — never a live sandbox whose twin expires
   *  under it. */
  override async setTimeout(timeoutMs: number, opts?: Parameters<BaseSandbox['setTimeout']>[1]): Promise<void> {
    const ttlMinutes = Math.max(10, Math.ceil(timeoutMs / 60_000) + 10)
    // Swallow transient extend failures, but let a dead twin surface — extending
    // the E2B sandbox to outlive a twin that is already gone is the one case the
    // caller must hear about.
    await this._verisControlPlane.extendTtl(this._verisEnvironmentId, this.verisSandboxId, ttlMinutes)
      .catch((e) => { if (e instanceof TwinExpiredError) throw e })
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

  /** Static fork has the same hazard as the instance method, and its clones
   *  would carry Veris metadata with no wired-up `veris` surface. Refused. */
  static override async fork(): Promise<never> {
    throw new UnsupportedOperationError(
      'Sandbox.fork() is unsupported: each Veris sandbox owns exactly one twin — use Sandbox.create() to provision a fresh one')
  }

  /** Kill the E2B sandbox AND delete the Veris twin (unless it was attached). */
  override async kill(opts?: Parameters<BaseSandbox['kill']>[0]): Promise<boolean> {
    if (this.verisMode === 'proxy') {
      await proxyTeardown(this).catch(() => {})
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
  const verisNet = buildNetwork({
    // Fold any static allowOut the caller put on opts.network into the builder,
    // so their extra hosts survive rather than being silently dropped.
    credential: p.credential, services, mode: p.egress,
    allowOut: [...p.allowOut, ...callerStaticAllowOut(p.opts.network)],
  })
  // Preserve the caller's other network fields (allowPublicTraffic, rules, …);
  // Veris owns only allowOut / denyOut / egressProxy.
  const network: SandboxNetworkOpts = { ...(p.opts.network ?? {}), ...verisNet }

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
    ...reserveMeta(p.opts.metadata),
    [META.twinId]: p.twin.id, [META.envId]: p.coords.environmentId ?? p.twin.environment_id,
    [META.apiBase]: p.coords.apiBase, [META.mode]: 'gateway', [META.egress]: p.egress,
    [META.ownsTwin]: String(p.ownsTwin), [META.allowOut]: JSON.stringify(p.allowOut),
  }

  const baseOpts: BaseSandboxOpts = { ...stripVeris(p.opts), envs: mergedEnvs, network, metadata }
  let instance: InstanceType<S>
  try {
    instance = p.template !== undefined
      ? await (BaseSandbox.create as (t: string, o: BaseSandboxOpts) => Promise<InstanceType<S>>).call(Ctor, p.template, baseOpts)
      : await (BaseSandbox.create as (o: BaseSandboxOpts) => Promise<InstanceType<S>>).call(Ctor, baseOpts)
  } catch (cause) {
    // Twin cleanup is owned by create()'s wrapper; here we only failed to make
    // the E2B sandbox, so there is nothing else to tear down.
    throw new VerisError('E2B sandbox create failed', { phase: 'e2b-create', verisSandboxId: p.twin.id, cause })
  }

  try {
    // Always write the cert so the canary can --cacert it even when the
    // system-store install was declined; only update-ca-certificates is gated.
    await writeCa(instance, p.credential.ca_pem)
    if (p.installCaOpt) await installCa(instance)
    await probeCanary(instance, p.credential.canary_host, p.twin.id, CA_CERT_PATH)
  } catch (err) {
    await instance.kill().catch(() => {}) // twin cleanup is create()'s wrapper
    throw err
  }

  attachVeris(instance, {
    controlPlane: p.controlPlane, environmentId: p.coords.environmentId ?? p.twin.environment_id,
    twinId: p.twin.id, mode: 'gateway', egress: p.egress, allowOut: p.allowOut,
    canaryHost: p.credential.canary_host, caCertPath: CA_CERT_PATH, trustEnv, ownsTwin: p.ownsTwin,
  })
  return instance
}

async function createProxy<S extends typeof BaseSandbox>(
  Ctor: S,
  p: {
    template?: string; opts: SandboxOpts; coords: ResolvedCoordinates; controlPlane: ControlPlane
    environmentId: string; egress: EgressMode; allowOut: string[]
  },
): Promise<InstanceType<S>> {
  // Proxy mode deploys its twin from inside the sandbox via veris-proxy. The
  // twin id is not known until then, so it is read back from the running proxy
  // (and by connect() the same way) rather than stamped into metadata.
  const metadata = {
    ...reserveMeta(p.opts.metadata),
    [META.mode]: 'proxy', [META.apiBase]: p.coords.apiBase, [META.envId]: p.environmentId,
    [META.ownsTwin]: 'true',
  }
  const baseOpts: BaseSandboxOpts = { ...stripVeris(p.opts), metadata }
  const instance = p.template !== undefined
    ? await (BaseSandbox.create as (t: string, o: BaseSandboxOpts) => Promise<InstanceType<S>>).call(Ctor, p.template, baseOpts)
    : await (BaseSandbox.create as (o: BaseSandboxOpts) => Promise<InstanceType<S>>).call(Ctor, baseOpts)

  let twinId: string
  try {
    await setupProxy(instance, {
      apiKey: p.coords.apiKey, environmentId: p.environmentId, apiBase: p.coords.apiBase,
    })
    twinId = await proxySandboxId(instance)
  } catch (err) {
    // Kill the E2B sandbox; the in-box twin (if it came up) is reclaimed by TTL.
    await instance.kill().catch(() => {})
    throw err
  }
  attachVeris(instance, {
    controlPlane: p.controlPlane, environmentId: p.environmentId, twinId, mode: 'proxy',
    egress: p.egress, allowOut: p.allowOut, ownsTwin: true,
  })
  return instance
}

/** Static allowOut entries the caller put on opts.network, if it's an array. */
function callerStaticAllowOut(net: SandboxNetworkOpts | undefined): string[] {
  const a = net?.allowOut
  return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []
}

/** Strip any Veris-reserved keys a caller tried to set in metadata. */
function reserveMeta(metadata: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(metadata ?? {})) {
    if (!VERIS_META_KEYS.includes(k)) out[k] = val
  }
  return out
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
