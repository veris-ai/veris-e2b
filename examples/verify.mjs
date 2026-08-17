// End-to-end verification of the package against real E2B + real Veris dev.
import { Sandbox, Template } from 'e2b'
import { withVeris, startVeris, verisReceipt, verisTeardown } from '../src/index.mjs'

const t0 = Date.now()
const mark = (l) => console.log(`[t+${((Date.now() - t0) / 1000).toFixed(1)}s] ${l}`)

mark('building template via fluent SDK (Build System 2.0)…')
const template = withVeris(Template().fromBaseImage(), { binaryPath: './veris-proxy-linux-amd64' })
await Template.build(template, { alias: 'veris-sdk-test', cpuCount: 2, memoryMB: 1024 })
mark('template veris-sdk-test built')

const sbx = await Sandbox.create('veris-sdk-test', { timeoutMs: 15 * 60 * 1000 })
mark(`sandbox ${sbx.sandboxId}`)
try {
  await sbx.commands.run('nft list table ip veris >/dev/null && pgrep -f boot.sh >/dev/null && echo "snapshot: rules live, supervisor parked"', { user: 'root' })
  await startVeris(sbx, {
    apiKey: process.env.VERIS_API_KEY,
    environmentId: process.env.VERIS_ENVIRONMENT_ID,
    apiBase: process.env.VERIS_API_BASE,
  })
  mark('proxy ready (rootless)')

  const receiptBefore = await verisReceipt(sbx, { apiKey: process.env.VERIS_API_KEY, apiBase: process.env.VERIS_API_BASE, service: 'google-identity' })
  const idCtl = receiptBefore['google-identity'].control_url
  const tokens = await sbx.commands.run(`curl -fsS "${idCtl}/veris/data?entity_type=oauth_tokens"`, { user: 'user' })
  const bearer = tokens.stdout.match(/"access_token"\s*:\s*"([^"]+)"/)[1]
  const probe = await sbx.commands.run(`curl -fsS -H "Authorization: Bearer ${bearer}" https://www.googleapis.com/calendar/v3/users/me/calendarList | head -c 120`, { user: 'user' })
  mark('real-hostname call answered by the twin: ' + probe.stdout.slice(0, 60).replace(/\n/g, ' '))

  const receipt = await verisReceipt(sbx, { apiKey: process.env.VERIS_API_KEY, apiBase: process.env.VERIS_API_BASE, service: 'google-calendar' })
  mark(`receipt: google-calendar received ${receipt['google-calendar'].requests} request(s)`)
} finally {
  await verisTeardown(sbx)
  await sbx.kill()
  mark('teardown + kill done')
}
