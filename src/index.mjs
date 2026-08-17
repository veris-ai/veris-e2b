// @veris-ai/e2b — the Veris interception layer for E2B sandboxes.
//
// Build time:  withVeris(template, opts)  — layer veris-proxy, its kernel
//              redirect, and a snapshot-parked supervisor onto ANY template.
// Run time:    startVeris / verisReady / verisTrustEnv / verisReceipt —
//              drive a Veris-layered sandbox and prove what it intercepted.
//
// Everything here was verified against real E2B infrastructure (Aug 2026):
// rules and supervisor survive the template snapshot; clones run rootless.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { waitForFile } from 'e2b'

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets')

const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`

// The proxy release this package version is tested against.
const PROXY = { repo: 'veris-ai/veris-proxy', version: 'v0.6.0', asset: 'veris-proxy-linux-amd64' }

/**
 * Find the veris-proxy binary. binaryPath is now an OVERRIDE, not a
 * requirement — the default resolution chain:
 *   1. opts.binaryPath
 *   2. $VERIS_PROXY_BINARY
 *   3. the package cache (~/.cache/veris-e2b/<version>/)
 *   4. the public release URL (starts working the day releases go public)
 *   5. `gh release download` (works today for anyone with repo access)
 */
function resolveBinary(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`binaryPath ${explicit} does not exist`)
    return explicit
  }
  const fromEnv = process.env.VERIS_PROXY_BINARY
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv

  const cacheDir = path.join(os.homedir(), '.cache', 'veris-e2b', PROXY.version)
  const cached = path.join(cacheDir, PROXY.asset)
  if (fs.existsSync(cached)) return cached

  fs.mkdirSync(cacheDir, { recursive: true })
  const url = `https://github.com/${PROXY.repo}/releases/download/${PROXY.version}/${PROXY.asset}`
  try {
    execFileSync('curl', ['-fsSL', '-o', cached, url], { stdio: 'pipe' })
    if (fs.existsSync(cached) && fs.statSync(cached).size > 1_000_000) return cached
  } catch { /* private release: fall through to gh */ }
  try {
    execFileSync('gh', ['release', 'download', PROXY.version, '--repo', PROXY.repo,
      '-p', PROXY.asset, '-O', cached, '--clobber'], { stdio: 'pipe' })
    if (fs.existsSync(cached)) return cached
  } catch { /* no gh or no access */ }
  fs.rmSync(cached, { force: true })
  throw new Error(
    `veris-proxy binary not found. Either:\n` +
    `  - pass opts.binaryPath / set $VERIS_PROXY_BINARY to a local ${PROXY.asset}, or\n` +
    `  - authenticate GitHub CLI with access to ${PROXY.repo} (gh auth login), or\n` +
    `  - download ${PROXY.asset} from the ${PROXY.repo} ${PROXY.version} release.`)
}

/**
 * Layer Veris interception onto any Build System 2.0 template.
 *
 * @param {import('e2b').TemplateBase} template  e.g. Template().fromTemplate('my-base')
 * @param {object} opts
 * @param {string} [opts.binaryPath]    Override the proxy binary. Default resolution:
 *                                      $VERIS_PROXY_BINARY → package cache → public
 *                                      release URL → `gh release download`.
 * @param {string} [opts.environmentId] Bake the Veris environment id → template is
 *                                      pre-wired (per-customer pattern).
 * @param {string} [opts.apiKey]        Bake the API key too → zero-touch clones.
 *                                      Private templates only: the key lives in the
 *                                      stored snapshot; rotation = rebuild.
 * @param {string} [opts.apiBase]       Non-default Veris control plane URL.
 * @param {boolean} [opts.mintCaAtBoot] Defer CA minting to each clone's first wake.
 *                                      REQUIRED before publishing a template publicly,
 *                                      so clones don't share one CA private key.
 * @param {string} [opts.startCmd]      The template's own start command to chain
 *                                      before the Veris supervisor (it must exit or
 *                                      background itself; the supervisor parks).
 */
export function withVeris(template, opts = {}) {
  const { binaryPath: explicitBinary, environmentId, apiKey, apiBase, mintCaAtBoot = false, startCmd } = opts
  const binaryPath = resolveBinary(explicitBinary)

  // The SDK's .copy() only accepts paths relative to the template's build
  // context (by default, the directory of the file that constructed it). So
  // stage our assets into `.veris-e2b/` inside that context — read straight
  // off the template instance so this works wherever the customer builds.
  // Add `.veris-e2b/` to .gitignore; it's regenerated on every build.
  const ctx = template.fileContextPath ?? process.cwd()
  const stageAbs = path.join(ctx, '.veris-e2b')
  fs.mkdirSync(stageAbs, { recursive: true })
  for (const asset of ['redirect.nft', 'dummy.json', 'boot.sh']) {
    fs.copyFileSync(path.join(ASSETS, asset), path.join(stageAbs, asset))
  }
  fs.copyFileSync(binaryPath, path.join(stageAbs, 'veris-proxy'))
  const stage = '.veris-e2b'
  const binary = `${stage}/veris-proxy`

  let t = template
    .runCmd('apt-get update -qq && apt-get install -y -qq nftables ca-certificates', { user: 'root' })
    .runCmd('useradd -u 14741 -m -s /usr/sbin/nologin veris && install -d -o veris -g veris /veris /veris/ca', { user: 'root' })
    .copy(binary, '/usr/local/bin/veris-proxy')
    .copy(`${stage}/redirect.nft`, '/etc/veris/redirect.nft')
    .copy(`${stage}/dummy.json`, '/etc/veris/dummy.json')
    .copy(`${stage}/boot.sh`, '/etc/veris/boot.sh')
    .runCmd('chmod 755 /usr/local/bin/veris-proxy /etc/veris/boot.sh', { user: 'root' })

  // Baked coordinates ride a root-owned file, not env vars: template envs are
  // stripped by the supervisor's sudo hop, and create-time envs never reach a
  // snapshot-resumed process. (Both learned the hard way; both verified.)
  const baked = []
  if (apiKey) baked.push(`VERIS_API_KEY=${apiKey}`)
  if (environmentId) baked.push(`VERIS_ENVIRONMENT_ID=${environmentId}`)
  if (apiBase) baked.push(`VERIS_API_BASE=${apiBase}`)
  if (mintCaAtBoot) baked.push('MINT_CA_AT=boot')
  for (const [i, line] of baked.entries()) {
    t = t.runCmd(`echo ${shq(line)} ${i === 0 ? '>' : '>>'} /etc/veris/baked.env`, { user: 'root' })
  }
  if (baked.length) t = t.runCmd('chmod 600 /etc/veris/baked.env', { user: 'root' })

  const boot = startCmd ? `${startCmd} && bash /etc/veris/boot.sh` : 'bash /etc/veris/boot.sh'
  return t.setStartCmd(boot, waitForFile('/veris/template-ready'))
}

/**
 * Veris-ize a RUNNING sandbox — no template, no build step. Works on the
 * default `base` template or any template you already have, unmodified.
 *
 * This is the zero-friction path: `Sandbox.create()` then `setupVeris(...)`.
 * The trade against a withVeris() template is per-sandbox setup time
 * (~60-90s: apt install + 8MB binary upload + CA mint, vs ~1s from a
 * snapshot) and the setup commands running as root inside the disposable VM
 * (the proxy itself still runs unprivileged as uid 14741 either way).
 * Loops and CI want the template; first contact and one-offs start here.
 */
export async function setupVeris(sandbox, { binaryPath: explicitBinary, apiKey, environmentId, apiBase, timeoutSec = 240 }) {
  const binaryPath = resolveBinary(explicitBinary)
  if (!apiKey || !environmentId) {
    throw new Error('setupVeris: apiKey and environmentId are required')
  }

  await sandbox.commands.run(
    'apt-get update -qq && apt-get install -y -qq nftables ca-certificates',
    { user: 'root', timeoutMs: 180_000 })

  const asset = (name) => fs.readFileSync(path.join(ASSETS, name))
  const lines = [`VERIS_API_KEY=${apiKey}`, `VERIS_ENVIRONMENT_ID=${environmentId}`]
  if (apiBase) lines.push(`VERIS_API_BASE=${apiBase}`)
  await sandbox.files.write([
    { path: '/usr/local/bin/veris-proxy', data: fs.readFileSync(binaryPath) },
    { path: '/etc/veris/redirect.nft', data: asset('redirect.nft') },
    { path: '/etc/veris/dummy.json', data: asset('dummy.json') },
    { path: '/etc/veris/boot.sh', data: asset('boot.sh') },
    // run.env exists before boot.sh starts, so its park loop exits on the
    // first tick — same script, no waiting phase.
    { path: '/veris/run.env', data: lines.join('\n') + '\n' },
  ], { user: 'root' })

  await sandbox.commands.run(
    'useradd -u 14741 -m -s /usr/sbin/nologin veris 2>/dev/null; ' +
    'install -d -o veris -g veris /veris/ca; chown veris:veris /veris 2>/dev/null; ' +
    'chmod 755 /usr/local/bin/veris-proxy /etc/veris/boot.sh',
    { user: 'root' })
  await sandbox.commands.run('bash /etc/veris/boot.sh', { user: 'root', background: true })
  return verisReady(sandbox, timeoutSec)
}

/**
 * Start Veris in a template-built sandbox: hand over whatever coordinates the
 * template didn't bake, wake the supervisor, wait for the proxy + twin.
 *
 * Pass only what the template didn't bake — the supervisor merges baked.env
 * with these values (run.env wins). The recommended split: bake the
 * non-secret `environmentId` at build (per-customer templates pair 1:1 with
 * environments anyway) and pass only the `apiKey` here, so no secret ever
 * lives in a stored snapshot. An empty call is a pure wake trigger for
 * templates that baked everything.
 */
export async function startVeris(sandbox, { apiKey, environmentId, apiBase, timeoutSec = 240 } = {}) {
  const lines = []
  if (apiKey) lines.push(`VERIS_API_KEY=${apiKey}`)
  if (environmentId) lines.push(`VERIS_ENVIRONMENT_ID=${environmentId}`)
  if (apiBase) lines.push(`VERIS_API_BASE=${apiBase}`)
  await sandbox.files.write([{ path: '/veris/run.env', data: lines.join('\n') + '\n' }], { user: 'root' })
  return verisReady(sandbox, timeoutSec)
}

/** Wait until the proxy is serving and its per-run Veris sandbox is provisioned. */
export async function verisReady(sandbox, timeoutSec = 240) {
  const r = await sandbox.commands.run(
    `for i in $(seq 1 ${timeoutSec}); do [ -f /veris/ready ] && exit 0; sleep 1; done; ` +
    'echo "veris-proxy never became ready:" >&2; cat /veris/boot.log /veris/serve.log >&2 2>/dev/null; exit 1',
    { user: 'root', timeoutMs: (timeoutSec + 30) * 1000 })
  await sandbox.commands.run('chmod a+r /veris/trust.env 2>/dev/null; chmod -R a+rX /veris/ca', { user: 'root' })
  return r
}

/** The trust material the code under test needs (JAVA_TOOL_OPTIONS, CA paths…), as an env object. */
export async function verisTrustEnv(sandbox) {
  const r = await sandbox.commands.run('cat /veris/trust.env', { user: 'root' })
  const envs = {}
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^export ([A-Za-z_][A-Za-z0-9_]*)=(?:'(.*)'|"(.*)"|(.*))$/)
    if (m) envs[m[1]] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  return envs
}

/** The id of the per-run Veris sandbox this E2B sandbox's proxy deployed. */
export async function verisSandboxId(sandbox) {
  const r = await sandbox.commands.run(
    "grep -oE 'sandbox_id=[a-z0-9]+' /veris/serve.log | head -1 | cut -d= -f2", { user: 'root' })
  const id = r.stdout.trim()
  if (!id) throw new Error('no Veris sandbox id in /veris/serve.log — is the proxy up?')
  return id
}

/**
 * The receipt: what the Veris sandbox actually received, per service.
 * Green tests with an empty receipt never touched the dependency — don't trust them.
 */
export async function verisReceipt(sandbox, { apiKey, apiBase = 'https://api.veris.ai', service }) {
  const id = await verisSandboxId(sandbox)
  const services = await fetch(`${apiBase}/v1/sandboxes/${id}/services`, {
    headers: { 'X-API-Key': apiKey } }).then((r) => r.json())
  const wanted = service ? services.filter((s) => s.name === service) : services
  const receipt = {}
  for (const svc of wanted) {
    const body = await fetch(`${svc.control_url}/veris/requests`).then((r) => r.json())
    const rows = JSON.stringify(body).match(/"method"/g)
    receipt[svc.name] = { requests: rows ? rows.length : 0, control_url: svc.control_url, raw: body }
  }
  return receipt
}

/** Stop the proxy so it deletes its per-run Veris sandbox (TTL is the backstop). */
export async function verisTeardown(sandbox) {
  await sandbox.commands.run(
    'pkill -TERM -x veris-proxy 2>/dev/null; for i in $(seq 1 20); do pgrep -x veris-proxy >/dev/null || exit 0; sleep 1; done',
    { user: 'root' }).catch(() => {})
}

/** @deprecated renamed — use startVeris */
export const wakeVeris = startVeris
