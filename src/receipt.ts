// The receipt: what the twin actually received, parsed from each service's
// /veris/requests log — plus the canary probe that keeps a gateway-mode
// receipt honest.
import type { Sandbox } from 'e2b'
import { ReceiptIntegrityError } from './errors'
import type { ServiceInfo } from './control-plane'

/** One intercepted request, from the twin's trace log. */
export interface ReceiptRequest {
  method: string
  path: string
  /** null = no response sent (fault hang). */
  status: number | null
}

export interface ReceiptEntry {
  /** Count of intercepted requests (real JSON parse, not a regex). */
  requests: number
  /** The twin service's /veris/* control plane. */
  controlUrl: string
  /** Typed request list, newest first. */
  entries: ReceiptRequest[]
  /** Verbatim /veris/requests body. */
  raw: unknown
}

export type ReceiptLeak = 'udp-quic-possible' | 'ech-possible'

export interface Receipt {
  /** Keyed by service name. Partial: indexing an absent service is a type
   *  error to handle, not a runtime TypeError to discover. */
  services: Partial<Record<string, ReceiptEntry>>
  /** Which routing mode produced this receipt — the guarantees differ. */
  mode: 'gateway' | 'proxy'
  /** 'verified' iff the canary probe confirmed egress is still tunneled.
   *  Proxy mode cannot verify and says so. */
  integrity: 'verified' | 'proxy-mode-unverified'
  /** Known blind spots of THIS receipt. Empty in strict gateway mode. */
  leaks: ReceiptLeak[]
}

interface RawRequestsBody { requests?: unknown[] }

export function parseRequestsBody(body: unknown): { count: number; entries: ReceiptRequest[] } {
  const rows = Array.isArray((body as RawRequestsBody)?.requests)
    ? (body as RawRequestsBody).requests!
    : []
  const entries: ReceiptRequest[] = rows.map((r) => {
    const row = r as Record<string, unknown>
    return {
      method: String(row.method ?? ''),
      path: String(row.path ?? ''),
      status: typeof row.status === 'number' ? row.status : null,
    }
  })
  return { count: entries.length, entries }
}

export async function fetchReceiptEntry(svc: ServiceInfo): Promise<ReceiptEntry> {
  const res = await fetch(`${svc.control_url}/veris/requests`)
  const raw: unknown = await res.json()
  const { count, entries } = parseRequestsBody(raw)
  return { requests: count, controlUrl: svc.control_url, entries, raw }
}

/**
 * The canary probe: one in-sandbox HTTPS request to a reserved hostname only
 * the gateway answers (with a leaf signed by the org CA and the twin id in
 * the body). Green proves, in a single request: egress is actually tunneled,
 * the credential demuxes to the right twin, and the CA install worked.
 * Dialed outside the tunnel, the host has no HTTPS listener — so this can
 * never pass by accident.
 */
export async function probeCanary(
  sandbox: Sandbox,
  canaryHost: string,
  expectedTwinId: string,
  /** CA file path to pass to curl's --cacert, so the probe verifies the org
   *  leaf even when installCa was false (system store untouched). */
  caCertPath?: string,
): Promise<void> {
  const caFlag = caCertPath ? `--cacert ${caCertPath} ` : ''
  const r = await sandbox.commands.run(
    `curl -sS ${caFlag}--max-time 15 https://${canaryHost}/`, { timeoutMs: 30_000 })
  let body: { veris_sandbox_id?: string; mode?: string } = {}
  try { body = JSON.parse(r.stdout) } catch { /* handled below */ }
  if (body.veris_sandbox_id !== expectedTwinId) {
    throw new ReceiptIntegrityError(
      `canary probe failed: egress from this E2B sandbox is not tunneled through the Veris gateway ` +
      `(expected twin ${expectedTwinId}, canary answered: ${r.stdout.slice(0, 200) || r.stderr.slice(0, 200) || 'nothing'})`,
      { phase: 'canary', verisSandboxId: expectedTwinId })
  }
}
