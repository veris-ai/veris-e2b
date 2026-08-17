// The whole integration, both halves. Build once, then every run is seconds.
//   E2B_API_KEY, VERIS_API_KEY, VERIS_ENVIRONMENT_ID (and VERIS_API_BASE if
//   non-default) in the environment; veris-proxy binary downloaded locally.
import { Sandbox, Template } from 'e2b'
import { withVeris, wakeVeris, verisTrustEnv, verisReceipt, verisTeardown } from '@veris-ai/e2b'

// ---- build time (once) ------------------------------------------------------
const template = withVeris(
  Template().fromBaseImage(),            // or .fromTemplate('your-existing-template')
  { binaryPath: './veris-proxy-linux-amd64' },
)
await Template.build(template, { alias: 'my-app-veris', cpuCount: 2, memoryMB: 1024 })

// ---- every run --------------------------------------------------------------
const sbx = await Sandbox.create('my-app-veris', { timeoutMs: 15 * 60 * 1000 })
try {
  await wakeVeris(sbx, {
    apiKey: process.env.VERIS_API_KEY,
    environmentId: process.env.VERIS_ENVIRONMENT_ID,
    apiBase: process.env.VERIS_API_BASE,
  })

  const envs = await verisTrustEnv(sbx)
  const test = await sbx.commands.run('cd ~/repo && npm test', { user: 'user', envs })
  console.log('tests exit:', test.exitCode)

  const receipt = await verisReceipt(sbx, {
    apiKey: process.env.VERIS_API_KEY, apiBase: process.env.VERIS_API_BASE })
  for (const [name, r] of Object.entries(receipt)) console.log(`${name}: ${r.requests} request(s)`)
  // Rule: green tests + empty receipt = the tests never touched the dependency.
} finally {
  await verisTeardown(sbx)   // proxy deletes its per-run Veris sandbox
  await sbx.kill()
}
