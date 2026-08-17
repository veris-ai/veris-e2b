// Split coordinates: environmentId baked in the template (not a secret),
// VERIS_API_KEY passed only at wake — no secret in any stored snapshot.
import { Sandbox, Template } from 'e2b'
import { withVeris, startVeris, verisReceipt, verisTeardown } from '../src/index.mjs'

const t0 = Date.now()
const mark = (l) => console.log(`[t+${((Date.now() - t0) / 1000).toFixed(1)}s] ${l}`)

mark('building split template (baked environmentId, NO key)…')
const template = withVeris(Template().fromBaseImage(), {
  binaryPath: './veris-proxy-linux-amd64',
  environmentId: process.env.VERIS_ENVIRONMENT_ID,   // baked — not a secret
  apiBase: process.env.VERIS_API_BASE,               // baked — not a secret
})
await Template.build(template, { alias: 'veris-split-test', cpuCount: 2, memoryMB: 1024 })
mark('template built; verifying no key is baked')

const sbx = await Sandbox.create('veris-split-test', { timeoutMs: 15 * 60 * 1000 })
mark(`sandbox ${sbx.sandboxId}`)
try {
  const baked = await sbx.commands.run('cat /etc/veris/baked.env', { user: 'root' })
  if (/VERIS_API_KEY/.test(baked.stdout)) throw new Error('key leaked into baked.env!')
  console.log('baked.env holds only:', baked.stdout.trim().replace(/\n/g, ' · '))

  await startVeris(sbx, { apiKey: process.env.VERIS_API_KEY })   // the key, and ONLY the key
  mark('woke with key only — supervisor merged baked env id + runtime key')

  const receipt = await verisReceipt(sbx, { apiKey: process.env.VERIS_API_KEY, apiBase: process.env.VERIS_API_BASE, service: 'google-identity' })
  const idCtl = receipt['google-identity'].control_url
  const tokens = await sbx.commands.run(`curl -fsS "${idCtl}/veris/data?entity_type=oauth_tokens"`, { user: 'user' })
  const bearer = tokens.stdout.match(/"access_token"\s*:\s*"([^"]+)"/)[1]
  await sbx.commands.run(`curl -fsS -H "Authorization: Bearer ${bearer}" https://www.googleapis.com/calendar/v3/users/me/calendarList >/dev/null && echo "twin answered the real hostname"`, { user: 'user' })
  const cal = await verisReceipt(sbx, { apiKey: process.env.VERIS_API_KEY, apiBase: process.env.VERIS_API_BASE, service: 'google-calendar' })
  mark(`receipt: google-calendar received ${cal['google-calendar'].requests} request(s)`)
} finally {
  await verisTeardown(sbx)
  await sbx.kill()
  mark('teardown + kill done')
}
