import { parseArgs } from 'node:util'

export class UsageError extends Error {}
export const WORK_DIR = '/home/user/veris-run'
export const UPLOAD_EXCLUDES = [
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.ruff_cache', 'dist', 'build', 'target', '.next', '.turbo', 'coverage', '.DS_Store',
  '.veris', '.veris-e2b', '.env', '.env.*',
] as const

export const ROOT_HELP = `usage: veris-e2b <command> [options]

  provision   create a task-owned E2B box attached to an existing Veris twin
  push        upload local code into that box
  exec        execute a command with certificate trust and data-plane env
  teardown    delete that box, leaving the twin alone

veris-e2b <command> --help describes each one. --version prints the package version.
These commands manage separate application-test boxes, not OpenCode sessions.`

export const HELP = {
  provision: `usage: veris-e2b provision --sandbox <twin-id> [options]

  --template <name-or-id>    existing E2B template (default: base)
  --workdir <absolute-dir>  code directory (default: ${WORK_DIR})
  --timeout <seconds>       E2B lifetime (default: 1800; subject to plan limits)
  --allow-out <host-or-cidr> additional outbound allowance (repeatable)
  --env KEY=VALUE           sandbox environment (repeatable; Veris-managed values win)
  --allow-public-traffic    permit public callback access (default: disabled)

Needs E2B_API_KEY and VERIS_API_KEY or the profile saved by veris login in
~/.veris/twin.yaml. VERIS_PROFILE selects a profile; VERIS_API_BASE overrides its
plane. Project profile settings are not read; export VERIS_PROFILE for both CLIs.
The environment is derived from the twin, ignoring VERIS_ENVIRONMENT_ID.

Gateway mode and strict egress are required. No package registries are allowed
by default: name each install/download host with --allow-out. A Docker image
or Daytona snapshot is not an E2B template. The template needs a POSIX shell,
curl, tar, ca-certificates and root for certificate installation.

Prints one JSON object on stdout with e2bSandboxId, verisSandboxId, workDir,
trustEnv, services, expiresAt, and push/exec/patch/teardown commands.
No code is uploaded or run; the twin's TTL and ownership do not change.`,
  push: `usage: veris-e2b push <e2b-sandbox-id> [--source <directory>]

Uploads the current directory (or --source) into provision's workDir using tar
and the E2B files API. Requires local and remote tar, E2B_API_KEY, and the same
Veris credentials/profile as provision. Only CLI-owned boxes are accepted.

Excluded at every level: ${UPLOAD_EXCLUDES.join(', ')}.
These are fixed exclusions, not .gitignore. Review all other files before upload;
uncommitted/untracked source is included. Credential files must be selected
deliberately. Symlinks and executable bits are preserved, not dereferenced.
Matching files are overwritten; removed local files remain remotely. Use a fresh
box after removals. There is no remote git-clone option.`,
  exec: `usage: veris-e2b exec <e2b-sandbox-id> [options] -- <command> [args...]

  --cwd <absolute-dir>     command directory (default: provision's workDir)
  --env KEY=VALUE          command environment (repeatable; explicit overrides win)
  --timeout <seconds>      command timeout (default: 600)

Needs E2B_API_KEY and the same Veris credentials/profile as provision.
Rechecks gateway routing and applies trust and data-plane variables, then streams
stdout/stderr. Arguments after -- are preserved literally. For shell syntax use
-- sh -c '...'. This does not upload changed files or read a receipt: capture a
watermark with veris sandbox trace before running and inspect application traffic
afterward. Exit: command's status, 124 on timeout, 130/143 on interruption.
Use a remote shell to expand paths: -- sh -c 'export KEYS_DIR="$PWD/keys"; npm test'.`,
  teardown: `usage: veris-e2b teardown <e2b-sandbox-id>

Needs only E2B_API_KEY. Deletes a CLI-provisioned E2B box, even after the twin
expires. Never deletes or extends the twin, and refuses SDK/OpenCode-owned boxes.
An already absent box succeeds. Restore any task callback registration first,
save evidence, then veris down separately when the task is done.`,
} as const

export type Options =
  | { verb: 'provision'; twinId: string; template: string; workDir: string; timeoutMs: number; allowOut: string[]; env: Record<string, string>; publicTraffic: boolean }
  | { verb: 'push'; sandboxId: string; source: string }
  | { verb: 'exec'; sandboxId: string; cwd?: string; timeoutMs: number; env: Record<string, string>; command: string }
  | { verb: 'teardown'; sandboxId: string }
  | { verb: 'help'; text: string }
  | { verb: 'version' }

export const shellQuote = (word: string): string => `'${word.replace(/'/g, `'\\''`)}'`

function identifier(value: string | undefined, label: string): string {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new UsageError(`${label} must be a nonempty sandbox ID`)
  return value
}

function directory(value: string): string {
  if (!value.startsWith('/') || value === '/' || /[\0\r\n]/.test(value) || value.split('/').includes('..')) {
    throw new UsageError('remote directory must be an absolute path below / without .. or control characters')
  }
  return value.replace(/\/+$/, '')
}

function timeout(value: string | undefined, seconds: number): number {
  const n = value === undefined ? seconds : Number(value)
  if (!Number.isFinite(n) || n <= 0 || n > 86400) throw new UsageError('--timeout needs seconds in (0, 86400]')
  return Math.ceil(n * 1000)
}

function environment(pairs: string[] = []): Record<string, string> {
  const env: Record<string, string> = {}
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    const key = pair.slice(0, eq)
    if (eq < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || pair.includes('\0')) throw new UsageError('--env needs KEY=VALUE')
    if (['E2B_API_KEY', 'VERIS_API_KEY'].includes(key)) throw new UsageError(`do not send ${key} to the workload`)
    env[key] = pair.slice(eq + 1)
  }
  return env
}

export function parseOptions(argv: readonly string[]): Options {
  const [verb, ...rest] = argv
  if (!verb || verb === '--help' || verb === '-h') return { verb: 'help', text: ROOT_HELP }
  if (verb === '--version' || verb === '-v') return { verb: 'version' }
  if (!Object.hasOwn(HELP, verb)) throw new UsageError(`unknown command '${verb}'\n${ROOT_HELP}`)
  const name = verb as keyof typeof HELP
  const sep = rest.indexOf('--')
  const flags = sep < 0 ? rest : rest.slice(0, sep)
  const command = sep < 0 ? [] : rest.slice(sep + 1)
  const string = { type: 'string' } as const
  const repeated = { ...string, multiple: true } as const
  const specs = {
    provision: { sandbox: string, template: string, workdir: string, timeout: string, 'allow-out': repeated, env: repeated, 'allow-public-traffic': { type: 'boolean' as const } },
    push: { source: string },
    exec: { cwd: string, timeout: string, env: repeated },
    teardown: {},
  }
  let parsed: { values: Record<string, unknown>; positionals: string[] }
  try {
    parsed = parseArgs({ args: flags, allowPositionals: true, strict: true, options: { ...specs[name], help: { type: 'boolean', short: 'h' } } })
  } catch (error) { throw new UsageError((error as Error).message) }
  if (parsed.values.help) return { verb: 'help', text: HELP[name] }
  const values = parsed.values as Record<string, string | string[] | boolean | undefined>
  const str = (key: string) => values[key] as string | undefined
  if (name !== 'exec' && sep >= 0) throw new UsageError(`${name} does not accept a command after --`)
  if (name === 'provision') {
    if (parsed.positionals.length) throw new UsageError('provision takes --sandbox <twin-id>, not positional arguments')
    const allowOut = (values['allow-out'] ?? []) as string[]
    if (allowOut.some(h => !h || /[\s\0]/.test(h) || h.includes('://'))) throw new UsageError('--allow-out needs a hostname or CIDR, not a URL')
    if (str('template') === '') throw new UsageError('--template needs a name or ID')
    return { verb: name, twinId: identifier(str('sandbox'), '--sandbox'), template: str('template') ?? 'base',
      workDir: directory(str('workdir') ?? WORK_DIR), timeoutMs: timeout(str('timeout'), 1800),
      allowOut, env: environment(values.env as string[] | undefined), publicTraffic: values['allow-public-traffic'] === true }
  }
  if (parsed.positionals.length !== 1) throw new UsageError(`${name} takes exactly one E2B sandbox ID`)
  const sandboxId = identifier(parsed.positionals[0], 'E2B sandbox ID')
  if (name === 'teardown') return { verb: name, sandboxId }
  if (name === 'push') return { verb: name, sandboxId, source: str('source') ?? process.cwd() }
  if (!command.length) throw new UsageError('exec needs a command after --')
  return { verb: name, sandboxId, command: command.map(shellQuote).join(' '),
    cwd: str('cwd') === undefined ? undefined : directory(str('cwd')!), timeoutMs: timeout(str('timeout'), 600), env: environment(values.env as string[] | undefined) }
}
