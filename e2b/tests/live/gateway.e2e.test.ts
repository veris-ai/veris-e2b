import { expect, it } from 'vitest'

import { describeLive, liveSandbox } from './harness'

// Gateway-mode end to end. This suite is the ACCEPTANCE GATE for the server
// offering gateway mode: the first SDK version it passes against real infra
// becomes the control plane's min_sdk. Run: VERIS_E2E=gateway npm run test:live
describeLive('gateway')('gateway mode e2e', () => {
  it('tunnels a vendor call through the Veris gateway; canary + receipt agree', async () => {
    const sbx = await liveSandbox({ veris: { mode: 'gateway', egress: 'strict' } })
    expect(sbx.verisMode).toBe('gateway')
    await sbx.commands.run('curl -sS https://api.stripe.com/v1/customers -u sk_test_veris:')
    const receipt = await sbx.veris.receipt() // runs the canary integrity check first
    expect(receipt.mode).toBe('gateway')
    expect(receipt.integrity).toBe('verified')
    expect(receipt.services.stripe?.requests).toBeGreaterThan(0)
  })

  it('strict mode reaches the Postgres data plane through the spliced tunnel', async () => {
    const sbx = await liveSandbox({ veris: { mode: 'gateway', egress: 'strict' } })
    const env = await sbx.veris.getDataPlaneEnv()
    expect(Object.keys(env).length).toBeGreaterThan(0)
  })
})
