import { describe, it, expect } from 'vitest'
import { Sandbox } from '../../src/sandbox'
import { MissingCredentialsError, UnsupportedOperationError } from '../../src/errors'

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
