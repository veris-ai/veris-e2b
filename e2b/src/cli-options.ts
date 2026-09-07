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
  run         upload/clone, set up, run, verify fresh traffic, and clean up
  push        upload local code or clone a repository into that box
  exec        execute a command with certificate trust and data-plane env
  teardown    delete that box and only a twin created by run

veris-e2b <command> --help describes each one. --version prints the package version.
These commands manage separate application-test boxes, not OpenCode sessions.`

export const HELP = {
  run: `usage: veris-e2b run [options] -- <command> [args...]

  --sandbox <twin-id>       attach to the task's existing twin (never delete it)
  --environment <id>        create an owned twin (default: $VERIS_ENVIRONMENT_ID)
  --source <directory>      upload local code (default: current directory)
  --repo <https-url>        shallow clone instead of uploading
  --ref <branch-or-tag>     branch or tag to clone; requires --repo
  --template <name-or-id>   E2B template (default: base)
  --workdir <absolute-dir>  code directory (default: ${WORK_DIR})
  --setup <shell-command>   install dependencies before running the command
  --require-service <name>  require fresh application traffic for each named service
  --allow-out <host-or-cidr> additional outbound allowance (repeatable)
  --env KEY=VALUE           application environment (repeatable)
  --timeout <seconds>       timeout for each setup/main command (default: 1800)
  --lifetime <seconds>      total E2B lifetime, including setup (default: 3600)
  --allow-public-traffic    permit public callback access (does not register one)
  --keep                   retain resources and print teardown instructions

Uses the same credentials, strict gateway networking and templates as provision.
--sandbox and --environment are exclusive. Attached twins keep their own TTL.
Uploads/clones, runs setup, refreshes trust and patches recognized CA bundles,
takes per-service trace watermarks, runs the application, then prints a receipt.
Only new handler/fault rows count. Requires trace IDs, tiers and paginated reads.
Exit: command status; 1 for no required traffic, unverifiable evidence, or failed
cleanup. Always attempts cleanup after creation unless --keep, including failures.
See push --help for clone authentication and provision --help for prerequisites.`,
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
  push: `usage: veris-e2b push <e2b-sandbox-id> [--source <directory> | --repo <https-url> [--ref <branch-or-tag>]]

Uploads the current directory (or --source) into provision's workDir using tar
and the E2B files API. Requires local and remote tar, E2B_API_KEY, and the same
Veris credentials/profile as provision. Only CLI-owned boxes are accepted.

Excluded at every level: ${UPLOAD_EXCLUDES.join(', ')}.
These are fixed exclusions, not .gitignore. Review all other files before upload;
uncommitted/untracked source is included. Credential files must be selected
deliberately. Symlinks and executable bits are preserved, not dereferenced.
Matching files are overwritten; removed local files remain remotely. Use a fresh
box after removals.

--repo shallow-clones an HTTPS repository using remote git; --ref selects a branch
or tag (not an arbitrary commit). Requires git in the template, an empty workDir,
and explicit --allow-out hosts at creation. No submodules or Git LFS download.
GITHUB_TOKEN or GH_TOKEN authenticates only https://github.com using a temporary
askpass helper, with no token stored in origin or command arguments. Other hosts
are public-only. Inline URL credentials and redirects are refused.`,
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

Needs E2B_API_KEY; also the original Veris credentials/profile when run created
the twin. Deletes CLI-owned resources without reconnecting to a live twin.
Attached twins are never deleted. SDK/OpenCode-owned boxes are refused.
An already absent box succeeds, but its ownership metadata cannot be recovered:
delete any owned twin separately using the IDs printed by run, or await its TTL.
Restore callback registration and save evidence before teardown.`,
} as const

export interface CodeOptions { source: string; repo?: string; ref?: string }
interface CreateOptions { template: string; workDir: string; timeoutMs: number; allowOut: string[]; env: Record<string, string>; publicTraffic: boolean }
export type Options =
  | ({ verb: 'provision'; twinId: string } & CreateOptions)
  | ({ verb: 'run'; twinId?: string; environmentId?: string; lifetimeMs: number; setup?: string; requireService: string[]; keep: boolean; command: string } & CreateOptions & CodeOptions)
  | ({ verb: 'push'; sandboxId: string } & CodeOptions)
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

function timeout(value: string | undefined, seconds: number, flag = '--timeout'): number {
  const n = value === undefined ? seconds : Number(value)
  if (!Number.isFinite(n) || n <= 0 || n > 86400) throw new UsageError(`${flag} needs seconds in (0, 86400]`)
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
  const createSpecs = { sandbox: string, template: string, workdir: string, timeout: string, 'allow-out': repeated, env: repeated, 'allow-public-traffic': { type: 'boolean' as const } }
  const codeSpecs = { source: string, repo: string, ref: string }
  const specs = {
    provision: createSpecs,
    run: { ...createSpecs, ...codeSpecs, environment: string, lifetime: string, setup: string, 'require-service': repeated, keep: { type: 'boolean' as const } },
    push: codeSpecs,
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
  if (name !== 'exec' && name !== 'run' && sep >= 0) throw new UsageError(`${name} does not accept a command after --`)
  const code = (): CodeOptions => {
    const repo = str('repo'), ref = str('ref')
    if (repo !== undefined) {
      if (str('source') !== undefined) throw new UsageError('--source and --repo are exclusive')
      let url: URL
      try { url = new URL(repo) } catch { throw new UsageError('--repo requires an HTTPS URL') }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443') || /[\s\0]/.test(repo)) {
        throw new UsageError('--repo requires HTTPS without inline credentials, query, fragment, or a nonstandard port')
      }
    }
    if (ref !== undefined && (!repo || !ref || ref.startsWith('-') || /[\s\0]/.test(ref))) throw new UsageError('--ref requires --repo and a branch or tag name')
    if (str('source') === '') throw new UsageError('--source needs a directory')
    return { source: str('source') ?? process.cwd(), ...(repo ? { repo } : {}), ...(ref ? { ref } : {}) }
  }
  if (name === 'provision' || name === 'run') {
    if (parsed.positionals.length) throw new UsageError(`${name} does not take positional arguments before --`)
    const allowOut = (values['allow-out'] ?? []) as string[]
    if (allowOut.some(h => !h || /[\s\0]/.test(h) || h.includes('://'))) throw new UsageError('--allow-out needs a hostname or CIDR, not a URL')
    if (str('template') === '') throw new UsageError('--template needs a name or ID')
    const common = { template: str('template') ?? 'base',
      workDir: directory(str('workdir') ?? WORK_DIR), timeoutMs: timeout(str('timeout'), 1800),
      allowOut, env: environment(values.env as string[] | undefined), publicTraffic: values['allow-public-traffic'] === true }
    if (name === 'provision') return { verb: name, ...common, twinId: identifier(str('sandbox'), '--sandbox') }
    if (!command.length) throw new UsageError('run needs a command after --')
    if (str('sandbox') !== undefined && str('environment') !== undefined) throw new UsageError('--sandbox and --environment are exclusive')
    const twinId = str('sandbox') === undefined ? undefined : identifier(str('sandbox'), '--sandbox')
    const environmentId = twinId ? undefined : identifier(str('environment') ?? process.env.VERIS_ENVIRONMENT_ID, '--environment or VERIS_ENVIRONMENT_ID')
    const requireService = (values['require-service'] ?? []) as string[]
    if (requireService.some(s => !/^[A-Za-z0-9_-]+$/.test(s))) throw new UsageError('--require-service needs a service name')
    return { verb: name, ...common, ...code(), twinId, environmentId, setup: str('setup'), requireService,
      lifetimeMs: timeout(str('lifetime'), 3600, '--lifetime'), keep: values.keep === true, command: command.map(shellQuote).join(' ') }
  }
  if (parsed.positionals.length !== 1) throw new UsageError(`${name} takes exactly one E2B sandbox ID`)
  const sandboxId = identifier(parsed.positionals[0], 'E2B sandbox ID')
  if (name === 'teardown') return { verb: name, sandboxId }
  if (name === 'push') return { verb: name, sandboxId, ...code() }
  if (!command.length) throw new UsageError('exec needs a command after --')
  return { verb: name, sandboxId, command: command.map(shellQuote).join(' '),
    cwd: str('cwd') === undefined ? undefined : directory(str('cwd')!), timeoutMs: timeout(str('timeout'), 600), env: environment(values.env as string[] | undefined) }
}
