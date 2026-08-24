// Legacy v1 surface: the in-sandbox proxy machinery (proxy mode).
//
// Build time:  withVeris(template, opts)  — layer veris-proxy, its kernel
//              redirect, and a snapshot-parked supervisor onto ANY template.
// Run time:    setupVeris / startVeris / verisReady / verisTrustEnv /
//              verisReceipt — drive a Veris-layered sandbox and prove what it
//              intercepted.
//
// Everything here was verified against real E2B infrastructure (Aug 2026):
// rules and supervisor survive the template snapshot; clones run rootless.
// The class API (../sandbox.ts) reuses these internals for `mode: 'proxy'`;
// the free functions remain exported, deprecated, for v1 callers.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { waitForFile } from 'e2b'
import type { Sandbox, TemplateBuilder, CommandResult } from 'e2b'

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets')

const shq = (v: string) => `'${String(v).replace(/'/g, `'\\''`)}'`

// A pooled Buffer's .buffer can be larger than the content; slice exactly.
const toArrayBuffer = (buf: Buffer): ArrayBuffer =>
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer

// The proxy release this package version is tested against.
const PROXY = { repo: 'veris-ai/veris-proxy', version: 'v0.6.2', asset: 'veris-proxy-linux-amd64' }

/**
 * Find the veris-proxy binary. binaryPath is an OVERRIDE, not a
 * requirement — the default resolution chain:
 *   1. explicit binaryPath
 *   2. $VERIS_PROXY_BINARY
 *   3. the package cache (~/.cache/veris-e2b/<version>/)
 *   4. the public release URL (starts working the day releases go public)
 *   5. `gh release download` (works today for anyone with repo access)
 */
export function resolveBinary(explicit?: string): string {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`binaryPath ${explicit} does not exist`)
    return explicit
  }
  const fromEnv = process.env.VERIS_PROXY_BINARY
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv

  const cacheDir = path.join(os.homedir(), '.cache', 'veris-e2b', PROXY.version)
  const cached = path.join(cacheDir, PROXY.asset)
  // A prior interrupted download can leave a truncated binary here — only trust
  // a cached copy that passes the same size check a fresh download must.
  const looksComplete = (p: string) => fs.existsSync(p) && fs.statSync(p).size > 1_000_000
  if (looksComplete(cached)) return cached

  fs.mkdirSync(cacheDir, { recursive: true })
  // Download to a temp path and rename only on success, so a dropped connection
  // never leaves a partial binary at the final cache path.
  const tmp = `${cached}.download`
  const url = `https://github.com/${PROXY.repo}/releases/download/${PROXY.version}/${PROXY.asset}`
  try {
    execFileSync('curl', ['-fsSL', '-o', tmp, url], { stdio: 'pipe' })
    if (looksComplete(tmp)) { fs.renameSync(tmp, cached); return cached }
  } catch { /* private release: fall through to gh */ }
  fs.rmSync(tmp, { force: true })
  try {
    execFileSync('gh', ['release', 'download', PROXY.version, '--repo', PROXY.repo,
      '-p', PROXY.asset, '-O', tmp, '--clobber'], { stdio: 'pipe' })
    if (looksComplete(tmp)) { fs.renameSync(tmp, cached); return cached }
  } catch { /* no gh or no access */ }
  fs.rmSync(tmp, { force: true })
  fs.rmSync(cached, { force: true })
  throw new Error(
    `veris-proxy binary not found. Either:\n` +
    `  - pass opts.binaryPath / set $VERIS_PROXY_BINARY to a local ${PROXY.asset}, or\n` +
    `  - authenticate GitHub CLI with access to ${PROXY.repo} (gh auth login), or\n` +
    `  - download ${PROXY.asset} from the ${PROXY.repo} ${PROXY.version} release.`)
}

export interface WithVerisOpts {
  /** Override the proxy binary. Default resolution: $VERIS_PROXY_BINARY → package cache → public release URL → `gh release download`. */
  binaryPath?: string
  /** 'local' (default): resolve on this machine and upload as a layer. 'remote': the E2B build fetches the pinned release itself. */
  binarySource?: 'local' | 'remote'
  /** Bake the Veris environment id → template is pre-wired (per-customer pattern). */
  environmentId?: string
  /** Bake the API key too → zero-touch clones. Private templates only. */
  apiKey?: string
  /** Non-default Veris control plane URL. */
  apiBase?: string
  /** Defer CA minting to each clone's first wake. REQUIRED before publishing a template publicly. */
  mintCaAtBoot?: boolean
  /** The template's own start command to chain before the Veris supervisor. */
  startCmd?: string
}

/**
 * Layer Veris interception onto any Build System 2.0 template (proxy mode).
 * @deprecated Gateway mode needs no template layering — build a plain e2b
 * template and use `Sandbox.create('tpl', { veris: {...} })`. Kept for
 * proxy-mode templates; the class auto-detects them.
 */
export function withVeris(template: TemplateBuilder, opts: WithVerisOpts = {}): TemplateBuilder {
  const { binaryPath: explicitBinary, binarySource = 'local', environmentId, apiKey, apiBase, mintCaAtBoot = false, startCmd } = opts
  const binaryPath = binarySource === 'remote' ? null : resolveBinary(explicitBinary)

  // The SDK's .copy() only accepts paths relative to the template's build
  // context (by default, the directory of the file that constructed it). So
  // stage our assets into `.veris-e2b/` inside that context — read straight
  // off the template instance so this works wherever the customer builds.
  // Add `.veris-e2b/` to .gitignore; it's regenerated on every build.
  const ctx = String((template as { fileContextPath?: unknown }).fileContextPath ?? process.cwd())
  const stageAbs = path.join(ctx, '.veris-e2b')
  fs.mkdirSync(stageAbs, { recursive: true })
  for (const asset of ['redirect.nft', 'dummy.json', 'boot.sh']) {
    fs.copyFileSync(path.join(ASSETS, asset), path.join(stageAbs, asset))
  }
  const stage = '.veris-e2b'
  if (binaryPath) fs.copyFileSync(binaryPath, path.join(stageAbs, 'veris-proxy'))

  let t = template
    .runCmd('apt-get update -qq && apt-get install -y -qq nftables ca-certificates curl', { user: 'root' })
    .runCmd('useradd -u 14741 -m -s /usr/sbin/nologin veris && install -d -o veris -g veris /veris /veris/ca', { user: 'root' })
  // The binary layer: uploaded from this machine, or fetched by the build
  // itself from the pinned public release (once releases are public). Either
  // way it's one cached layer per proxy version.
  t = binaryPath
    ? t.copy(`${stage}/veris-proxy`, '/usr/local/bin/veris-proxy')
    : t.runCmd(
        `curl -fsSL https://github.com/${PROXY.repo}/releases/download/${PROXY.version}/${PROXY.asset} ` +
        '-o /usr/local/bin/veris-proxy', { user: 'root' })
  t = t
    .copy(`${stage}/redirect.nft`, '/etc/veris/redirect.nft')
    .copy(`${stage}/dummy.json`, '/etc/veris/dummy.json')
    .copy(`${stage}/boot.sh`, '/etc/veris/boot.sh')
    .runCmd('chmod 755 /usr/local/bin/veris-proxy /etc/veris/boot.sh', { user: 'root' })

  // Baked coordinates ride a root-owned file, not env vars: template envs are
  // stripped by the supervisor's sudo hop, and create-time envs never reach a
  // snapshot-resumed process.
  const baked: string[] = []
  if (apiKey) baked.push(`VERIS_API_KEY=${apiKey}`)
  if (environmentId) baked.push(`VERIS_ENVIRONMENT_ID=${environmentId}`)
  if (apiBase) baked.push(`VERIS_API_BASE=${apiBase}`)
  if (mintCaAtBoot) baked.push('MINT_CA_AT=boot')
  for (const [i, line] of baked.entries()) {
    t = t.runCmd(`echo ${shq(line)} ${i === 0 ? '>' : '>>'} /etc/veris/baked.env`, { user: 'root' })
  }
  if (baked.length) t = t.runCmd('chmod 600 /etc/veris/baked.env', { user: 'root' })

  const boot = startCmd ? `${startCmd} && bash /etc/veris/boot.sh` : 'bash /etc/veris/boot.sh'
  return t.setStartCmd(boot, waitForFile('/veris/template-ready')) as unknown as TemplateBuilder
}

export interface SetupVerisOpts {
  binaryPath?: string
  apiKey: string
  environmentId: string
  apiBase?: string
  timeoutSec?: number
}

/**
 * Veris-ize a RUNNING sandbox — no template, no build step (proxy mode).
 * @deprecated Use `Sandbox.create({ veris: {...} })` from this package.
 */
export async function setupVeris(sandbox: Sandbox, opts: SetupVerisOpts): Promise<CommandResult> {
  const { binaryPath: explicitBinary, apiKey, environmentId, apiBase, timeoutSec = 240 } = opts
  if (!apiKey || !environmentId) {
    throw new Error('setupVeris: apiKey and environmentId are required')
  }
  // Validate args before the (possibly network) binary resolution.
  const binaryPath = resolveBinary(explicitBinary)

  await sandbox.commands.run(
    'apt-get update -qq && apt-get install -y -qq nftables ca-certificates',
    { user: 'root', timeoutMs: 180_000 })

  const asset = (name: string) => toArrayBuffer(fs.readFileSync(path.join(ASSETS, name)))
  await sandbox.files.write([
    { path: '/usr/local/bin/veris-proxy', data: toArrayBuffer(fs.readFileSync(binaryPath)) },
    { path: '/etc/veris/redirect.nft', data: asset('redirect.nft') },
    { path: '/etc/veris/dummy.json', data: asset('dummy.json') },
    { path: '/etc/veris/boot.sh', data: asset('boot.sh') },
  ], { user: 'root' })

  await sandbox.commands.run(
    'useradd -u 14741 -m -s /usr/sbin/nologin veris 2>/dev/null; ' +
    'install -d -o veris -g veris /veris/ca; chown veris:veris /veris 2>/dev/null; ' +
    'chmod 755 /usr/local/bin/veris-proxy /etc/veris/boot.sh',
    { user: 'root' })
  // Coordinates travel as process env on the boot.sh command itself — boot.sh
  // takes its env fast-path and no secret ever touches the filesystem.
  const bootEnvs: Record<string, string> = { VERIS_API_KEY: apiKey, VERIS_ENVIRONMENT_ID: environmentId }
  if (apiBase) bootEnvs.VERIS_API_BASE = apiBase
  await sandbox.commands.run('bash /etc/veris/boot.sh', { user: 'root', background: true, envs: bootEnvs })
  return verisReady(sandbox, timeoutSec)
}

export interface StartVerisOpts {
  apiKey?: string
  environmentId?: string
  apiBase?: string
  timeoutSec?: number
  transport?: 'env' | 'file'
}

/**
 * Start Veris in a template-built sandbox (proxy mode): hand over whatever
 * coordinates the template didn't bake, wait for the proxy + twin.
 * @deprecated Use `Sandbox.create('tpl', { veris: {...} })` from this package.
 */
export async function startVeris(sandbox: Sandbox, opts: StartVerisOpts = {}): Promise<CommandResult> {
  const { apiKey, environmentId, apiBase, timeoutSec = 240, transport = 'env' } = opts
  if (transport === 'env') {
    // boot.sh takes the env fast-path only when both required coordinates are
    // present in its process env (merged with the template's baked non-secrets
    // inside the script). Older templates lack that path — detect and fall back.
    const probe = await sandbox.commands.run(
      'grep -q "external-start" /etc/veris/boot.sh 2>/dev/null && echo env-ok || echo legacy', { user: 'root' })
    if (probe.stdout.includes('env-ok')) {
      const envs: Record<string, string> = {}
      if (apiKey) envs.VERIS_API_KEY = apiKey
      if (environmentId) envs.VERIS_ENVIRONMENT_ID = environmentId
      if (apiBase) envs.VERIS_API_BASE = apiBase
      await sandbox.commands.run('bash /etc/veris/boot.sh', { user: 'root', background: true, envs })
      return verisReady(sandbox, timeoutSec)
    }
  }
  const lines: string[] = []
  if (apiKey) lines.push(`VERIS_API_KEY=${apiKey}`)
  if (environmentId) lines.push(`VERIS_ENVIRONMENT_ID=${environmentId}`)
  if (apiBase) lines.push(`VERIS_API_BASE=${apiBase}`)
  await sandbox.files.write([{ path: '/veris/run.env', data: lines.join('\n') + '\n' }], { user: 'root' })
  return verisReady(sandbox, timeoutSec)
}

/** Wait until the proxy is serving and its per-run Veris sandbox is provisioned. */
export async function verisReady(sandbox: Sandbox, timeoutSec = 240): Promise<CommandResult> {
  const r = await sandbox.commands.run(
    `for i in $(seq 1 ${timeoutSec}); do [ -f /veris/ready ] && exit 0; sleep 1; done; ` +
    'echo "veris-proxy never became ready:" >&2; cat /veris/boot.log /veris/serve.log >&2 2>/dev/null; exit 1',
    { user: 'root', timeoutMs: (timeoutSec + 30) * 1000 })
  await sandbox.commands.run('chmod a+r /veris/trust.env 2>/dev/null; chmod -R a+rX /veris/ca', { user: 'root' })
  return r
}

/** The trust material the code under test needs (JAVA_TOOL_OPTIONS, CA paths…), as an env object. */
export async function verisTrustEnv(sandbox: Sandbox): Promise<Record<string, string>> {
  const r = await sandbox.commands.run('cat /veris/trust.env', { user: 'root' })
  const envs: Record<string, string> = {}
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^export ([A-Za-z_][A-Za-z0-9_]*)=(?:'(.*)'|"(.*)"|(.*))$/)
    if (m && m[1]) envs[m[1]] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  return envs
}

/** The id of the per-run Veris sandbox this E2B sandbox's proxy deployed. */
export async function verisSandboxId(sandbox: Sandbox): Promise<string> {
  const r = await sandbox.commands.run(
    "grep -oE 'sandbox_id=[a-z0-9]+' /veris/serve.log | head -1 | cut -d= -f2", { user: 'root' })
  const id = r.stdout.trim()
  if (!id) throw new Error('no Veris sandbox id in /veris/serve.log — is the proxy up?')
  return id
}

export interface VerisReceiptOpts {
  apiKey: string
  apiBase?: string
  service?: string
}

export interface LegacyReceiptEntry {
  requests: number
  control_url: string
  raw: unknown
}

/**
 * The receipt: what the Veris sandbox actually received, per service.
 * Green tests with an empty receipt never touched the dependency — don't trust them.
 * @deprecated Use `sbx.veris.receipt()` / `sbx.veris.assertTouched()` from this package.
 */
export async function verisReceipt(sandbox: Sandbox, opts: VerisReceiptOpts): Promise<Record<string, LegacyReceiptEntry>> {
  const { apiKey, apiBase = 'https://api.veris.ai', service } = opts
  const id = await verisSandboxId(sandbox)
  const services = await fetch(`${apiBase}/v1/sandboxes/${id}/services`, {
    headers: { 'X-API-Key': apiKey } }).then((r) => r.json()) as
    { name: string; control_url: string }[]
  const wanted = service ? services.filter((s) => s.name === service) : services
  const receipt: Record<string, LegacyReceiptEntry> = {}
  for (const svc of wanted) {
    const body = await fetch(`${svc.control_url}/veris/requests`).then((r) => r.json())
    const rows = JSON.stringify(body).match(/"method"/g)
    receipt[svc.name] = { requests: rows ? rows.length : 0, control_url: svc.control_url, raw: body }
  }
  return receipt
}

/**
 * Env vars for the twin world's NON-HTTP services (data planes): each maps
 * its documented env_hint to its connection string — e.g. the platform's
 * `postgres` service yields { DATABASE_URL: 'postgresql://…' }. The kernel
 * redirect never touches these (not ports 80/443); the DSN is handed over the
 * same way production hands it: as configuration.
 * @deprecated Use `sbx.veris.getDataPlaneEnv()` from this package (auto-injected at create).
 */
export async function verisDataPlaneEnv(sandbox: Sandbox, opts: { apiKey: string; apiBase?: string }): Promise<Record<string, string>> {
  const { apiKey, apiBase = 'https://api.veris.ai' } = opts
  const id = await verisSandboxId(sandbox)
  const services = await fetch(`${apiBase}/v1/sandboxes/${id}/services`, {
    headers: { 'X-API-Key': apiKey } }).then((r) => r.json()) as
    { env_hint?: string; url?: string }[]
  const envs: Record<string, string> = {}
  for (const svc of services) {
    if (svc.env_hint && svc.url && !/^https?:/.test(svc.url)) envs[svc.env_hint] = svc.url
  }
  return envs
}

/** Stop the proxy so it deletes its per-run Veris sandbox (TTL is the backstop). */
export async function verisTeardown(sandbox: Sandbox): Promise<void> {
  await sandbox.commands.run(
    'pkill -TERM -x veris-proxy 2>/dev/null; for i in $(seq 1 20); do pgrep -x veris-proxy >/dev/null || exit 0; sleep 1; done',
    { user: 'root' }).catch(() => {})
}

/** @deprecated renamed — use startVeris */
export const wakeVeris = startVeris
