// End-to-end verification: stand up a sandbox, read the credentials the mocks
// publish, make authenticated calls to real vendor hostnames, and prove from
// the receipt that the mocks served them.
//
//   E2B_API_KEY=… VERIS_API_KEY=… VERIS_ENVIRONMENT_ID=… node examples/verify.mjs
//
// The environment must include google-calendar, google-identity and stripe.
//
// Nothing here configures an endpoint: the code inside the sandbox dials
// api.stripe.com and www.googleapis.com, and interception happens outside it.
// Credentials are READ from each service, never invented — an invented one is
// refused exactly as the real vendor would refuse it.
import { Sandbox } from '@veris-ai/e2b'

const t0 = Date.now()
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
const log = (m) => console.log(`[${el()}] ${m}`)

const sbx = await Sandbox.create({
  timeoutMs: 15 * 60_000,
  veris: { mode: 'proxy', apiBase: process.env.VERIS_API_BASE ?? 'https://svc.dev.api.veris.ai' },
})
log(`sandbox ${sbx.sandboxId} · veris ${sbx.verisSandboxId} · mode ${sbx.verisMode}`)

try {
  // --- 1. Read credentials the mocks publish. This is the "how do I identify"
  //        step: services publish working credentials at /veris/data; you read
  //        them, you never invent them.
  const services = Object.fromEntries((await sbx.veris.services()).map((s) => [s.name, s]))
  const tokens = await fetch(`${services['google-identity'].control_url}/veris/data?entity_type=oauth_tokens`)
    .then((r) => r.json())
  const active = tokens.rows.find((t) => t.status === 'active')
  log(`google-identity published ${tokens.rows.length} tokens; using ${active.id} (status=${active.status})`)

  // Stripe publishes its key the same way: config.api_keys. Read it, never
  // invent one -- an invented key is refused exactly as the real vendor would.
  const cfg = await fetch(`${services['stripe'].control_url}/veris/data?entity_type=config`).then((r) => r.json())
  const stripeKey = cfg.rows[0].api_keys[0]
  log(`stripe published key ${stripeKey.slice(0, 12)}… (${cfg.rows[0].api_keys.length} keys)`)

  // --- 2. Google Calendar with that bearer -> expect 200.
  const cal = await sbx.commands.run(
    `curl -sS -o /tmp/cal.json -w '%{http_code}' ` +
    `https://www.googleapis.com/calendar/v3/users/me/calendarList ` +
    `-H "Authorization: Bearer ${active.access_token}"`, { user: 'user', timeoutMs: 60_000 })
  const calBody = (await sbx.commands.run('head -c 200 /tmp/cal.json', { user: 'user' })).stdout
  log(`GET www.googleapis.com/calendar/v3/users/me/calendarList -> ${cal.stdout.trim()}`)
  log(`   ${calBody.replace(/\s+/g, ' ').slice(0, 150)}`)

  // --- 3. Stripe: any well-formed key authenticates (zero-provisioning) -> 200.
  const stripe = await sbx.commands.run(
    `curl -sS -o /tmp/st.json -w '%{http_code}' https://api.stripe.com/v1/customers?limit=2 -u ${stripeKey}:`,
    { user: 'user', timeoutMs: 60_000 })
  const stBody = (await sbx.commands.run('head -c 200 /tmp/st.json', { user: 'user' })).stdout
  log(`GET api.stripe.com/v1/customers -> ${stripe.stdout.trim()}`)
  log(`   ${stBody.replace(/\s+/g, ' ').slice(0, 150)}`)

  // --- 4. A write, to prove state is real and not a canned reply.
  const created = await sbx.commands.run(
    `curl -sS -o /tmp/new.json -w '%{http_code}' https://api.stripe.com/v1/customers -u ${stripeKey}: ` +
    `-d "email=proxy-verify@example.com" -d "name=Proxy Verify"`, { user: 'user', timeoutMs: 60_000 })
  const newId = JSON.parse((await sbx.commands.run('cat /tmp/new.json', { user: 'user' })).stdout).id
  log(`POST api.stripe.com/v1/customers -> ${created.stdout.trim()} (${newId})`)
  const reread = await sbx.commands.run(
    `curl -sS https://api.stripe.com/v1/customers/${newId} -u ${stripeKey}: | head -c 120`, { user: 'user' })
  log(`   re-read: ${reread.stdout.replace(/\s+/g, ' ').slice(0, 110)}`)

  // --- 5. The receipt: what the mocks actually saw.
  const receipt = await sbx.veris.receipt()
  log(`receipt (mode=${receipt.mode}, integrity=${receipt.integrity}):`)
  for (const [name, e] of Object.entries(receipt.services)) {
    console.log(`     ${name.padEnd(17)} ${e.requests} request(s)`)
    for (const r of e.entries.slice(0, 3)) console.log(`       ${r.method} ${r.path} -> ${r.status}`)
  }
  // assertTouched proves the mock was REACHED; assert the statuses too so a
  // 401 can never read as a pass.
  await sbx.veris.assertTouched('google-calendar')
  await sbx.veris.assertTouched('stripe', { method: 'POST', path: '/v1/customers' })
  const ok = [cal.stdout.trim(), stripe.stdout.trim(), created.stdout.trim()]
  if (!ok.every((c) => c.startsWith('2'))) throw new Error(`expected 2xx everywhere, got ${ok.join(', ')}`)
  log('PASS — authenticated calls returned 2xx and the receipt proves the mocks served them')
} catch (e) {
  log(`FAIL: ${e.message}`)
  process.exitCode = 1
} finally {
  await sbx.kill()
  log('torn down')
}
