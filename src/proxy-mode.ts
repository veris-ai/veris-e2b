// Internal proxy-mode machinery: run veris-proxy INSIDE the sandbox (nftables
// redirect + a snapshot-parked supervisor). Used by the Sandbox class for
// `mode: 'proxy'` — the fallback for control planes that don't offer gateway
// mode, and the only path for self-hosted E2B (no BYOP). Not a public API.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import type { Sandbox, CommandResult } from 'e2b'

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets')

// A pooled Buffer's .buffer can be larger than the content; slice exactly.
const toArrayBuffer = (buf: Buffer): ArrayBuffer =>
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer

// The proxy release this package version is tested against.
const PROXY = { repo: 'veris-ai/veris-proxy', version: 'v0.6.2', asset: 'veris-proxy-linux-amd64' }

/**
 * Find the veris-proxy binary. binaryPath is an OVERRIDE, not a requirement —
 * the default resolution chain: explicit → $VERIS_PROXY_BINARY → package cache
 * → public release URL → `gh release download`.
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
    `  - set $VERIS_PROXY_BINARY to a local ${PROXY.asset}, or\n` +
    `  - authenticate GitHub CLI with access to ${PROXY.repo} (gh auth login), or\n` +
    `  - download ${PROXY.asset} from the ${PROXY.repo} ${PROXY.version} release.`)
}

export interface SetupProxyOpts {
  binaryPath?: string
  apiKey: string
  environmentId: string
  apiBase?: string
  timeoutSec?: number
}

/**
 * Install veris-proxy into a RUNNING sandbox and start it: apt-get the deps,
 * upload the binary + assets, create the unprivileged `veris` user, and boot
 * the proxy with the coordinates in its process env (no secret hits disk).
 * Resolves once the proxy is serving and its per-run twin is provisioned.
 */
export async function setupProxy(sandbox: Sandbox, opts: SetupProxyOpts): Promise<CommandResult> {
  const { binaryPath: explicitBinary, apiKey, environmentId, apiBase, timeoutSec = 240 } = opts
  if (!apiKey || !environmentId) {
    throw new Error('setupProxy: apiKey and environmentId are required')
  }
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
  return proxyReady(sandbox, timeoutSec)
}

/** Wait until the proxy is serving and its per-run twin is provisioned. */
export async function proxyReady(sandbox: Sandbox, timeoutSec = 240): Promise<CommandResult> {
  const r = await sandbox.commands.run(
    `for i in $(seq 1 ${timeoutSec}); do [ -f /veris/ready ] && exit 0; sleep 1; done; ` +
    'echo "veris-proxy never became ready:" >&2; cat /veris/boot.log /veris/serve.log >&2 2>/dev/null; exit 1',
    { user: 'root', timeoutMs: (timeoutSec + 30) * 1000 })
  await sandbox.commands.run('chmod a+r /veris/trust.env 2>/dev/null; chmod -R a+rX /veris/ca', { user: 'root' })
  return r
}

/** The trust material the code under test needs (JAVA_TOOL_OPTIONS, CA paths…), as an env object. */
export async function proxyTrustEnv(sandbox: Sandbox): Promise<Record<string, string>> {
  const r = await sandbox.commands.run('cat /veris/trust.env', { user: 'root' })
  const envs: Record<string, string> = {}
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^export ([A-Za-z_][A-Za-z0-9_]*)=(?:'(.*)'|"(.*)"|(.*))$/)
    if (m && m[1]) envs[m[1]] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  return envs
}

/** The id of the per-run twin this sandbox's in-box proxy deployed. */
export async function proxySandboxId(sandbox: Sandbox): Promise<string> {
  const r = await sandbox.commands.run(
    "grep -oE 'sandbox_id=[a-z0-9]+' /veris/serve.log | head -1 | cut -d= -f2", { user: 'root' })
  const id = r.stdout.trim()
  if (!id) throw new Error('no Veris sandbox id in /veris/serve.log — is the proxy up?')
  return id
}

/** Stop the proxy so it deletes its per-run twin (TTL is the backstop). */
export async function proxyTeardown(sandbox: Sandbox): Promise<void> {
  await sandbox.commands.run(
    'pkill -TERM -x veris-proxy 2>/dev/null; for i in $(seq 1 20); do pgrep -x veris-proxy >/dev/null || exit 0; sleep 1; done',
    { user: 'root' }).catch(() => {})
}
