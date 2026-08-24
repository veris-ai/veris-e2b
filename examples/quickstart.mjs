// Quickstart — the whole loop in one screen.
//
//   Required env: E2B_API_KEY, VERIS_API_KEY, VERIS_ENVIRONMENT_ID
//   node examples/quickstart.mjs
//
// Runs in whichever mode the control plane offers (mode: 'auto'): gateway once
// the Veris gateway is live, else the in-sandbox proxy. Either way the code
// under test dials real vendor hostnames and never learns it was intercepted.
import { Sandbox } from '@veris-ai/e2b'

const sbx = await Sandbox.create()
console.log(`sandbox ${sbx.sandboxId} · twin ${sbx.verisSandboxId} · mode ${sbx.verisMode}`)
try {
  // No base-URL override, no proxy config: api.stripe.com is your Veris twin.
  const r = await sbx.commands.run('curl -sS https://api.stripe.com/v1/customers -u sk_test_veris:')
  console.log(r.stdout.slice(0, 400))

  // Never trust green without the receipt.
  await sbx.veris.assertTouched('stripe')
  const receipt = await sbx.veris.receipt()
  console.log('receipt:', JSON.stringify(receipt.services, null, 2))
} finally {
  await sbx.kill() // kills the E2B sandbox AND deletes the Veris twin
}
