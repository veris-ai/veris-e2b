import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sandbox as E2B, CommandExitError, NotFoundError, TimeoutError } from 'e2b'
import { Sandbox } from '../../src/sandbox'
import { main } from '../../src/cli'
import { credentials } from '../../src/cli-profile'
import { CA_INSTALL_CMD } from '../../src/trust'
import { ControlPlane } from '../../src/control-plane'
import { MissingCredentialsError } from '../../src/errors'

vi.mock('../../src/sandbox', () => ({ Sandbox: { create: vi.fn(), connect: vi.fn() } }))
vi.mock('../../src/cli-profile', () => ({ credentials: vi.fn(() => ({ apiKey: 'veris-secret', apiBase: 'https://plane.example' })) }))
const info = () => ({ metadata: { veris_cli: 'hosted-v1', veris_cli_workdir: '/home/user/veris-run',
  veris_owns_twin: 'false', veris_mode: 'gateway', veris_sandbox_id: 'twin-1', veris_env_id: 'env-1', veris_api_base: 'https://plane.example' }, endAt: new Date('2030-01-01') })
const handle = { wait: vi.fn(), kill: vi.fn() }
const sbx = {
  sandboxId: 'box-1', verisSandboxId: 'twin-1', verisMode: 'gateway',
  commands: { run: vi.fn() }, files: { write: vi.fn(), remove: vi.fn() }, getInfo: vi.fn(),
  veris: { services: vi.fn(), getTrustEnv: vi.fn(), getDataPlaneEnv: vi.fn(), receipt: vi.fn() },
}
let stdout: string, stderr: string, dir: string

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('E2B_API_KEY', 'e2b-secret')
  vi.stubEnv('VERIS_API_KEY', '')
  vi.stubEnv('GITHUB_TOKEN', ''); vi.stubEnv('GH_TOKEN', '')
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ requests: [{ id: 41, tier: 'control', method: 'GET', path: '/veris/requests', status: 200 }] })))
  stdout = ''; stderr = ''; dir = mkdtempSync(join(tmpdir(), 'e2b-cli-'))
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { stdout += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { stderr += String(chunk); return true })
  vi.spyOn(E2B, 'getInfo').mockResolvedValue(info() as unknown as Awaited<ReturnType<typeof E2B.getInfo>>)
  vi.spyOn(E2B, 'kill').mockResolvedValue(true)
  vi.spyOn(ControlPlane.prototype, 'deleteTwin').mockResolvedValue(true)
  vi.mocked(Sandbox.create).mockResolvedValue(sbx as unknown as Sandbox)
  vi.mocked(Sandbox.connect).mockResolvedValue(sbx as unknown as Sandbox)
  sbx.commands.run.mockResolvedValue(handle)
  sbx.files.write.mockResolvedValue(undefined); sbx.files.remove.mockResolvedValue(undefined)
  sbx.getInfo.mockResolvedValue(info())
  sbx.veris.services.mockResolvedValue([{ name: 'stripe', control_url: 'https://trace.example/stripe' }, { name: 'postgres', control_url: 'https://trace.example/postgres' }])
  sbx.veris.receipt.mockResolvedValue({ mode: 'gateway', integrity: 'verified', leaks: [], services: { stripe: { requests: 1, entries: [{ id: 42, tier: 'handler', method: 'GET', path: '/v1/customers', status: 200 }] } } })
  sbx.veris.getTrustEnv.mockResolvedValue({ NODE_EXTRA_CA_CERTS: '/cert.crt' })
  sbx.veris.getDataPlaneEnv.mockResolvedValue({ DATABASE_URL: 'postgres://twin' })
  handle.wait.mockResolvedValue({ exitCode: 0 }); handle.kill.mockResolvedValue(true)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }) })

describe('provision', () => {
  it('attaches in strict gateway mode, sets ownership, and emits credential-free JSON', async () => {
    expect(await main(['provision', '--sandbox', 'twin-1', '--template', 'test-template', '--allow-out', 'registry.npmjs.org'])).toBe(0)
    expect(Sandbox.create).toHaveBeenCalledWith('test-template', expect.objectContaining({
      apiKey: 'e2b-secret', network: { allowPublicTraffic: false },
      metadata: { veris_cli: 'hosted-v1', veris_cli_workdir: '/home/user/veris-run' },
      veris: { apiKey: 'veris-secret', apiBase: 'https://plane.example', attachSandboxId: 'twin-1', mode: 'gateway', egress: 'strict', allowOut: ['registry.npmjs.org'] },
    }))
    const result = JSON.parse(stdout)
    expect(result).toMatchObject({ e2bSandboxId: 'box-1', verisSandboxId: 'twin-1', ownsTwin: false, services: ['stripe', 'postgres'] })
    expect(result.pushCommand).toMatch(/npx --yes --package=@veris-ai\/e2b@.* veris-e2b push/)
    expect(result.patchBundledCasCommand).toBe('sh /tmp/veris-patch-bundled-cas.sh')
    expect(stdout + stderr).not.toMatch(/veris-secret|e2b-secret|postgres:\/\//)
    expect(E2B.kill).not.toHaveBeenCalled()
  })

  it('cleans up the E2B box if post-create setup fails, and reports failed cleanup', async () => {
    sbx.files.write.mockRejectedValue(new Error('write failed'))
    vi.mocked(E2B.kill).mockRejectedValue(new Error('denied'))
    expect(await main(['provision', '--sandbox', 'twin-1'])).toBe(1)
    expect(E2B.kill).toHaveBeenCalledWith('box-1', { apiKey: 'e2b-secret' })
    expect(stdout).toBe('')
    expect(stderr).toContain('Cleanup failed; delete E2B box box-1')
  })
})

describe('exec', () => {
  it('passes cwd, trust, data-plane and explicit env while streaming command output', async () => {
    sbx.commands.run.mockImplementation(async (command, opts) => {
      if (command !== CA_INSTALL_CMD) { opts.onStdout('output'); opts.onStderr('error') }
      return handle
    })
    expect(await main(['exec', 'box-1', '--cwd', '/work', '--env', 'X=one', '--', 'printf', '%s', 'a b'])).toBe(0)
    expect(sbx.commands.run).toHaveBeenLastCalledWith("'printf' '%s' 'a b'", expect.objectContaining({ cwd: '/work', timeoutMs: 600000,
      envs: { NODE_EXTRA_CA_CERTS: '/cert.crt', DATABASE_URL: 'postgres://twin', X: 'one' }, background: true }))
    expect(Sandbox.connect).toHaveBeenCalledWith('box-1', { apiKey: 'e2b-secret', veris: { apiKey: 'veris-secret', apiBase: 'https://plane.example' } })
    expect(stdout).toBe('output'); expect(stderr).toBe('error')
  })

  it('returns the command exit code without masking a failed test', async () => {
    handle.wait.mockRejectedValue(new CommandExitError({ exitCode: 7, stdout: '', stderr: '', error: 'failed' }))
    expect(await main(['exec', 'box-1', '--', 'false'])).toBe(7)
  })

  it('kills a timed-out command and reports 124', async () => {
    handle.wait.mockRejectedValue(new TimeoutError('timed out'))
    expect(await main(['exec', 'box-1', '--timeout', '3', '--', 'sleep', '30'])).toBe(124)
    expect(handle.kill).toHaveBeenCalledOnce()
  })

  it('kills an interrupted command and removes signal handlers', async () => {
    const listeners = process.listenerCount('SIGINT')
    handle.wait.mockImplementation(async () => { process.emit('SIGINT'); throw new Error('aborted') })
    expect(await main(['exec', 'box-1', '--', 'sleep', '30'])).toBe(130)
    expect(handle.kill).toHaveBeenCalledOnce()
    expect(process.listenerCount('SIGINT')).toBe(listeners)
  })
})

describe('upload', () => {
  it('clones a GitHub branch with temporary auth, without tokens in command text or files', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'github-secret')
    expect(await main(['push', 'box-1', '--repo', 'https://github.com/org/app.git', '--ref', 'release/v1'])).toBe(0)
    const clone = sbx.commands.run.mock.calls.find(([cmd]) => cmd.includes("'clone'"))!
    expect(clone[0]).toContain("'--branch' 'release/v1'")
    expect(clone[0]).toContain("'http.followRedirects=false'")
    expect(clone[1].envs).toMatchObject({ VERIS_GIT_TOKEN: 'github-secret', NODE_EXTRA_CA_CERTS: '/cert.crt' })
    expect(sbx.files.remove).toHaveBeenCalledWith(expect.stringMatching(/veris-git-askpass-/))
    expect(JSON.stringify(sbx.files.write.mock.calls) + clone[0] + stdout + stderr).not.toContain('github-secret')
    const script = sbx.files.write.mock.calls.find(([path]) => path.includes('veris-git-askpass-'))![1]
    const localHelper = join(dir, 'askpass.sh'); writeFileSync(localHelper, script)
    expect(execFileSync('sh', [localHelper, "Username for 'https://github.com': "], { encoding: 'utf8' })).toBe('x-access-token\n')
    expect(execFileSync('sh', [localHelper, "Password for 'https://x-access-token@github.com': "], { encoding: 'utf8', env: { ...process.env, VERIS_GIT_TOKEN: 'github-secret' } })).toBe('github-secret\n')
    expect(() => execFileSync('sh', [localHelper, "Password for 'https://evil.example': "], { encoding: 'utf8' })).toThrow()
  })

  it('never forwards a GitHub token to another host or prints clone authentication errors', async () => {
    vi.stubEnv('GH_TOKEN', 'github-secret')
    sbx.commands.run.mockImplementation(async cmd => {
      if (cmd.includes("'clone'")) throw new Error('provider error github-secret')
      return handle
    })
    expect(await main(['push', 'box-1', '--repo', 'https://github.com.evil.example/org/app'])).toBe(1)
    const clone = sbx.commands.run.mock.calls.find(([cmd]) => cmd.includes("'clone'"))!
    expect(clone[1].envs).not.toHaveProperty('VERIS_GIT_TOKEN')
    expect(stderr).toContain('Repository clone failed')
    expect(stderr + stdout).not.toContain('github-secret')
  })

  it('uploads current files as bytes with exclusions, executable modes and symlinks preserved', async () => {
    writeFileSync(join(dir, 'app.sh'), '#!/bin/sh\necho app\n', { mode: 0o755 })
    writeFileSync(join(dir, '.env'), 'PRIVATE_KEY=secret')
    mkdirSync(join(dir, '.veris')); writeFileSync(join(dir, '.veris', 'twin.yaml'), 'private')
    mkdirSync(join(dir, 'nested')); mkdirSync(join(dir, 'nested', 'node_modules'))
    writeFileSync(join(dir, 'nested', 'node_modules', 'skip.js'), 'skip')
    symlinkSync('app.sh', join(dir, 'link.sh'))
    expect(await main(['push', 'box-1', '--source', dir])).toBe(0)
    const [path, data] = sbx.files.write.mock.calls[0]!
    expect(path).toMatch(/^\/tmp\/veris-upload-.*\.tgz$/)
    expect(data).toBeInstanceOf(ArrayBuffer)
    const listing = execFileSync('tar', ['tzvf', '-'], { input: Buffer.from(data), encoding: 'utf8' })
    expect(listing).toContain('app.sh')
    expect(listing).toMatch(/lrwx.*link.sh -> app.sh/)
    expect(listing).toMatch(/-rwxr-xr-x.*app.sh/)
    expect(listing).not.toMatch(/node_modules|\.env|twin.yaml/)
    expect(sbx.files.remove).toHaveBeenCalledWith(path)
  })
})

describe('ownership and cleanup', () => {
  it('deletes an owned twin and box without reconnect, and attempts both when the twin delete fails', async () => {
    const value = info(); value.metadata.veris_owns_twin = 'true'
    vi.mocked(E2B.getInfo).mockResolvedValue(value as unknown as Awaited<ReturnType<typeof E2B.getInfo>>)
    vi.mocked(ControlPlane.prototype.deleteTwin).mockRejectedValue(new Error('denied'))
    expect(await main(['teardown', 'box-1'])).toBe(1)
    expect(ControlPlane.prototype.deleteTwin).toHaveBeenCalledWith('env-1', 'twin-1')
    expect(E2B.kill).toHaveBeenCalledWith('box-1', { apiKey: 'e2b-secret' })
    expect(Sandbox.connect).not.toHaveBeenCalled()
    expect(stderr).toContain('owned twin twin-1')
    expect(stderr).toContain('environment env-1')
  })

  it('requires the original Veris profile before deleting owned resources', async () => {
    const value = info(); value.metadata.veris_owns_twin = 'true'; value.metadata.veris_api_base = 'https://other.example'
    vi.mocked(E2B.getInfo).mockResolvedValue(value as unknown as Awaited<ReturnType<typeof E2B.getInfo>>)
    expect(await main(['teardown', 'box-1'])).toBe(1)
    expect(ControlPlane.prototype.deleteTwin).not.toHaveBeenCalled()
    expect(E2B.kill).not.toHaveBeenCalled()
  })
  it('teardown works without Veris credentials or reconnecting to the twin', async () => {
    expect(await main(['teardown', 'box-1'])).toBe(0)
    expect(credentials).not.toHaveBeenCalled()
    expect(Sandbox.connect).not.toHaveBeenCalled()
    expect(E2B.kill).toHaveBeenCalledWith('box-1', { apiKey: 'e2b-secret' })
  })

  it.each(['teardown', 'exec'])('refuses session-owned boxes for %s', async verb => {
    const value = info(); value.metadata.veris_cli = 'session'
    vi.mocked(E2B.getInfo).mockResolvedValue(value as unknown as Awaited<ReturnType<typeof E2B.getInfo>>)
    expect(await main(verb === 'exec' ? [verb, 'box-1', '--', 'true'] : [verb, 'box-1'])).toBe(1)
    expect(E2B.kill).not.toHaveBeenCalled(); expect(Sandbox.connect).not.toHaveBeenCalled()
  })

  it('treats an already absent box as successfully removed', async () => {
    vi.mocked(E2B.getInfo).mockRejectedValue(new NotFoundError('gone'))
    expect(await main(['teardown', 'box-1'])).toBe(0)
    expect(stderr).toContain('already absent')
  })

  it('help needs neither provider nor Veris credentials', async () => {
    vi.stubEnv('E2B_API_KEY', '')
    expect(await main(['provision', '--help'])).toBe(0)
    expect(credentials).not.toHaveBeenCalled()
    expect(E2B.getInfo).not.toHaveBeenCalled()
  })
})

describe('run', () => {
  const args = () => ['run', '--sandbox', 'twin-1', '--source', dir, '--setup', 'npm ci', '--require-service', 'stripe', '--', 'npm', 'test']

  it('uploads, sets up, patches trust, then watermarks before the application; preserves an attached twin', async () => {
    expect(await main(args())).toBe(0)
    const commands = sbx.commands.run.mock.calls.map(([cmd]) => cmd)
    expect(commands.indexOf('npm ci')).toBeLessThan(commands.indexOf(CA_INSTALL_CMD))
    expect(commands.indexOf(CA_INSTALL_CMD)).toBeLessThan(commands.indexOf('sh /tmp/veris-patch-bundled-cas.sh'))
    const appIndex = commands.indexOf("'npm' 'test'")
    const marksOrder = vi.mocked(fetch).mock.invocationCallOrder
    expect(marksOrder[0]).toBeGreaterThan(sbx.commands.run.mock.invocationCallOrder[commands.indexOf('sh /tmp/veris-patch-bundled-cas.sh')]!)
    expect(marksOrder.at(-1)).toBeLessThan(sbx.commands.run.mock.invocationCallOrder[appIndex]!)
    expect(sbx.veris.receipt).toHaveBeenCalledWith({ since: { stripe: 41, postgres: 41 } })
    expect(stdout).toContain('#42 handler GET /v1/customers -> 200')
    expect(E2B.kill).toHaveBeenCalledOnce()
    expect(ControlPlane.prototype.deleteTwin).not.toHaveBeenCalled()
  })

  it('creates an owned twin from an environment, then deletes both resources', async () => {
    expect(await main(['run', '--environment', 'env-1', '--source', dir, '--lifetime', '1800', '--', 'true'])).toBe(0)
    expect(Sandbox.create).toHaveBeenCalledWith('base', expect.objectContaining({ timeoutMs: 1800000, veris: expect.objectContaining({ environmentId: 'env-1', attachSandboxId: undefined }) }))
    expect(ControlPlane.prototype.deleteTwin).toHaveBeenCalledWith('env-1', 'twin-1')
    expect(E2B.kill).toHaveBeenCalledOnce()
  })

  it('keeps resources after failure when requested and prints the pinned teardown command', async () => {
    sbx.files.write.mockRejectedValue(new Error('upload failed'))
    expect(await main(['run', '--environment', 'env-1', '--source', dir, '--keep', '--', 'true'])).toBe(1)
    expect(ControlPlane.prototype.deleteTwin).not.toHaveBeenCalled()
    expect(E2B.kill).not.toHaveBeenCalled()
    expect(stderr).toMatch(/npx --yes --package=@veris-ai\/e2b@.* veris-e2b teardown 'box-1'/)
    expect(stderr).toContain('owned twin twin-1; environment env-1')
  })

  it('does not start an application after setup failure and still cleans up', async () => {
    handle.wait.mockResolvedValue({ exitCode: 7 })
    expect(await main(args())).toBe(7)
    expect(sbx.commands.run.mock.calls.some(([cmd]) => cmd === "'npm' 'test'")).toBe(false)
    expect(sbx.veris.receipt).not.toHaveBeenCalled()
    expect(E2B.kill).toHaveBeenCalledOnce()
  })

  it('rejects a successful suite with no required traffic', async () => {
    sbx.veris.receipt.mockResolvedValue({ mode: 'gateway', integrity: 'verified', leaks: [], services: {} })
    expect(await main(args())).toBe(1)
    expect(stderr).toContain('ZERO application requests')
  })

  it('preserves the application exit code when the receipt fails', async () => {
    handle.wait.mockResolvedValueOnce({ exitCode: 0 }).mockResolvedValueOnce({ exitCode: 0 }).mockRejectedValueOnce(new CommandExitError({ exitCode: 7, stdout: '', stderr: '', error: 'test failed' }))
    sbx.veris.receipt.mockRejectedValue(new Error('trace unavailable'))
    expect(await main(args())).toBe(7)
    expect(stderr).toContain('Receipt failed: trace unavailable')
    expect(E2B.kill).toHaveBeenCalledOnce()
  })

  it('fails a passing run if cleanup fails and prints recovery IDs', async () => {
    vi.mocked(ControlPlane.prototype.deleteTwin).mockRejectedValue(new Error('denied'))
    expect(await main(['run', '--environment', 'env-1', '--source', dir, '--', 'true'])).toBe(1)
    expect(E2B.kill).toHaveBeenCalledOnce()
    expect(stderr).toContain('owned twin twin-1')
  })

  it('does not start the application when a watermark read fails', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('trace unavailable'))
    expect(await main(args())).toBe(1)
    expect(sbx.commands.run.mock.calls.some(([cmd]) => cmd === "'npm' 'test'")).toBe(false)
    expect(E2B.kill).toHaveBeenCalledOnce()
  })

  it('cleans up an interruption during trace preparation and removes handlers', async () => {
    const listeners = process.listenerCount('SIGINT')
    vi.mocked(fetch).mockImplementation(async () => { process.emit('SIGINT'); return Response.json({ requests: [] }) })
    expect(await main(args())).toBe(130)
    expect(sbx.commands.run.mock.calls.some(([cmd]) => cmd === "'npm' 'test'")).toBe(false)
    expect(E2B.kill).toHaveBeenCalledOnce()
    expect(process.listenerCount('SIGINT')).toBe(listeners)
  })

  it('checks credentials and local source before provisioning', async () => {
    vi.mocked(credentials).mockImplementationOnce(() => { throw new MissingCredentialsError('no key') })
    expect(await main(args())).toBe(2)
    expect(Sandbox.create).not.toHaveBeenCalled()
    expect(await main(['run', '--sandbox', 'twin-1', '--source', join(dir, 'absent'), '--', 'true'])).toBe(1)
    expect(Sandbox.create).not.toHaveBeenCalled()
  })
})
