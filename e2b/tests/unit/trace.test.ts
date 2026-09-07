import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchScopedReceiptEntry, fetchWatermark } from '../../src/trace'
import { VerisApiImpl } from '../../src/veris-api'
import type { VerisContext } from '../../src/veris-api'
import { reportReceipt } from '../../src/cli-receipt'

const svc = { name: 'stripe', status: 'ready', url: 'https://trace.example', control_url: 'https://trace.example' }
const row = (id: number, tier = 'handler') => ({ id, tier, method: 'GET', path: '/v1/customers', status: 200 })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('scoped trace receipts', () => {
  it('uses a real empty log as mark zero, refusing errors or missing release capabilities', async () => {
    const mock = vi.fn().mockResolvedValueOnce(Response.json({ requests: [] }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ requests: [{ method: 'GET', path: '/', status: 200 }] }))
    vi.stubGlobal('fetch', mock)
    expect(await fetchWatermark(svc)).toBe(0)
    expect(mock.mock.calls[0]![0]).toContain('limit=1&order=desc')
    await expect(fetchWatermark(svc)).rejects.toThrow('503')
    await expect(fetchWatermark(svc)).rejects.toThrow('upgrade the twin release')
  })

  it('counts only fresh handler/fault entries, excluding control and delivery', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ requests: [row(11, 'control'), row(12), row(13, 'fault'), row(14, 'delivery')] })))
    const result = await fetchScopedReceiptEntry(svc, 10)
    expect(result.requests).toBe(2)
    expect(result.entries.map(r => r.id)).toEqual([13, 12])
    expect(result.capped).toBe(false)
    expect(vi.mocked(fetch).mock.calls[0]![0]).toContain('since_id=10')
  })

  it('reads beyond the default page and retains counts as lower bounds at the page budget', async () => {
    const fetcher = vi.fn(async (input: string) => {
      const query = new URL(input).searchParams
      const start = Number(query.get('since_id'))
      return Response.json({ requests: Array.from({ length: 1000 }, (_, i) => row(start + i + 1)) })
    })
    vi.stubGlobal('fetch', fetcher)
    const result = await fetchScopedReceiptEntry(svc, 100)
    expect(fetcher).toHaveBeenCalledTimes(20)
    expect(result.requests).toBe(20000)
    expect(result.capped).toBe(true)
    expect(result.entries[0]?.id).toBe(20100)
  })

  it.each([
    [row(10)], [row(12), row(11)], [row(11), row(11)],
  ])('refuses stale, unordered, or duplicate rows instead of granting a false pass: %j', async (...rows) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ requests: rows })))
    await expect(fetchScopedReceiptEntry(svc, 10)).rejects.toThrow('ascending since_id pagination')
  })

  it('verifies the canary and uses the SDK receipt since option without cumulative reads', async () => {
    const probe = vi.fn(async () => ({ stdout: '{"veris_sandbox_id":"twin-1"}' }))
    const ctx = { sandbox: { commands: { run: probe } }, controlPlane: { services: async () => [svc] },
      environmentId: 'env-1', twinId: 'twin-1', mode: 'gateway', egress: 'strict', allowOut: [], ownsTwin: false,
      canaryHost: 'canary.example', caCertPath: '/cert.pem' } as unknown as VerisContext
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ requests: [row(42)] })))
    const api = new VerisApiImpl(ctx)
    const receipt = await api.receipt({ since: { stripe: 41 } })
    expect(receipt).toMatchObject({ integrity: 'verified', services: { stripe: { requests: 1, capped: false } } })
    expect(probe).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
    await expect(api.receipt({ since: {} })).rejects.toThrow('missing or invalid watermark')
    probe.mockResolvedValue({ stdout: '{"veris_sandbox_id":"wrong-twin"}' })
    await expect(api.receipt({ since: { stripe: 41 } })).rejects.toThrow('canary probe failed')
    ctx.canaryHost = undefined
    await expect(api.receipt({ since: { stripe: 41 } })).rejects.toThrow('without a canary')
  })

  it('does not approve unverified interception even when a service has traffic', () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const receipt = { mode: 'proxy' as const, integrity: 'proxy-mode-unverified' as const, leaks: [], services: { stripe: { requests: 1, entries: [row(42)], controlUrl: svc.control_url, capped: false, raw: {} } } }
    expect(reportReceipt(receipt, 'twin-1', 0, ['stripe'])).toBe(1)
    expect(reportReceipt(receipt, 'twin-1', 7, ['stripe'])).toBe(7)
  })
})
