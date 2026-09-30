// The keyed control URL: the Veris API key goes to each service's control_url
// and nowhere else, and a refused key names the credential. The fake twin
// enforces the split contract — /veris/* on /c/ requires X-API-Key, the /s/
// data plane answers the vendor's 404 — so a call to the wrong place, or
// without the key, fails here the way it would against the real thing.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VerisApiImpl } from '../../src/veris-api'
import { controlHeaders, isControlRequest } from '../../src/control-auth'
import { VerisControlAuthError } from '../../src/index'
import type { ServiceInfo } from '../../src/control-plane'

const KEY = 'veris_key'
const HOST = 'svc.dev.api.veris.ai'
const DATA = `https://${HOST}/s/sb_1/stripe`
const CONTROL = `https://${HOST}/c/sb_1/stripe`
const SVC: ServiceInfo = { name: 'stripe', status: 'ready', url: DATA, control_url: CONTROL,
  control_auth: 'api_key', routes: [{ host: 'api.stripe.com' }] }

interface Seen { url: URL; method: string; headers: Headers; redirect?: RequestInit['redirect'] }

function splitTwin(acceptKey = KEY) {
  const seen: Seen[] = []
  const rows: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input))
    const headers = new Headers(init.headers)
    seen.push({ url, method: init.method ?? 'GET', headers, redirect: init.redirect })
    if (url.host !== HOST || url.pathname.startsWith('/s/')) return Response.json({ error: 'vendor 404' }, { status: 404 })
    if (headers.get('x-api-key') !== acceptKey) return Response.json({ detail: 'invalid or missing API key' }, { status: 401 })
    if (url.pathname.endsWith('/veris/requests')) {
      const since = Number(url.searchParams.get('since_id') ?? 0)
      const kept = url.searchParams.get('order') === 'desc' ? [...rows].reverse() : rows.filter(r => (r.id as number) > since)
      return Response.json({ requests: kept.slice(0, Number(url.searchParams.get('limit') ?? 50)) })
    }
    if (url.pathname.endsWith('/veris/schema')) {
      const marker = headers.get('x-veris-receipt-baseline')
      if (marker) rows.push({ id: rows.length + 1, method: 'GET', path: '/veris/schema', status: 200, tier: 'control',
        request_headers: JSON.stringify({ 'x-veris-receipt-baseline': marker }) })
      return Response.json({ tables: {} })
    }
    if (url.pathname.endsWith('/veris/client/probe')) return Response.json({ answered: true })
    return Response.json({ ok: true })
  }))
  return seen
}

function api() {
  return new VerisApiImpl({
    sandbox: { sandboxId: 'box', getHost: (port: number) => `${port}-sbx.e2b.app`,
      commands: { run: async () => ({ stdout: JSON.stringify({ veris_sandbox_id: 'sb_1' }) }) } },
    controlPlane: { apiKey: KEY, services: async () => [SVC], updateSandbox: async () => {} },
    twinId: 'sb_1', environmentId: 'env', mode: 'gateway', egress: 'strict', allowOut: [],
    canaryHost: 'canary.invalid', ownsTwin: true,
  } as never)
}

async function exercise(sdk: VerisApiImpl) {
  await sdk.receipt()
  await sdk.receipt('stripe')
  const baseline = await sdk.receiptBaseline()
  await sdk.receiptSince(baseline)
  for (const resource of ['manual', 'schema', 'operations', 'data', 'requests'] as const) await sdk.control('stripe', resource)
  await sdk.control('stripe', 'data', { method: 'POST', body: { rows: [] } })
  await sdk.deliverTo(3000)
}

afterEach(() => vi.unstubAllGlobals())

describe('keyed control URL', () => {
  it('sends the key on every control call, to the control URL only, never following redirects', async () => {
    const seen = splitTwin()
    await exercise(api())
    const resources = new Set(seen.map(s => s.url.pathname.split('/veris/')[1]))
    for (const r of ['requests', 'schema', 'manual', 'operations', 'data', 'client/probe']) expect(resources).toContain(r)
    for (const s of seen) {
      expect(s.url.href.startsWith(`${CONTROL}/veris/`)).toBe(true)
      expect(s.headers.get('x-api-key')).toBe(KEY)
      expect(s.redirect).toBe('error')
    }
  })

  it('never calls the data url or a vendor host', async () => {
    const seen = splitTwin()
    await exercise(api())
    expect(seen.filter(s => s.url.pathname.startsWith('/s/') || s.url.host === 'api.stripe.com')).toEqual([])
  })

  it.each([
    ['same host, data plane', `${DATA}/veris/requests`],
    ['vendor host', 'https://api.stripe.com/c/sb_1/stripe/veris/requests'],
    ['downgraded scheme', `http://${HOST}/c/sb_1/stripe/veris/requests`],
    ['other port', `https://${HOST}:8443/c/sb_1/stripe/veris/requests`],
    ['path prefix, not a segment', `https://${HOST}/c/sb_1/stripe-evil/veris/requests`],
    ['lookalike host', `https://${HOST}.evil.example/c/sb_1/stripe/veris/requests`],
  ])('withholds the key from %s', (_label, url) => {
    expect(isControlRequest(url, CONTROL)).toBe(false)
    expect(controlHeaders(SVC, url, KEY)).toEqual({})
  })

  it('attaches it under the control URL, and to a legacy keyless one too', () => {
    expect(controlHeaders(SVC, `${CONTROL}/veris/requests`, KEY, { A: 'b' })).toEqual({ A: 'b', 'X-API-Key': KEY })
    const legacy = { ...SVC, control_url: DATA, control_auth: null }
    expect(controlHeaders(legacy, `${DATA}/veris/requests`, KEY)).toEqual({ 'X-API-Key': KEY })
    expect(controlHeaders(SVC, `${CONTROL}/veris/requests`, undefined)).toEqual({})
  })

  it.each([
    ['control', (s: VerisApiImpl) => s.control('stripe', 'manual')],
    ['receipt', (s: VerisApiImpl) => s.receipt('stripe')],
    ['baseline', (s: VerisApiImpl) => s.receiptBaseline()],
    ['deliverTo probe', (s: VerisApiImpl) => s.deliverTo(3000)],
  ])('maps a 401 on %s to an error naming the credential', async (_label, call) => {
    splitTwin('someone-elses-key')
    const error = await call(api()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(VerisControlAuthError)
    expect((error as VerisControlAuthError).service).toBe('stripe')
    expect(String((error as Error).message)).toMatch(/401.*Veris API key was rejected.*VERIS_API_KEY/)
  })
})
