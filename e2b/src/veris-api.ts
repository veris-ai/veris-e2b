// The namespaced Veris surface: everything this package adds hangs off
// `sbx.veris`, matching e2b's own `sbx.commands` / `sbx.files` idiom so a
// future e2b minor can never collide with a generic method name.
import { captureBaseline, validateBaseline } from './run-receipt'
import type { ReceiptBaseline } from './run-receipt'
import { serviceControl } from './service-control'
import type { ControlOptions, ControlResource } from './service-control'
import type { Sandbox, SandboxNetworkUpdate } from 'e2b'
import type { ControlPlane, ServiceInfo } from './control-plane'
import { fetchReceiptEntry, probeCanary } from './receipt'
import type { Receipt, ReceiptEntry, ReceiptLeak } from './receipt'
import { VerisUntouchedError, VerisError } from './errors'
import { buildNetwork, callerStaticAllowOut, dataPlaneEnv, isHttpUrl } from './network'
import type { EgressMode } from './network'
import { vendoredTrustEnv } from './trust'
import { proxyTrustEnv } from './proxy-mode'

/** Everything needed to answer Veris queries about a live sandbox. */
export interface VerisContext {
  sandbox: Sandbox
  controlPlane: ControlPlane
  environmentId: string
  twinId: string
  mode: 'gateway' | 'proxy'
  egress: EgressMode
  allowOut: string[]
  /** Present in gateway mode: the reserved host the canary probe dials. */
  canaryHost?: string
  /** Present in gateway mode: the CA file path curl's --cacert uses in the canary. */
  caCertPath?: string
  /** Present in gateway mode: server-served trust env (falls back to vendored). */
  trustEnv?: Record<string, string>
  /** Whether this twin is owned (kill deletes it) or attached (caller owns it). */
  ownsTwin: boolean
}

/** Narrow assertTouched to specific requests. All fields AND together. */
export interface TouchMatcher {
  method?: string
  /** Substring match against the request path. */
  path?: string
  /** Minimum matching requests required (default 1). */
  minRequests?: number
}

export interface VerisApi {
  readonly ownsTwin: boolean
  readonly sandboxId: string
  readonly environmentId: string
  manual(service: string): Promise<string>
  readonly mode: 'gateway' | 'proxy'
  services(): Promise<ServiceInfo[]>
  receiptBaseline(): Promise<ReceiptBaseline>
  receiptSince(baseline: ReceiptBaseline, service?: string): Promise<Receipt>
  control(service: string, resource: ControlResource, options?: ControlOptions): Promise<unknown>
  receipt(): Promise<Receipt>
  receipt(service: string): Promise<ReceiptEntry>
  assertTouched(service: string, match?: TouchMatcher): Promise<void>
  getDataPlaneEnv(): Promise<Record<string, string>>
  getTrustEnv(): Promise<Record<string, string>>
  updateNetwork(net: SandboxNetworkUpdate & { detachVeris?: boolean }): Promise<void>
  deliverTo(port: number, opts?: DeliverToOpts): Promise<string>
  deliverTo(url: string | null, opts?: DeliverToOpts): Promise<string | null>
}

export interface DeliverToOpts {
  /** Verify the destination is actually reachable from the twin before
   *  returning, via each service's /veris/client/probe. Default true. */
  probe?: boolean
}

export class VerisApiImpl implements VerisApi {
  constructor(private readonly ctx: VerisContext) {}

  get ownsTwin(): boolean { return this.ctx.ownsTwin }
  get sandboxId(): string { return this.ctx.twinId }
  get environmentId(): string { return this.ctx.environmentId }
  async manual(service: string): Promise<string> {
    const body = await this.control(service, 'manual')
    return typeof body === 'string' ? body : JSON.stringify(body)
  }
  get mode(): 'gateway' | 'proxy' { return this.ctx.mode }

  services(): Promise<ServiceInfo[]> {
    return this.ctx.controlPlane.services(this.ctx.twinId)
  }

  receipt(): Promise<Receipt>
  receipt(service: string): Promise<ReceiptEntry>
  async receipt(service?: string): Promise<Receipt | ReceiptEntry> {
    // In gateway mode the canary proves egress is still tunneled before we
    // trust any count — a receipt from an un-tunneled sandbox would lie.
    await this.verifyIntegrity()
    const services = await this.services()
    if (service !== undefined) {
      const svc = services.find((s) => s.name === service)
      if (!svc) {
        throw new VerisError(
          `unknown service '${service}' — the twin has no service by that name (available: ${services.map((s) => s.name).join(', ') || 'none'})`,
          { verisSandboxId: this.ctx.twinId })
      }
      return fetchReceiptEntry(svc)
    }
    const entries = await Promise.all(
      services.filter((s) => isHttpUrl(s.control_url)).map(async (svc) => [svc.name, await fetchReceiptEntry(svc)] as const))
    // Proxy mode redirects only tcp/80+443, so QUIC/HTTP3 and ECH bypass it —
    // the same blind spots open gateway mode carries. Strict gateway mode has none.
    const leaks: ReceiptLeak[] = this.ctx.mode === 'proxy' || this.ctx.egress === 'open'
      ? ['udp-quic-possible', 'ech-possible'] : []
    return {
      services: Object.fromEntries(entries),
      mode: this.ctx.mode,
      integrity: this.ctx.mode === 'gateway' ? 'verified' : 'proxy-mode-unverified',
      leaks,
    }
  }

  private async verifyIntegrity(): Promise<void> {
    if (this.ctx.mode === 'gateway') {
      if (!this.ctx.canaryHost) throw new VerisError('gateway receipt integrity unavailable: no canary credential; reconnect before reading', { phase: 'receipt' })
      await probeCanary(this.ctx.sandbox, this.ctx.canaryHost, this.ctx.twinId, this.ctx.caCertPath)
    }
  }

  async receiptBaseline(): Promise<ReceiptBaseline> {
    await this.verifyIntegrity()
    return captureBaseline(this.ctx.twinId, this.ctx.sandbox.sandboxId,
      (await this.services()).filter(s => isHttpUrl(s.control_url)))
  }

  async receiptSince(baseline: ReceiptBaseline, service?: string): Promise<Receipt> {
    await this.verifyIntegrity()
    const services = (await this.services()).filter(s => isHttpUrl(s.control_url))
    if (service !== undefined && !services.some(s => s.name === service)) {
      throw new VerisError(`unknown HTTP service '${service}'`, { phase: 'receipt' })
    }
    await validateBaseline(baseline, this.ctx.twinId, this.ctx.sandbox.sandboxId, services)
    const selected = service === undefined ? services : services.filter(s => s.name === service)
    const entries = await Promise.all(selected.map(async svc =>
      [svc.name, await fetchReceiptEntry(svc, baseline.services[svc.name]!.id)] as const))
    // Reset during the read invalidates the whole measurement, including any
    // pages fetched before history disappeared.
    await validateBaseline(baseline, this.ctx.twinId, this.ctx.sandbox.sandboxId, await this.services().then(s => s.filter(v => isHttpUrl(v.control_url))))
    return { services: Object.fromEntries(entries), mode: this.ctx.mode, integrity: this.ctx.mode === 'gateway' ? 'verified' : 'proxy-mode-unverified',
      leaks: this.ctx.mode === 'proxy' || this.ctx.egress === 'open' ? ['udp-quic-possible', 'ech-possible'] : [] }
  }

  async control(service: string, resource: ControlResource, options?: ControlOptions): Promise<unknown> {
    const svc = (await this.services()).find(s => s.name === service)
    if (!svc) throw new VerisError(`unknown service '${service}'`)
    return serviceControl(svc, resource, options)
  }

  async assertTouched(service: string, match?: TouchMatcher): Promise<void> {
    // Throws VerisError (not VerisUntouchedError) for an unknown service — a
    // typo is a different failure from a service that saw zero traffic.
    const entry: ReceiptEntry = await this.receipt(service)
    const need = match?.minRequests ?? 1
    const matched = match
      ? entry.entries.filter((r) =>
          (match.method === undefined || r.method.toUpperCase() === match.method.toUpperCase()) &&
          (match.path === undefined || r.path.includes(match.path)))
      : entry.entries
    if (matched.length < need && entry.capped) {
      throw new VerisError(`receipt for '${service}' is incomplete; insufficient evidence`, { phase: 'receipt' })
    }
    if (matched.length < need) {
      const what = match
        ? `matching ${match.method ?? 'ANY'} ${match.path ?? '*'} (${matched.length}/${need})`
        : 'any intercepted requests'
      throw new VerisUntouchedError(
        `service '${service}' saw no ${what} — the code under test never reached it ` +
        `(a green suite that skipped its dependency looks identical to a working one)`,
        service, { verisSandboxId: this.ctx.twinId })
    }
  }

  async getDataPlaneEnv(): Promise<Record<string, string>> {
    return dataPlaneEnv(await this.services())
  }

  async getTrustEnv(): Promise<Record<string, string>> {
    // Proxy mode's CA lives under /veris/ca with its own env map — the gateway
    // vendored paths don't exist there, so read the real one from the sandbox.
    if (this.ctx.mode === 'proxy') return proxyTrustEnv(this.ctx.sandbox)
    return this.ctx.trustEnv ?? vendoredTrustEnv()
  }

  /**
   * Point every mocked vendor's callbacks/webhooks at this sandbox.
   *
   * Pass a PORT your app listens on and it resolves the sandbox's own public
   * URL (`sbx.getHost(port)`) — the address a vendor would POST to in
   * production. Pass a full URL to use that instead, or null to unregister.
   *
   * One call covers every service: a sandbox has ONE client, so the control
   * plane fans the destination out to all of them.
   *
   * The sandbox must accept public traffic for the twin to reach it — create
   * it with `allowPublicTraffic: true` if your app is going to receive
   * webhooks.
   */
  deliverTo(port: number, opts?: DeliverToOpts): Promise<string>
  deliverTo(url: string | null, opts?: DeliverToOpts): Promise<string | null>
  async deliverTo(target: number | string | null, opts: DeliverToOpts = {}): Promise<string | null> {
    const url = typeof target === 'number'
      ? `https://${this.ctx.sandbox.getHost(target)}`
      : target
    await this.ctx.controlPlane.updateSandbox(
      this.ctx.environmentId, this.ctx.twinId, { client_base_url: url })
    if (url !== null && opts.probe !== false) await this.probeDelivery(url)
    return url
  }

  /** Ask each service to re-probe the registered destination; throw if none can reach it. */
  private async probeDelivery(url: string): Promise<void> {
    const services = (await this.services()).filter((s) => isHttpUrl(s.control_url))
    if (!services.length) return
    const probes = await Promise.all(services.map(async (svc) => {
      try {
        const res = await fetch(`${svc.control_url}/veris/client/probe`, { method: 'POST' })
        return res.ok ? await res.json() as { answered?: boolean } : null
      } catch { return null }
    }))
    if (!probes.some((p) => p?.answered)) {
      throw new VerisError(
        `no service could reach ${url} — is your app listening, and was the sandbox ` +
        `created with allowPublicTraffic: true?`,
        { phase: 'receipt', verisSandboxId: this.ctx.twinId, responseBody: probes })
    }
  }

  /**
   * Safe network update: re-asserts egressProxy + allowOut unless the caller
   * explicitly detaches. This NARROWS the footgun (a raw updateNetwork clears
   * omitted fields, dropping the proxy) for the code path we control — it
   * cannot close it, since the raw REST API stays reachable with the E2B key.
   * The canary probe in receipt()/connect() is the load-bearing detection.
   */
  async updateNetwork(net: SandboxNetworkUpdate & { detachVeris?: boolean }): Promise<void> {
    const { detachVeris, ...rest } = net
    if (detachVeris || this.ctx.mode !== 'gateway') {
      return this.ctx.sandbox.updateNetwork(rest)
    }
    const credential = await this.ctx.controlPlane.mintEgressCredential(this.ctx.environmentId, this.ctx.twinId)
    if (!credential) {
      // Gateway mode was active at create but the endpoint is gone now — surface
      // the raw update rather than silently pretending we re-asserted.
      return this.ctx.sandbox.updateNetwork(rest)
    }
    // Fold the caller's static allowOut into the rebuilt allowlist rather than
    // letting `base` overwrite it — dropping their hosts would silently break
    // whatever egress they were adding.
    const callerAllow = callerStaticAllowOut(rest)
    const services = await this.services()
    const base = buildNetwork({ credential, services, mode: this.ctx.egress, allowOut: [...this.ctx.allowOut, ...callerAllow] })
    await this.ctx.sandbox.updateNetwork({ ...rest, ...base })
  }
}
