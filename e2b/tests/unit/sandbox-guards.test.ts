import { describe, it, expect, vi } from 'vitest'
import { Sandbox } from '../../src/sandbox'
import { MissingCredentialsError, UnsupportedOperationError, VerisError } from '../../src/errors'

describe('coordinate resolution', () => {
  it('create() throws MissingCredentialsError naming VERIS_API_KEY when absent', async () => {
    const prev = process.env.VERIS_API_KEY
    delete process.env.VERIS_API_KEY
    await expect(Sandbox.create({ veris: { environmentId: 'env_1' } }))
      .rejects.toMatchObject({ message: expect.stringContaining('VERIS_API_KEY') })
    await expect(Sandbox.create({ veris: { environmentId: 'env_1' } }))
      .rejects.toBeInstanceOf(MissingCredentialsError)
    if (prev) process.env.VERIS_API_KEY = prev
  })

  it('create() throws naming VERIS_ENVIRONMENT_ID when only the key is set', async () => {
    await expect(Sandbox.create({ veris: { apiKey: 'k' } }))
      .rejects.toMatchObject({ message: expect.stringContaining('VERIS_ENVIRONMENT_ID') })
  })
})

describe('fork is refused', () => {
  it('throws UnsupportedOperationError (would share one twin across clones)', () => {
    // fork() needs no network — the guard fires before any base work.
    const inst = Object.create(Sandbox.prototype) as Sandbox
    Object.defineProperty(inst, 'verisSandboxId', { value: 'sb_twin' })
    expect(() => (inst as unknown as { fork(): never }).fork()).toThrow(UnsupportedOperationError)
  })
})

describe('static fork is refused', () => {
  it('Sandbox.fork rejects with UnsupportedOperationError', async () => {
    await expect((Sandbox as unknown as { fork(): Promise<never> }).fork())
      .rejects.toBeInstanceOf(UnsupportedOperationError)
  })
})

describe('default control plane', () => {
  it('points at the host that actually serves it', async () => {
    // svc.api.veris.ai serves the control plane; api.veris.ai is the DNS zone
    // and answers nothing, so a wrong default here fails every call for anyone
    // who does not set VERIS_API_BASE.
    const prevBase = process.env.VERIS_API_BASE
    delete process.env.VERIS_API_BASE
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      seen.push(String(u))
      return { ok: false, status: 404, async text() { return '' }, async json() { return {} } } as Response
    }))
    await Sandbox.create({ veris: { apiKey: 'k', environmentId: 'env_1' } }).catch(() => {})
    vi.unstubAllGlobals()
    if (prevBase) process.env.VERIS_API_BASE = prevBase
    expect(seen[0]).toContain('https://svc.api.veris.ai/')
  })
})

describe('snapshotId guards', () => {
  it('refuses snapshotId together with attachSandboxId — before any network call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no request should be made') }))
    await expect(Sandbox.create({ veris: { apiKey: 'k', attachSandboxId: 'sb_1', snapshotId: 'snap_1' } }))
      .rejects.toBeInstanceOf(VerisError)
    await expect(Sandbox.create({ veris: { apiKey: 'k', attachSandboxId: 'sb_1', snapshotId: 'snap_1' } }))
      .rejects.toMatchObject({ message: expect.stringContaining('mutually exclusive') })
    vi.unstubAllGlobals()
  })

  it('refuses snapshotId in proxy mode, where the twin is deployed in-sandbox', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no request should be made') }))
    await expect(Sandbox.create({ veris: { apiKey: 'k', environmentId: 'env_1', mode: 'proxy', snapshotId: 'snap_1' } }))
      .rejects.toMatchObject({ message: expect.stringContaining('gateway mode') })
    vi.unstubAllGlobals()
  })
})
