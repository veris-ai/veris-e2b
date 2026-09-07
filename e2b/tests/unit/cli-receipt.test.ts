// The CLI's scoped receipt path. Pagination, tier filtering and lower-bound
// reporting belong to receipt.ts and are covered by receipt.test.ts; what is
// checked here is that `run` reaches that one implementation, keeps the canary
// verification, and refuses to certify a flow it cannot scope.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VerisApiImpl } from '../../src/veris-api'
import type { VerisContext } from '../../src/veris-api'
import { reportReceipt } from '../../src/cli-receipt'

const svc = { name: 'stripe', status: 'ready', url: 'https://trace.example', control_url: 'https://trace.example' }
const row = (id: number, tier = 'handler') => ({ id, tier, method: 'GET', path: '/v1/customers', status: 200 })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const context = () => ({
  sandbox: { commands: { run: vi.fn(async () => ({ stdout: '{"veris_sandbox_id":"twin-1"}' })) } },
  controlPlane: { services: async () => [svc] },
  environmentId: 'env-1', twinId: 'twin-1', mode: 'gateway', egress: 'strict', allowOut: [], ownsTwin: false,
  canaryHost: 'canary.example', caCertPath: '/cert.pem',
} as unknown as VerisContext)

describe('cli scoped receipts', () => {
  it('verifies the canary and scopes the read to the watermark window', async () => {
    const ctx = context()
    const probe = ctx.sandbox.commands.run as unknown as ReturnType<typeof vi.fn>
    // The watermark read (limit=1&order=desc) then the window page.
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ requests: [row(42)] })))
    const receipt = await new VerisApiImpl(ctx).receipt({ since: { stripe: 41 } })
    expect(receipt).toMatchObject({ integrity: 'verified', services: { stripe: { requests: 1, capped: false } } })
    expect(receipt.services.stripe).toMatchObject({ sinceId: 41, untilId: 42 })
    expect(probe).toHaveBeenCalledOnce()
  })

  it('refuses a scoped read it has no watermark for, instead of reading cumulatively', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ requests: [row(42)] })))
    await expect(new VerisApiImpl(context()).receipt({ since: {} }))
      .rejects.toThrow('missing or invalid watermark')
  })

  it('refuses to certify a flow whose interception it could not verify', async () => {
    const ctx = context()
    const probe = ctx.sandbox.commands.run as unknown as ReturnType<typeof vi.fn>
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ requests: [row(42)] })))
    probe.mockResolvedValue({ stdout: '{"veris_sandbox_id":"wrong-twin"}' })
    await expect(new VerisApiImpl(ctx).receipt({ since: { stripe: 41 } })).rejects.toThrow('canary probe failed')
    ctx.canaryHost = undefined
    await expect(new VerisApiImpl(ctx).receipt({ since: { stripe: 41 } })).rejects.toThrow('without a canary')
  })

  it('does not approve unverified interception even when a service has traffic', () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const receipt = { mode: 'proxy' as const, integrity: 'proxy-mode-unverified' as const, leaks: [],
      services: { stripe: { requests: 1, entries: [row(42)], controlUrl: svc.control_url, capped: false, raw: {} } } }
    expect(reportReceipt(receipt, 'twin-1', 0, ['stripe'])).toBe(1)
    expect(reportReceipt(receipt, 'twin-1', 7, ['stripe'])).toBe(7)
  })
})
