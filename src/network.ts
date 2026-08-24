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
 *
 * DSNs come in every shape — with/without credentials, with/without a trailing
 * path, redis/kafka/mongo, IPv6 in brackets, comma-separated multi-host — so we
 * parse with the URL parser (which handles all of them) and only fall back to a
 * regex for exotic non-URL forms. Every host in a multi-host DSN is allowed.
 */
export function dataPlaneHosts(services: ServiceInfo[]): string[] {
  const hosts = new Set<string>()
  for (const svc of services) {
    if (!svc.url || isHttpUrl(svc.url)) continue
    for (const h of hostsFromDsn(svc.url)) hosts.add(h)
  }
  return [...hosts].sort()
}

function hostsFromDsn(dsn: string): string[] {
  const out: string[] = []
  try {
    const u = new URL(dsn)
    // URL.hostname keeps IPv6 brackets; strip them for the allowOut entry.
    if (u.hostname) out.push(u.hostname.replace(/^\[|\]$/g, ''))
  } catch {
    // Not URL-parseable — fall through to the regex.
  }
  // Multi-host DSNs (mongodb://a:27017,b:27017/db) — the URL parser only sees
  // the first authority, so sweep the raw authority for the rest.
  const authority = dsn.replace(/^[^:]+:\/\//, '').split(/[/?]/)[0] ?? ''
  const afterAt = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority
  for (const part of afterAt.split(',')) {
    const m = part.match(/^\[?([A-Za-z0-9_.:-]+?)\]?(?::\d+)?$/)
    if (m?.[1] && !/^\d+$/.test(m[1])) out.push(m[1].replace(/^\[|\]$/g, ''))
  }
  return out
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
