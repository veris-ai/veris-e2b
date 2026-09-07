import { afterEach, describe, expect, it, vi } from 'vitest'
import { VerisApiImpl } from '../../src/veris-api'
import { svc, trace } from './trace-fixture'

function api(twinId = 'twin') {
  return new VerisApiImpl({ sandbox: { id: 'box', sandboxId: 'box', commands: { run: async () => ({ stdout: JSON.stringify({ veris_sandbox_id: twinId }) }) } },
    controlPlane: { services: async () => [svc] }, twinId, environmentId: 'env', mode: 'gateway', egress: 'open', canaryHost: 'canary.invalid', ownsTwin: true } as never)
}
afterEach(() => vi.unstubAllGlobals())
describe('SDK run and control interface', () => {
  it('captures before execution and preserves routing integrity and blind spots', async () => {
    const t = trace(70)
    const sdk = api()
    const b = await sdk.receiptBaseline()
    t.add('handler', '/v1/test-run')
    expect(await sdk.receiptSince(b, 'stripe')).toMatchObject({ mode: 'gateway', integrity: 'verified', leaks: ['udp-quic-possible', 'ech-possible'], services: { stripe: { requests: 1, capped: false, entries: [{ path: '/v1/test-run' }] } } })
    t.reset()
    await expect(sdk.receiptSince(b)).rejects.toThrow(/baseline invalid/)
  })
  it('resolves the attached service and rejects arbitrary URLs and lifecycle writes', async () => {
    const f = vi.fn(async (_input: string | URL) => new Response(JSON.stringify({ data: {} })))
    vi.stubGlobal('fetch', f)
    await api().control('stripe', 'data', { method: 'POST', body: { data: { faults: [] } } })
    expect(String(f.mock.calls[0]![0])).toBe('https://twin.invalid/stripe/veris/data')
    await expect(api().control('other', 'data')).rejects.toThrow(/unknown service/)
    await expect(api().control('stripe', '../reset' as never, { method: 'POST' })).rejects.toThrow(/unsupported/)
    await expect(api().control('stripe', 'schema', { method: 'PATCH' })).rejects.toThrow(/unsupported/)
  })
  it('invalidates evidence if reset happens during pagination', async () => {
    const t = trace()
    const sdk = api()
    const baseline = await sdk.receiptBaseline()
    t.add()
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const response = await t.fetcher(input, init)
      const q = new URL(String(input)).searchParams
      if (q.get('order') === 'asc' && q.get('limit') === '1000') t.reset()
      return response
    }))
    await expect(sdk.receiptSince(baseline)).rejects.toThrow(/baseline invalid/)
  })

})


describe('E2B receipt integrity', () => {
  it('refuses gateway receipts without a canary and preserves proxy-mode uncertainty', async () => {
    trace()
    const context = { sandbox: { sandboxId: 'box' }, controlPlane: { services: async () => [svc] },
      twinId: 'twin', environmentId: 'env', ownsTwin: true, mode: 'gateway', egress: 'open' }
    const gateway = new VerisApiImpl(context as never)
    await expect(gateway.receipt()).rejects.toThrow(/no canary credential/)
    await expect(gateway.receiptBaseline()).rejects.toThrow(/no canary credential/)
    const proxy = new VerisApiImpl({ ...context, mode: 'proxy' } as never)
    expect(await proxy.receipt()).toMatchObject({ mode: 'proxy', integrity: 'proxy-mode-unverified', leaks: ['udp-quic-possible', 'ech-possible'] })
  })
})
