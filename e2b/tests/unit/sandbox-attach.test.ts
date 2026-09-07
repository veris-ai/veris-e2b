import { Sandbox as E2B } from 'e2b'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Sandbox } from '../../src/sandbox'
import { VerisGatewayNotOfferedError } from '../../src/errors'
import { ControlPlane } from '../../src/control-plane'

const twin = { id: 'twin-1', environment_id: 'actual-env', status: 'ready', services: [{ name: 'stripe', status: 'ready', url: 'https://stripe.example', control_url: 'https://stripe.example', routes: [{ host: 'api.stripe.com' }] }] }
let offered: boolean
let requests: { method: string; path: string }[]
let base: { sandboxId: string; commands: { run: ReturnType<typeof vi.fn> }; files: { write: ReturnType<typeof vi.fn> }; getInfo: ReturnType<typeof vi.fn>; updateNetwork: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> }

beforeEach(() => {
  offered = true; requests = []
  base = { sandboxId: 'box-1', commands: { run: vi.fn(async (cmd: string) => ({ stdout: cmd.includes('canary.example') ? JSON.stringify({ veris_sandbox_id: 'twin-1' }) : 'ok', stderr: '', exitCode: 0 })) },
    files: { write: vi.fn() }, updateNetwork: vi.fn(), kill: vi.fn().mockResolvedValue(true),
    getInfo: vi.fn(async () => ({ metadata: { veris_sandbox_id: 'twin-1', veris_env_id: 'actual-env', veris_api_base: 'https://plane.example',
      veris_mode: 'gateway', veris_egress: 'strict', veris_owns_twin: 'false', veris_allow_out: '[]' } })) }
  vi.spyOn(E2B, 'create').mockResolvedValue(base as unknown as E2B)
  vi.spyOn(E2B, 'connect').mockResolvedValue(base as unknown as E2B)
  vi.stubEnv('VERIS_API_KEY', 'fixture-key'); vi.stubEnv('VERIS_API_BASE', 'https://plane.example')
  vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
    const path = new URL(url).pathname; requests.push({ path, method: opts?.method ?? 'GET' })
    if (path === '/v1/sandboxes/twin-1') return Response.json(twin)
    if (path === '/v1/gateway/health') return Response.json({})
    if (path.endsWith('/egress-credential')) return offered ? Response.json({ socks_address: 'gateway.example:1080', username: 'fixture', password: 'fixture', ca_pem: 'fixture-ca', canary_host: 'canary.example' }) : new Response('', { status: 404 })
    if (opts?.method === 'PATCH') return Response.json({})
    throw new Error(`unexpected request: ${path}`)
  }))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

it('derives attached-twin metadata and subsequent updates from the twin, ignoring a stale environment', async () => {
  vi.stubEnv('VERIS_ENVIRONMENT_ID', 'stale-env')
  const box = await Sandbox.create('base', { veris: { attachSandboxId: 'twin-1', mode: 'gateway' } })
  expect(E2B.create).toHaveBeenCalledWith('base', expect.objectContaining({ metadata: expect.objectContaining({ veris_env_id: 'actual-env', veris_owns_twin: 'false' }) }))
  await box.veris.deliverTo(null)
  expect(requests.at(-1)?.path).toBe('/v1/environments/actual-env/sandboxes/twin-1')
  expect(requests.some(r => r.method === 'DELETE' || r.path.includes('stale-env'))).toBe(false)
})

it('refuses reconnect when the gateway stops offering a credential, before a workload can run', async () => {
  offered = false
  await expect(Sandbox.connect('box-1')).rejects.toBeInstanceOf(VerisGatewayNotOfferedError)
  expect(base.updateNetwork).not.toHaveBeenCalled()
  expect(base.commands.run).not.toHaveBeenCalled()
})

it('rechecks the canary and restores egress on reconnect', async () => {
  const box = await Sandbox.connect('box-1')
  expect(box.verisSandboxId).toBe('twin-1')
  expect(base.updateNetwork).toHaveBeenCalledWith(expect.objectContaining({ egressProxy: expect.objectContaining({ address: 'gateway.example:1080' }) }))
  expect(base.commands.run).toHaveBeenCalledWith(expect.stringContaining('https://canary.example/'), expect.anything())
})

it('names a leaked E2B ID if gateway preparation and deletion both fail', async () => {
  base.files.write.mockRejectedValue(new Error('write failed'))
  base.kill.mockRejectedValue(new Error('delete denied'))
  await expect(Sandbox.create({ veris: { attachSandboxId: 'twin-1', mode: 'gateway' } })).rejects.toThrow('box-1 could not be deleted')
  expect(requests.some(r => r.method === 'DELETE')).toBe(false)
})

it('reports an owned twin that cannot be deleted when provider creation fails', async () => {
  vi.spyOn(ControlPlane.prototype, 'createTwin').mockResolvedValue(twin)
  vi.spyOn(ControlPlane.prototype, 'waitReady').mockResolvedValue(twin)
  vi.spyOn(ControlPlane.prototype, 'deleteTwin').mockRejectedValue(new Error('denied'))
  vi.mocked(E2B.create).mockRejectedValue(new Error('template unavailable'))
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await expect(Sandbox.create({ veris: { environmentId: 'actual-env', mode: 'gateway' } })).rejects.toThrow('E2B sandbox create failed')
  expect(ControlPlane.prototype.deleteTwin).toHaveBeenCalledWith('actual-env', 'twin-1')
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('owned Veris twin twin-1'))
})
