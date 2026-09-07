import { Sandbox as E2B, CommandExitError, NotFoundError, TimeoutError } from 'e2b'
import { Sandbox } from './sandbox'
import { MissingCredentialsError } from './errors'
import { CA_INSTALL_CMD, SYSTEM_BUNDLE } from './trust'
import { SDK_VERSION } from './version'
import { credentials } from './cli-profile'
import { HELP, ROOT_HELP, UsageError, parseOptions, shellQuote } from './cli-options'
import type { Options } from './cli-options'
import { BUNDLED_CA_PATCH_SCRIPT, bundledCaPatchScript } from './cli-trust'
import { prepareCode, putCode } from './cli-code'
import { ControlPlane } from './control-plane'
import { fetchWatermark } from './trace'
import { isHttpUrl } from './network'
import { reportReceipt } from './cli-receipt'

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
  if (meta[OWNER] !== OWNER_VALUE || !['true', 'false'].includes(meta.veris_owns_twin!) || meta.veris_mode !== 'gateway' || !/^[A-Za-z0-9_-]+$/.test(meta.veris_sandbox_id ?? '')) {
    throw new Error(`${id} was not provisioned by this CLI; refusing to manage an SDK or session-owned box`)
  }
  const workDir = meta[WORK]
  if (!workDir?.startsWith('/') || workDir === '/' || /[\0\r\n]/.test(workDir) || workDir.split('/').includes('..')) throw new Error(`${id} has no valid CLI work directory`)
  return { info, workDir }
}

/** Both deletes are attempted; a failed twin delete must not strand compute. */
async function cleanup(id: string, apiKey: string, twin?: { id: string; environmentId: string; veris: ReturnType<typeof credentials> }): Promise<void> {
  let failed = false
  if (twin) {
    try {
      const cp = new ControlPlane({ ...twin.veris, sdkVersion: SDK_VERSION })
      await cp.deleteTwin(twin.environmentId, twin.id)
      say(`Deleted owned twin ${twin.id}`)
    } catch {
      failed = true
      say(`Cleanup failed for owned twin ${twin.id}; delete it in environment ${twin.environmentId} on ${twin.veris.apiBase}, or await its TTL`)
    }
  }
  try { await E2B.kill(id, { apiKey }); say(`Deleted E2B box ${id}`) }
  catch (error) {
    if (!(error instanceof NotFoundError)) {
      failed = true
      say(`Cleanup failed; delete E2B box ${id} with veris-e2b teardown`)
    }
  }
  if (failed) throw new Error('Resource cleanup was incomplete; follow the resource IDs above')
}

async function initialize(sbx: Sandbox, workDir: string): Promise<void> {
  if (sbx.verisMode !== 'gateway') throw new Error('unexpected routing mode')
  await sbx.commands.run(`mkdir -p ${shellQuote(workDir)}`, { timeoutMs: 60_000 })
  await sbx.files.write(BUNDLED_CA_PATCH_SCRIPT, bundledCaPatchScript())
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
    await initialize(sbx, opts.workDir)
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
  const archive = prepareCode(opts)
  const { sbx, workDir } = await connect(opts.sandboxId, apiKey)
  await putCode(sbx, workDir, opts, archive)
  return 0
}

async function exec(opts: Extract<Options, { verb: 'exec' }>, apiKey: string): Promise<number> {
  const { sbx, workDir } = await connect(opts.sandboxId, apiKey)
  return execute(sbx, opts.cwd ?? workDir, opts)
}

async function execute(sbx: Sandbox, workDir: string, opts: { command: string; env: Record<string, string>; timeoutMs: number }): Promise<number> {
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
      cwd: workDir, envs, background: true, timeoutMs: opts.timeoutMs, signal: abort.signal,
      onStdout: text => { process.stdout.write(text) }, onStderr: text => { process.stderr.write(text) },
    })
    return (await handle.wait()).exitCode
  } catch (error) {
    if (error instanceof CommandExitError) return error.exitCode
    // Dropping an SDK stream does not establish that the remote process stopped.
    if (handle) await handle.kill().catch(() => { say(`Could not stop the remote command; tear down E2B box ${sbx.sandboxId}`) })
    if (interrupted) return interrupted
    if (error instanceof TimeoutError) { say(`Command timed out after ${opts.timeoutMs / 1000}s`); return 124 }
    throw error
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
}

async function run(opts: Extract<Options, { verb: 'run' }>, apiKey: string): Promise<number> {
  let stopped = 0
  const interrupt = () => { stopped = 130 }
  const terminate = () => { stopped = 143 }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  try { return (await runFlow(opts, apiKey, () => stopped)) || stopped }
  finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
  }
}

async function runFlow(opts: Extract<Options, { verb: 'run' }>, apiKey: string, stopped: () => number): Promise<number> {
  const veris = credentials()
  const archive = prepareCode(opts)
  const sbx = await Sandbox.create(opts.template, {
    apiKey, timeoutMs: opts.lifetimeMs, envs: opts.env,
    network: { allowPublicTraffic: opts.publicTraffic },
    metadata: { [OWNER]: OWNER_VALUE, [WORK]: opts.workDir },
    veris: { ...veris, attachSandboxId: opts.twinId, environmentId: opts.environmentId,
      mode: 'gateway', egress: 'strict', allowOut: opts.allowOut },
  })
  const twin = opts.twinId ? undefined : { id: sbx.verisSandboxId, environmentId: opts.environmentId!, veris }
  say(`E2B box ${sbx.sandboxId}; ${twin ? 'owned' : 'attached'} twin ${sbx.verisSandboxId}${twin ? `; environment ${twin.environmentId}` : ''}`)
  let code = 1
  const checkInterrupted = () => { if (stopped()) throw new Error('Run interrupted; proceeding to resource cleanup') }
  try {
    checkInterrupted()
    if (opts.twinId && sbx.verisSandboxId !== opts.twinId) throw new Error('unexpected attached twin')
    await initialize(sbx, opts.workDir)
    const info = await sbx.getInfo()
    say(`E2B expires at ${info.endAt.toISOString()}; the twin has its own TTL`)
    await putCode(sbx, opts.workDir, opts, archive)
    checkInterrupted()
    if (opts.setup) {
      code = await execute(sbx, opts.workDir, { ...opts, command: opts.setup })
      if (code !== 0) { say(`Setup exited ${code}; application command skipped`); return code }
    }
    checkInterrupted()
    // Setup may install a new runtime or a client with its own CA bundle.
    await sbx.commands.run(CA_INSTALL_CMD, { user: 'root', timeoutMs: 60_000 })
    code = await execute(sbx, opts.workDir, { ...opts, command: `sh ${BUNDLED_CA_PATCH_SCRIPT}` })
    if (code !== 0) { say(`Certificate patch exited ${code}; application command skipped`); return code }
    checkInterrupted()
    const services = (await sbx.veris.services()).filter(s => isHttpUrl(s.control_url))
    if (!services.length) throw new Error('No services with an HTTP trace endpoint; cannot verify this run')
    for (const name of opts.requireService) {
      if (!services.some(s => s.name === name)) throw new UsageError(`the twin has no traceable service named '${name}'`)
    }
    const since = Object.fromEntries(await Promise.all(services.map(async svc => [svc.name, await fetchWatermark(svc)] as const)))
    checkInterrupted()
    say(`Trace watermarks: ${JSON.stringify(since)}`)
    code = await execute(sbx, opts.workDir, opts)
    say(`Application exited ${code}; reading fresh trace evidence`)
    try {
      const receipt = await sbx.veris.receipt({ since })
      code = reportReceipt(receipt, sbx.verisSandboxId, code, opts.requireService)
    } catch (error) {
      say(`Receipt failed: ${error instanceof Error ? error.message : 'unknown error'}`)
      code = code || 1
    }
  } catch (error) {
    say(error instanceof Error ? error.message : 'Run failed')
    code = stopped() || code || 1
  } finally {
    if (opts.keep) {
      say(`Keeping E2B box ${sbx.sandboxId} and ${twin ? 'owned' : 'attached'} twin ${sbx.verisSandboxId} (--keep); lifetimes still apply`)
      say(`Teardown: npx --yes --package=@veris-ai/e2b@${SDK_VERSION} veris-e2b teardown ${shellQuote(sbx.sandboxId)}`)
    } else {
      try { await cleanup(sbx.sandboxId, apiKey, twin) }
      catch { code = code || 1 }
      if (!twin) say(`Attached twin ${sbx.verisSandboxId} remains yours`)
    }
  }
  return code
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    const opts = parseOptions(argv)
    if (opts.verb === 'help') { process.stdout.write(opts.text + '\n'); return 0 }
    if (opts.verb === 'version') { process.stdout.write(SDK_VERSION + '\n'); return 0 }
    const apiKey = e2bKey()
    if (opts.verb === 'run') return await run(opts, apiKey)
    if (opts.verb === 'provision') return await provision(opts, apiKey)
    if (opts.verb === 'push') return await push(opts, apiKey)
    if (opts.verb === 'exec') return await exec(opts, apiKey)
    try {
      const { info } = await ownedInfo(opts.sandboxId, apiKey)
      const meta = info.metadata
      let twin: Parameters<typeof cleanup>[2]
      if (meta.veris_owns_twin === 'true') {
        const veris = credentials()
        if (meta.veris_api_base?.replace(/\/$/, '') !== veris.apiBase.replace(/\/$/, '') || !/^[A-Za-z0-9_-]+$/.test(meta.veris_env_id ?? '')) {
          throw new Error('Configure the original Veris plane/profile before deleting an owned twin')
        }
        twin = { id: meta.veris_sandbox_id!, environmentId: meta.veris_env_id!, veris }
      }
      await cleanup(opts.sandboxId, apiKey, twin)
      if (!twin) say('No attached Veris twin was touched')
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error
      say(`E2B box ${opts.sandboxId} is already absent; no Veris twin was touched. If run created a twin, remove it separately using its recorded ID or await its TTL.`)
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
