import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Sandbox as E2B, CommandExitError, NotFoundError, TimeoutError } from 'e2b'
import { Sandbox } from './sandbox'
import { MissingCredentialsError } from './errors'
import { CA_INSTALL_CMD, SYSTEM_BUNDLE } from './trust'
import { SDK_VERSION } from './version'
import { credentials } from './cli-profile'
import { HELP, ROOT_HELP, UPLOAD_EXCLUDES, UsageError, parseOptions, shellQuote } from './cli-options'
import type { Options } from './cli-options'
import { BUNDLED_CA_PATCH_SCRIPT, bundledCaPatchScript } from './cli-trust'

const OWNER = 'veris_cli'
const WORK = 'veris_cli_workdir'
const OWNER_VALUE = 'hosted-v1'
const say = (text: string) => { process.stderr.write(`${text}\n`) }

function e2bKey(): string {
  const key = process.env.E2B_API_KEY
  if (!key) throw new MissingCredentialsError('E2B_API_KEY is not set; get a key at https://e2b.dev/dashboard', { phase: 'credentials' })
  return key
}

async function ownedInfo(id: string, apiKey: string) {
  const info = await E2B.getInfo(id, { apiKey })
  const meta = info.metadata
  if (meta[OWNER] !== OWNER_VALUE || meta.veris_owns_twin !== 'false' || meta.veris_mode !== 'gateway' || !meta.veris_sandbox_id) {
    throw new Error(`${id} was not provisioned by this CLI; refusing to manage an SDK or session-owned box`)
  }
  const workDir = meta[WORK]
  if (!workDir?.startsWith('/') || workDir === '/' || /[\0\r\n]/.test(workDir) || workDir.split('/').includes('..')) throw new Error(`${id} has no valid CLI work directory`)
  return { info, workDir }
}

async function connect(id: string, apiKey: string) {
  const { workDir, info } = await ownedInfo(id, apiKey)
  const sbx = await Sandbox.connect(id, { apiKey, veris: credentials() })
  if (sbx.verisSandboxId !== info.metadata.veris_sandbox_id || sbx.verisMode !== 'gateway') throw new Error('unexpected twin or routing mode after connect')
  // connect refreshes the CA file; rebuild system/JVM/NSS trust for that cert
  // and for runtimes installed since provision before running a user command.
  await sbx.commands.run(CA_INSTALL_CMD, { user: 'root', timeoutMs: 60_000 })
  return { sbx, workDir }
}

async function provision(opts: Extract<Options, { verb: 'provision' }>, apiKey: string): Promise<number> {
  const veris = credentials()
  say(`Provisioning E2B template ${opts.template} on Veris twin ${opts.twinId}`)
  const sbx = await Sandbox.create(opts.template, {
    apiKey, timeoutMs: opts.timeoutMs, envs: opts.env,
    network: { allowPublicTraffic: opts.publicTraffic },
    metadata: { [OWNER]: OWNER_VALUE, [WORK]: opts.workDir },
    veris: { ...veris, attachSandboxId: opts.twinId, mode: 'gateway', egress: 'strict', allowOut: opts.allowOut },
  })
  say(`E2B box ${sbx.sandboxId}; twin ${sbx.verisSandboxId} remains yours`)
  try {
    if (sbx.verisSandboxId !== opts.twinId || sbx.verisMode !== 'gateway') throw new Error('unexpected twin or routing mode')
    await sbx.commands.run(`mkdir -p ${shellQuote(opts.workDir)}`, { timeoutMs: 60_000 })
    await sbx.files.write(BUNDLED_CA_PATCH_SCRIPT, bundledCaPatchScript())
    const services = await sbx.veris.services()
    const info = await sbx.getInfo()
    const runner = `npx --yes --package=@veris-ai/e2b@${SDK_VERSION} veris-e2b`
    process.stdout.write(JSON.stringify({
      e2bSandboxId: sbx.sandboxId, verisSandboxId: sbx.verisSandboxId,
      verisEnvironmentId: info.metadata.veris_env_id, ownsTwin: false,
      template: opts.template, workDir: opts.workDir, caBundlePath: SYSTEM_BUNDLE,
      trustEnv: await sbx.veris.getTrustEnv(), services: services.map(s => s.name),
      expiresAt: info.endAt.toISOString(),
      patchBundledCasCommand: `sh ${BUNDLED_CA_PATCH_SCRIPT}`,
      pushCommand: `${runner} push ${shellQuote(sbx.sandboxId)}`,
      execCommand: `${runner} exec ${shellQuote(sbx.sandboxId)} -- <command>`,
      teardownCommand: `${runner} teardown ${shellQuote(sbx.sandboxId)}`,
    }) + '\n')
    return 0
  } catch (error) {
    try { await E2B.kill(sbx.sandboxId, { apiKey }) }
    catch { say(`Cleanup failed; delete E2B box ${sbx.sandboxId} with veris-e2b teardown. The twin was not deleted.`) }
    throw error
  }
}

async function push(opts: Extract<Options, { verb: 'push' }>, apiKey: string): Promise<number> {
  // Pack before connecting so missing local tar/source cannot alter the remote box.
  const archive = execFileSync('tar', ['czf', '-', ...UPLOAD_EXCLUDES.map(x => `--exclude=${x}`), '-C', opts.source, '.'], {
    maxBuffer: 1024 * 1024 * 1024, env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  const { sbx, workDir } = await connect(opts.sandboxId, apiKey)
  const remote = `/tmp/veris-upload-${randomUUID()}.tgz`
  try {
    await sbx.files.write(remote, archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer)
    await sbx.commands.run(`tar -xzf ${shellQuote(remote)} -C ${shellQuote(workDir)}`, { timeoutMs: 120_000 })
    say(`Uploaded ${archive.length} bytes into ${workDir}; exclusions: ${UPLOAD_EXCLUDES.join(', ')}`)
  } finally {
    await sbx.files.remove(remote).catch(() => { say(`Could not remove temporary upload ${remote}; it expires with the box`) })
  }
  return 0
}

async function exec(opts: Extract<Options, { verb: 'exec' }>, apiKey: string): Promise<number> {
  const { sbx, workDir } = await connect(opts.sandboxId, apiKey)
  const envs = { ...await sbx.veris.getDataPlaneEnv(), ...await sbx.veris.getTrustEnv(), ...opts.env }
  const abort = new AbortController()
  let interrupted = 0
  const interrupt = () => { interrupted = 130; abort.abort() }
  const terminate = () => { interrupted = 143; abort.abort() }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  let handle: Awaited<ReturnType<typeof sbx.commands.connect>> | undefined
  try {
    handle = await sbx.commands.run(opts.command, {
      cwd: opts.cwd ?? workDir, envs, background: true, timeoutMs: opts.timeoutMs, signal: abort.signal,
      onStdout: text => { process.stdout.write(text) }, onStderr: text => { process.stderr.write(text) },
    })
    return (await handle.wait()).exitCode
  } catch (error) {
    if (error instanceof CommandExitError) return error.exitCode
    // Dropping an SDK stream does not establish that the remote process stopped.
    if (handle) await handle.kill()
    if (interrupted) return interrupted
    if (error instanceof TimeoutError) { say(`Command timed out after ${opts.timeoutMs / 1000}s`); return 124 }
    throw error
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    const opts = parseOptions(argv)
    if (opts.verb === 'help') { process.stdout.write(opts.text + '\n'); return 0 }
    if (opts.verb === 'version') { process.stdout.write(SDK_VERSION + '\n'); return 0 }
    const apiKey = e2bKey()
    if (opts.verb === 'provision') return await provision(opts, apiKey)
    if (opts.verb === 'push') return await push(opts, apiKey)
    if (opts.verb === 'exec') return await exec(opts, apiKey)
    try {
      await ownedInfo(opts.sandboxId, apiKey)
      await E2B.kill(opts.sandboxId, { apiKey })
      say(`Deleted E2B box ${opts.sandboxId}; no Veris twin was touched`)
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error
      say(`E2B box ${opts.sandboxId} is already absent; no Veris twin was touched`)
    }
    return 0
  } catch (error) {
    say(error instanceof Error ? error.message : 'E2B operation failed')
    if (error instanceof UsageError) {
      const verb = argv[0]
      say(verb && Object.hasOwn(HELP, verb) ? HELP[verb as keyof typeof HELP] : ROOT_HELP)
    }
    return error instanceof UsageError || error instanceof MissingCredentialsError ? 2 : 1
  }
}
