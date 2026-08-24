// Full loop on the class API: create → run a suite → prove the dependency was
// exercised → tear down. Replaces the v1 example that spread verisTrustEnv into
// every command; here the CA and trust env are already in place at create.
import { Sandbox } from '@veris-ai/e2b'

const sbx = await Sandbox.create({
  timeoutMs: 15 * 60_000,
  veris: {
    // mode defaults to 'auto'. Force one with mode: 'gateway' | 'proxy'.
    // egress defaults to 'strict' (no QUIC/ECH leak; receipt has no blind spots).
    allowOut: ['registry.npmjs.org'], // let `npm ci` reach the real registry
  },
})
try {
  await sbx.commands.run('git clone https://github.com/acme/app ~/app && cd ~/app && npm ci', { timeoutMs: 300_000 })
  const test = await sbx.commands.run('cd ~/app && npm test', { timeoutMs: 600_000 })
  console.log(test.exitCode === 0 ? 'tests passed' : 'tests failed')

  // A green suite that never called Stripe is a false pass — assert it did.
  await sbx.veris.assertTouched('stripe', { method: 'POST', path: '/v1/charges' })
  const dataPlane = await sbx.veris.getDataPlaneEnv() // e.g. { DATABASE_URL: 'postgresql://…' }
  console.log('data plane:', Object.keys(dataPlane))
} finally {
  await sbx.kill()
}
