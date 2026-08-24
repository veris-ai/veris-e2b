import { describe, it, expect, afterAll } from 'vitest'
import { Sandbox } from '../../src/sandbox'

// Proxy-mode end-to-end. Run: VERIS_E2E=proxy npm run test:live
const RUN = process.env.VERIS_E2E === 'proxy'
const d = RUN ? describe : describe.skip

let sbx: Sandbox | undefined
afterAll(async () => { await sbx?.kill().catch(() => {}) })

d('proxy mode e2e', () => {
  it('intercepts a vendor call and the receipt proves it', async () => {
    sbx = await Sandbox.create({ veris: { mode: 'proxy' } })
    expect(sbx.verisMode).toBe('proxy')
    await sbx.commands.run('curl -sS https://api.stripe.com/v1/customers -u sk_test_veris: || true', { user: 'user' })
    await expect(sbx.veris.assertTouched('stripe')).resolves.toBeUndefined()
  })
})
