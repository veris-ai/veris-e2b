// Scoped receipts require the trace API's IDs and tiers. Older deployments
// must fail visibly instead of letting old/control traffic certify a run.
import type { ServiceInfo } from './control-plane'
import type { ReceiptEntry, ReceiptRequest } from './receipt'
import { VerisError } from './errors'

interface Row { id: number; method: string; path: string; status: number | null; tier: string }
const PAGE_LIMIT = 1000
const MAX_PAGES = 20

async function page(svc: ServiceInfo, query: Record<string, string>): Promise<Row[]> {
  const res = await fetch(`${svc.control_url}/veris/requests?${new URLSearchParams(query)}`, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new VerisError(`trace read failed for '${svc.name}' (${res.status})`, { phase: 'receipt' })
  const body = await res.json() as { requests?: unknown }
  if (!body || !Array.isArray(body.requests)) throw new VerisError(`invalid trace envelope for '${svc.name}'`, { phase: 'receipt' })
  return body.requests.map((value: unknown) => {
    const row = value as Partial<Row> | null
    if (!row || !Number.isSafeInteger(row.id) || row.id! <= 0 || typeof row.tier !== 'string' || !row.tier ||
        typeof row.method !== 'string' || typeof row.path !== 'string' || (row.status !== null && typeof row.status !== 'number')) {
      throw new VerisError(`trace for '${svc.name}' needs numeric IDs, tiers, method, path and status; upgrade the twin release`, { phase: 'receipt' })
    }
    return row as Row
  })
}

export async function fetchWatermark(svc: ServiceInfo): Promise<number> {
  const rows = await page(svc, { limit: '1', order: 'desc' })
  if (rows.length > 1) throw new VerisError(`trace for '${svc.name}' ignored limit=1; cannot establish a watermark`, { phase: 'receipt' })
  return rows[0]?.id ?? 0
}

export async function fetchScopedReceiptEntry(svc: ServiceInfo, sinceId: number): Promise<ReceiptEntry> {
  if (!Number.isSafeInteger(sinceId) || sinceId < 0) throw new VerisError(`missing or invalid watermark for '${svc.name}'`, { phase: 'receipt' })
  const entries: ReceiptRequest[] = []
  const raw: Row[] = []
  let cursor = sinceId
  for (let n = 0; n < MAX_PAGES; n++) {
    const rows = await page(svc, { limit: String(PAGE_LIMIT), order: 'asc', since_id: String(cursor) })
    let last = cursor
    for (const row of rows) {
      // Do not advance past unseen rows if a deployment ignores order/offset.
      // Repeated, stale, or out-of-order rows cannot certify this flow.
      if (row.id <= last) throw new VerisError(`trace for '${svc.name}' did not honor ascending since_id pagination`, { phase: 'receipt' })
      last = row.id
      raw.push(row)
      if (row.tier === 'handler' || row.tier === 'fault') {
        const { id, method, path, status, tier } = row
        entries.push({ id, method, path, status, tier })
      }
    }
    cursor = last
    if (rows.length < PAGE_LIMIT) return { requests: entries.length, controlUrl: svc.control_url, entries: entries.reverse(), capped: false, raw: { requests: raw } }
  }
  return { requests: entries.length, controlUrl: svc.control_url, entries: entries.reverse(), capped: true, raw: { requests: raw } }
}
