import { expect, it } from 'vitest'

import { describeLive, liveSandbox } from './harness'

// Proxy-mode end to end. Run: VERIS_E2E=proxy npm run test:live
describeLive('proxy')('proxy mode e2e', () => {
  it('intercepts a vendor call and the receipt proves it', async () => {
    const sbx = await liveSandbox({ veris: { mode: 'proxy' } })
    expect(sbx.verisMode).toBe('proxy')
    await sbx.commands.run('curl -sS https://api.stripe.com/v1/customers -u sk_test_veris: || true', { user: 'user' })
    await expect(sbx.veris.assertTouched('stripe')).resolves.toBeUndefined()
  })
})
