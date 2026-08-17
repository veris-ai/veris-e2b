// The playbook, live: boot medusa-fixer, start Veris, install the agent + the
// integration-testing skill, hand Claude Code the real issue, gate on receipts,
// extract the draft-PR package. NEVER pushes or opens a PR.
import { Sandbox } from 'e2b'
import fs from 'node:fs'
import { startVeris, verisTrustEnv, verisDataPlaneEnv, verisSandboxId, verisReceipt, verisTeardown } from '../src/index.mjs'

const t0 = Date.now()
const mark = (l) => console.log(`\n=== [t+${((Date.now() - t0) / 60000).toFixed(1)}m] ${l} ===`)
const run = async (sbx, cmd, opts = {}) => {
  const r = await sbx.commands.run(cmd, { timeoutMs: 10 * 60_000, ...opts })
    .catch((e) => e.result ?? Promise.reject(e))
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  if (r.exitCode !== 0 && !opts.allowFail) throw new Error(`'${cmd.slice(0, 60)}…' exited ${r.exitCode}`)
  return r
}

const ISSUE = fs.readFileSync(new URL('./medusa-issue.md', import.meta.url), 'utf8')

const sbx = await Sandbox.create('medusa-fixer', { timeoutMs: 55 * 60_000 })
mark(`sandbox ${sbx.sandboxId}`)
try {
  await startVeris(sbx, { apiKey: process.env.VERIS_API_KEY })
  mark('veris up (rootless); twin world live')

  // agent + skill, at runtime (~1 min)
  await run(sbx, 'sudo npm install -g @anthropic-ai/claude-code@latest 2>&1 | tail -1')
  await run(sbx, 'git clone -q --depth 1 https://github.com/veris-ai/veris-skills.git /tmp/vs && mkdir -p ~/.claude/skills && cp -r /tmp/vs/skills/integration-testing ~/.claude/skills/ && ls ~/.claude/skills/integration-testing/SKILL.md')
  // Register the Veris MCP server BEFORE the agent starts (a running claude -p
  // cannot hot-add servers). This makes the skill's control-plane phases —
  // get_testing_guide, promote_sandbox, reset_sandbox — work as written.
  await run(sbx, 'claude mcp add veris --transport http "$VERIS_API_BASE/mcp" --header "X-API-Key: $VERIS_API_KEY" && claude mcp list', {
    user: 'user', envs: { VERIS_API_BASE: process.env.VERIS_API_BASE, VERIS_API_KEY: process.env.VERIS_API_KEY } })
  mark('agent + skill + veris MCP installed')

  // twin coordinates for the agent
  const twinId = await verisSandboxId(sbx)
  const services = await fetch(`${process.env.VERIS_API_BASE}/v1/sandboxes/${twinId}/services`, {
    headers: { 'X-API-Key': process.env.VERIS_API_KEY } }).then((r) => r.json())
  const stripeCtl = services.find((s) => s.name === 'stripe').control_url
  const envs = {
    ...(await verisTrustEnv(sbx)),
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    VERIS_API_KEY: process.env.VERIS_API_KEY,
    VERIS_API_BASE: process.env.VERIS_API_BASE,
    VERIS_ENVIRONMENT_ID: 'eguk42zv4iv1fetl75nboxyt9',
    VERIS_SANDBOX_ID: twinId,
    STRIPE_CONTROL_URL: stripeCtl,
    STRIPE_API_KEY: 'sk_test_veris_sandbox',
    DB_URL: 'postgres://user@localhost/medusa_test',
    DATABASE_URL: 'postgres://user@localhost/medusa_test',
  }
  mark(`twin ${twinId}; stripe control: ${stripeCtl}`)

  const TASK = `Work in the local clone at ~/medusa (branch off from the current checkout). Read the issue below and resolve the defect it describes.

<issue>
${ISSUE}
</issue>

Environment notes, read carefully:
- The Veris interception tier is ALREADY RUNNING on this machine: every request to Stripe's production hostname (api.stripe.com) is answered by a stateful Veris Stripe sandbox. Do not install veris-proxy, do not look for docker or an MCP server — that preflight is done. STRIPE_API_KEY in your environment works against it.
- Your instruments: the ~/.claude/skills/integration-testing skill describes the testing METHODOLOGY (seeding, fault injection, reading receipts) — follow its discipline, skip its setup phases. The sandbox's request log is at $STRIPE_CONTROL_URL/veris/requests (check Idempotency-Key headers there); its manual is at $STRIPE_CONTROL_URL/veris/manual; seed via $STRIPE_CONTROL_URL/veris/data.
- A local Postgres is running (DB_URL is set) for the module's integration tests. yarn 3.2.1 via corepack; dependencies are already installed. Do NOT run a full monorepo build — build only what you need (npx turbo run build --filter=... or run jest directly).
- Reproduce the defect BEFORE fixing it: demonstrate on the wire (the request log) that a retry after a provider failure carries a different Idempotency-Key. After your fix, demonstrate the retry carries the SAME key. An integration test that pins this behavior must be part of your change.
- Prepare the work as a pull request WITHOUT opening one: create branch fix/capture-idempotency-key, commit your change (small, isolated), add a changeset (.changeset/*.md, patch bump for @medusajs/payment), and write the full PR body to ~/PR.md with sections: What / Why / How / Testing. In Testing, state what you VERIFIED and how (quote the wire evidence), and what you are ASSUMING rather than verifying, and why. Do NOT run gh, do NOT push, do NOT open any PR.

You are running non-interactively: nothing will notify you when a backgrounded command finishes — poll it yourself. Keep working until you are confident the fix is correct; you decide when that is.`

  await run(sbx, `cat > ~/TASK.md << 'VERIS_TASK_EOF'\n${TASK}\nVERIS_TASK_EOF`, {})
  mark('task written; invoking the agent (this is the long step)')

  const agent = await run(sbx,
    'cd ~/medusa && claude -p "$(cat ~/TASK.md)" --dangerously-skip-permissions --output-format text 2>&1 | tee ~/agent.log | tail -80',
    { user: 'user', envs, timeoutMs: 40 * 60_000, allowFail: true })
  mark(`agent finished (exit ${agent.exitCode})`)

  // ---- the gate, from outside the box ----
  const receipt = await verisReceipt(sbx, { apiKey: process.env.VERIS_API_KEY, apiBase: process.env.VERIS_API_BASE, service: 'stripe' })
  fs.writeFileSync('medusa-receipt.json', JSON.stringify(receipt, null, 2))
  mark(`receipt captured: stripe received ${receipt.stripe.requests} request(s)`)

  // ---- extract the draft-PR package ----
  await run(sbx, 'cd ~/medusa && git status --short | head -20 && git log --oneline -3 && git diff main --stat | tail -8', { user: 'user', allowFail: true })
  const patch = await run(sbx, 'cd ~/medusa && git diff ' + '$(git merge-base HEAD origin/develop 2>/dev/null || echo HEAD~1)' + ' > ~/fix.patch 2>/dev/null; wc -c ~/fix.patch; cat ~/fix.patch | head -5', { user: 'user', allowFail: true })
  for (const [remote, local] of [['/home/user/PR.md', 'medusa-PR.md'], ['/home/user/fix.patch', 'medusa-fix.patch'], ['/home/user/agent.log', 'medusa-agent.log']]) {
    try { fs.writeFileSync(local, await sbx.files.read(remote)) ; console.log('extracted', local) } catch (e) { console.log('missing:', remote) }
  }
  mark('extraction done')
} finally {
  await verisTeardown(sbx)
  await sbx.kill()
  mark('teardown + kill complete')
}
