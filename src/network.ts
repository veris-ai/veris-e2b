// Builds the E2B `network` option for gateway mode: deny-all + explicit
// allowlist + egressProxy, per the one documented shape for domain filtering.
import { ALL_TRAFFIC } from 'e2b'
import type { SandboxNetworkOpts } from 'e2b'
import type { EgressCredential, ServiceInfo } from './control-plane'

export type EgressMode = 'strict' | 'open'

const isHttpUrl = (u: string) => /^https?:/.test(u)

/** Vendor hostnames the twin answers for, from the live routes the control plane serves. */
export function vendorHosts(services: ServiceInfo[]): string[] {
  const hosts = new Set<string>()
  for (const svc of services) {
    for (const r of svc.routes ?? []) hosts.add(r.host)
  }
  return [...hosts].sort()
}

/**
 * Endpoints of non-HTTP data planes (e.g. the pg-gateway a postgres DSN
 * targets). These flows are CIDR/host-matched, not domain-matched, so strict
 * mode must allow them explicitly or the data plane silently breaks.
 */
export function dataPlaneHosts(services: ServiceInfo[]): string[] {
  const hosts = new Set<string>()
  for (const svc of services) {
    if (!svc.url || isHttpUrl(svc.url)) continue
    // DSN forms like postgresql://user:pass@host:port/db — extract the host.
    const m = svc.url.match(/@\[?([A-Za-z0-9_.:-]+?)\]?(?::\d+)?\//)
    if (m?.[1]) hosts.add(m[1])
  }
  return [...hosts].sort()
}

export interface BuildNetworkArgs {
  credential: EgressCredential
  services: ServiceInfo[]
  mode: EgressMode
  /** Extra allowances merged into E2B allowOut: a hostname domain-matches
   *  (interceptable), a CIDR is IP-matched and spliced. */
  allowOut?: string[]
}

/**
 * Both modes are deny-all + allowlist (the only shape E2B documents for
 * domain filtering); they differ only in whether the list ends with a
 * catch-all. Strict is the default: it is the only mode in which the receipt
 * has no known blind spots (QUIC/HTTP3 and ECH fail closed instead of
 * silently reaching the real vendor).
 */
export function buildNetwork(args: BuildNetworkArgs): SandboxNetworkOpts {
  const { credential, services, mode, allowOut: extra = [] } = args
  const allowOut = [
    ...vendorHosts(services),
    credential.canary_host,
    ...extra,
    ...dataPlaneHosts(services),
  ]
  if (mode === 'open') allowOut.push('0.0.0.0/0')
  return {
    denyOut: [ALL_TRAFFIC],
    allowOut: [...new Set(allowOut)],
    egressProxy: {
      address: credential.socks_address,
      username: credential.username,
      password: credential.password,
    },
  }
}
