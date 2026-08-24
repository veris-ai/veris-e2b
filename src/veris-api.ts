// The namespaced Veris surface: everything this package adds hangs off
// `sbx.veris`, matching e2b's own `sbx.commands` / `sbx.files` idiom so a
// future e2b minor can never collide with a generic method name.
import type { Sandbox, SandboxNetworkUpdate } from 'e2b'
import type { ControlPlane, ServiceInfo } from './control-plane'
import { fetchReceiptEntry, probeCanary } from './receipt'
import type { Receipt, ReceiptEntry, ReceiptLeak } from './receipt'
import { VerisUntouchedError, VerisError } from './errors'
import { buildNetwork } from './network'
import type { EgressMode } from './network'
import { vendoredTrustEnv } from './trust'
import { verisTrustEnv } from './legacy/functions'

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
  readonly sandboxId: string
  readonly mode: 'gateway' | 'proxy'
  services(): Promise<ServiceInfo[]>
  receipt(): Promise<Receipt>
  receipt(service: string): Promise<ReceiptEntry>
  assertTouched(service: string, match?: TouchMatcher): Promise<void>
  getDataPlaneEnv(): Promise<Record<string, string>>
  getTrustEnv(): Promise<Record<string, string>>
  updateNetwork(net: SandboxNetworkUpdate & { detachVeris?: boolean }): Promise<void>
}

const isHttpUrl = (u: string) => /^https?:/.test(u)

export class VerisApiImpl implements VerisApi {
  constructor(private readonly ctx: VerisContext) {}

  get sandboxId(): string { return this.ctx.twinId }
  get mode(): 'gateway' | 'proxy' { return this.ctx.mode }

  services(): Promise<ServiceInfo[]> {
    return this.ctx.controlPlane.services(this.ctx.twinId)
  }

  receipt(): Promise<Receipt>
  receipt(service: string): Promise<ReceiptEntry>
  async receipt(service?: string): Promise<Receipt | ReceiptEntry> {
    // In gateway mode the canary proves egress is still tunneled before we
    // trust any count — a receipt from an un-tunneled sandbox would lie.
    if (this.ctx.mode === 'gateway' && this.ctx.canaryHost) {
      await probeCanary(this.ctx.sandbox, this.ctx.canaryHost, this.ctx.twinId, this.ctx.caCertPath)
    }
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
    const services = await this.services()
    const envs: Record<string, string> = {}
    for (const svc of services) {
      if (svc.env_hint && svc.url && !isHttpUrl(svc.url)) envs[svc.env_hint] = svc.url
    }
    return envs
  }

  async getTrustEnv(): Promise<Record<string, string>> {
    // Proxy mode's CA lives under /veris/ca with its own env map — the gateway
    // vendored paths don't exist there, so read the real one from the sandbox.
    if (this.ctx.mode === 'proxy') return verisTrustEnv(this.ctx.sandbox)
    return this.ctx.trustEnv ?? vendoredTrustEnv()
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
    const callerAllow = Array.isArray(rest.allowOut)
      ? rest.allowOut.filter((x): x is string => typeof x === 'string') : []
    const services = await this.services()
    const base = buildNetwork({ credential, services, mode: this.ctx.egress, allowOut: [...this.ctx.allowOut, ...callerAllow] })
    await this.ctx.sandbox.updateNetwork({ ...rest, ...base })
  }
}
