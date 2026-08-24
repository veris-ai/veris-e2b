// Env-transport verification: no run.env ever, coordinates via process env only.
import { Sandbox, Template } from 'e2b'
import { withVeris, startVeris, verisReceipt, verisTeardown } from '../src/index.mjs'

const t0 = Date.now()
const mark = (l) => console.log(`[t+${((Date.now() - t0) / 1000).toFixed(1)}s] ${l}`)

const template = withVeris(Template().fromBaseImage(), {})
await Template.build(template, { alias: 'veris-envtransport-test', cpuCount: 2, memoryMB: 1024 })
mark('template built (new boot.sh)')

const sbx = await Sandbox.create('veris-envtransport-test', { timeoutMs: 15 * 60 * 1000 })
mark(`sandbox ${sbx.sandboxId}`)
try {
  await startVeris(sbx, {
    apiKey: process.env.VERIS_API_KEY,
    environmentId: process.env.VERIS_ENVIRONMENT_ID,
    apiBase: process.env.VERIS_API_BASE,
  })
  mark('startVeris returned (env transport default)')

  const probe = await sbx.commands.run(
    'grep -E "coordinates in process env|env-start" /veris/boot.log && { test -f /veris/run.env && echo "run.env EXISTS (bad)" || echo "no run.env on disk (good)"; }',
    { user: 'root' })
  process.stdout.write(probe.stdout)

  const r = await verisReceipt(sbx, { apiKey: process.env.VERIS_API_KEY, apiBase: process.env.VERIS_API_BASE, service: 'google-identity' })
  const tokens = await sbx.commands.run(`curl -fsS "${r['google-identity'].control_url}/veris/data?entity_type=oauth_tokens"`, { user: 'user' })
  const bearer = tokens.stdout.match(/"access_token"\s*:\s*"([^"]+)"/)[1]
  await sbx.commands.run(`curl -fsS -H "Authorization: Bearer ${bearer}" https://www.googleapis.com/calendar/v3/users/me/calendarList >/dev/null && echo "twin answered real hostname"`, { user: 'user' })
  const cal = await verisReceipt(sbx, { apiKey: process.env.VERIS_API_KEY, apiBase: process.env.VERIS_API_BASE, service: 'google-calendar' })
  mark(`receipt: ${cal['google-calendar'].requests} request(s)`)
} finally {
  await verisTeardown(sbx)
  await sbx.kill()
  mark('done')
}
