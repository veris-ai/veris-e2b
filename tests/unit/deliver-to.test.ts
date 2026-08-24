import { describe, it, expect, vi, afterEach } from 'vitest'

import { VerisApiImpl } from '../../src/veris-api'
import type { VerisContext } from '../../src/veris-api'

const SVC = {
  name: 'stripe', status: 'ready',
  url: 'https://x/s/1/stripe', control_url: 'https://x/s/1/stripe',
  env_hint: null, routes: [{ host: 'api.stripe.com' }],
}

function ctx(patch: (env: string, id: string, body: unknown) => void): VerisContext {
  return {
    sandbox: { getHost: (port: number) => `${port}-sbx.e2b.app` } as never,
    controlPlane: {
      updateSandbox: async (env: string, id: string, body: unknown) => { patch(env, id, body) },
      services: async () => [SVC],
    } as never,
    environmentId: 'env_1', twinId: 'twin_1', mode: 'gateway',
    egress: 'strict', allowOut: [], ownsTwin: true,
  }
}

afterEach(() => vi.unstubAllGlobals())
const stubProbe = (answered: boolean) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ answered }) } as Response)))

describe('deliverTo', () => {
  it('resolves a port to the sandbox public URL and registers it', async () => {
    stubProbe(true)
    const seen: unknown[] = []
    const api = new VerisApiImpl(ctx((_e, _i, body) => seen.push(body)))
    const url = await api.deliverTo(3000)
    expect(url).toBe('https://3000-sbx.e2b.app')
    expect(seen).toEqual([{ client_base_url: 'https://3000-sbx.e2b.app' }])
  })

  it('accepts an explicit URL', async () => {
    stubProbe(true)
    const seen: unknown[] = []
    const api = new VerisApiImpl(ctx((_e, _i, body) => seen.push(body)))
    expect(await api.deliverTo('https://my.tunnel.dev')).toBe('https://my.tunnel.dev')
    expect(seen).toEqual([{ client_base_url: 'https://my.tunnel.dev' }])
  })

  it('null unregisters and skips the probe', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const seen: unknown[] = []
    const api = new VerisApiImpl(ctx((_e, _i, body) => seen.push(body)))
    expect(await api.deliverTo(null)).toBeNull()
    expect(seen).toEqual([{ client_base_url: null }])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('throws when no service can reach the destination', async () => {
    stubProbe(false)
    const api = new VerisApiImpl(ctx(() => {}))
    await expect(api.deliverTo(3000)).rejects.toThrow(/could reach/)
  })

  it('probe: false registers without verifying', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const api = new VerisApiImpl(ctx(() => {}))
    expect(await api.deliverTo(3000, { probe: false })).toBe('https://3000-sbx.e2b.app')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
