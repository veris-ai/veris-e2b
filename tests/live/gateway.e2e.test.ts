import { describe, it, expect, afterAll } from 'vitest'
import { Sandbox } from '../../src/sandbox'

// Gateway-mode end-to-end. This suite is the ACCEPTANCE GATE for the server
// beginning to offer gateway mode: the first SDK version it passes against real
// infra becomes the control plane's min_sdk. It is committed now and skipped
// until VERIS_E2E=gateway (and the gateway + BYOP beta) exist.
const RUN = process.env.VERIS_E2E === 'gateway'
const d = RUN ? describe : describe.skip

let sbx: Sandbox | undefined
afterAll(async () => { await sbx?.kill().catch(() => {}) })

d('gateway mode e2e', () => {
  it('tunnels a vendor call through the Veris gateway; canary + receipt agree', async () => {
    sbx = await Sandbox.create({ veris: { mode: 'gateway', egress: 'strict' } })
    expect(sbx.verisMode).toBe('gateway')
    await sbx.commands.run('curl -sS https://api.stripe.com/v1/customers -u sk_test_veris:')
    const receipt = await sbx.veris.receipt()   // runs the canary integrity check first
    expect(receipt.mode).toBe('gateway')
    expect(receipt.integrity).toBe('verified')
    expect(receipt.services.stripe?.requests).toBeGreaterThan(0)
  })

  it('strict mode reaches the Postgres data plane through the spliced tunnel', async () => {
    const s = await Sandbox.create({ veris: { mode: 'gateway', egress: 'strict' } })
    try {
      const env = await s.veris.getDataPlaneEnv()
      expect(Object.keys(env).length).toBeGreaterThan(0)
    } finally { await s.kill() }
  })
})
