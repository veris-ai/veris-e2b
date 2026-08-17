// Template-less path: a DEFAULT base sandbox, Veris-ized at runtime.
import { Sandbox } from 'e2b'
import { setupVeris, verisReceipt, verisTeardown } from '../src/index.mjs'

const t0 = Date.now()
const mark = (l) => console.log(`[t+${((Date.now() - t0) / 1000).toFixed(1)}s] ${l}`)

const sbx = await Sandbox.create({ timeoutMs: 15 * 60 * 1000 })   // plain 'base' template
mark(`plain base sandbox ${sbx.sandboxId} — no custom template anywhere`)
try {
  await setupVeris(sbx, {
    binaryPath: './veris-proxy-linux-amd64',
    apiKey: process.env.VERIS_API_KEY,
    environmentId: process.env.VERIS_ENVIRONMENT_ID,
    apiBase: process.env.VERIS_API_BASE,
  })
  mark('setupVeris done — proxy up rootless on an unmodified base sandbox')

  const pre = await verisReceipt(sbx, { apiKey: process.env.VERIS_API_KEY, apiBase: process.env.VERIS_API_BASE, service: 'google-identity' })
  const idCtl = pre['google-identity'].control_url
  const tokens = await sbx.commands.run(`curl -fsS "${idCtl}/veris/data?entity_type=oauth_tokens"`, { user: 'user' })
  const bearer = tokens.stdout.match(/"access_token"\s*:\s*"([^"]+)"/)[1]
  const probe = await sbx.commands.run(`curl -fsS -H "Authorization: Bearer ${bearer}" https://www.googleapis.com/calendar/v3/users/me/calendarList | head -c 60`, { user: 'user' })
  mark('real hostname answered by the twin: ' + probe.stdout.replace(/\n/g, ' '))

  const receipt = await verisReceipt(sbx, { apiKey: process.env.VERIS_API_KEY, apiBase: process.env.VERIS_API_BASE, service: 'google-calendar' })
  mark(`receipt: google-calendar received ${receipt['google-calendar'].requests} request(s)`)
} finally {
  await verisTeardown(sbx)
  await sbx.kill()
  mark('teardown + kill done')
}
