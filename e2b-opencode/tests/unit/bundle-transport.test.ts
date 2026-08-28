import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * The git commands the bundle transport issues, run against real repositories.
 *
 * This exists because the first live run failed on one of them: `git init -b
 * opencode` left opencode as the checked-out branch, and git refuses to fetch
 * into a checked-out branch of a non-bare repo. Nothing in the type system or
 * the unit tests could catch that — only real git can.
 *
 * Kept in step with sandbox-git-manager.ts and host-git-manager.ts by hand;
 * these are the same invocations, minus the sandbox transport.
 */

const STAGING_REF = 'refs/veris/incoming'
const SANDBOX_BRANCH = 'opencode'

let root: string
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'veris-bundle-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function makeHost(): string {
  const host = join(root, 'host')
  execFileSync('mkdir', ['-p', host])
  git(host, 'init', '-q', '.')
  git(host, 'config', 'user.email', 'h@x')
  git(host, 'config', 'user.name', 'h')
  writeFileSync(join(host, 'charge.sh'), 'hello from host\n')
  git(host, 'add', '-A')
  git(host, 'commit', '-qm', 'init')
  return host
}

/** ensureRepo(): a repo whose checked-out branch is NOT the one we fetch into. */
function makeSandbox(): string {
  const sbx = join(root, 'sbx')
  execFileSync('mkdir', ['-p', sbx])
  git(sbx, 'init', '-q', '.')
  git(sbx, 'config', 'user.email', 'agent@veris.ai')
  git(sbx, 'config', 'user.name', 'agent')
  return sbx
}

/** adoptBundle() */
function adopt(sbx: string, bundle: string) {
  git(sbx, 'fetch', '-q', bundle, `+HEAD:${STAGING_REF}`)
  git(sbx, 'checkout', '-q', '-B', SANDBOX_BRANCH, STAGING_REF)
  git(sbx, 'reset', '-q', '--hard', STAGING_REF)
}

describe('bundle transport', () => {
  it('carries local HEAD into the sandbox', () => {
    const host = makeHost()
    const bundle = join(root, 'in.bundle')
    git(host, 'bundle', 'create', '-q', bundle, 'HEAD')

    const sbx = makeSandbox()
    adopt(sbx, bundle)

    expect(git(sbx, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(SANDBOX_BRANCH)
    expect(git(sbx, 'rev-parse', 'HEAD')).toBe(git(host, 'rev-parse', 'HEAD'))
  })

  // The regression. `git init -b opencode` made opencode current, and fetching
  // into a checked-out branch is refused outright.
  it('adopts even though opencode ends up checked out — twice', () => {
    const host = makeHost()
    const bundle = join(root, 'in.bundle')
    git(host, 'bundle', 'create', '-q', bundle, 'HEAD')

    const sbx = makeSandbox()
    adopt(sbx, bundle)
    expect(() => adopt(sbx, bundle)).not.toThrow()
  })

  it('brings the agent’s work home incrementally', () => {
    const host = makeHost()
    const inBundle = join(root, 'in.bundle')
    git(host, 'bundle', 'create', '-q', inBundle, 'HEAD')

    const sbx = makeSandbox()
    adopt(sbx, inBundle)

    writeFileSync(join(sbx, 'new.txt'), 'made by the agent\n')
    git(sbx, 'add', '-A')
    git(sbx, 'commit', '-qm', 'opencode: work')

    // createBundle(basis) — only what the host does not already have.
    const basis = git(host, 'rev-parse', 'HEAD')
    const outBundle = join(root, 'out.bundle')
    git(sbx, 'bundle', 'create', '-q', outBundle, `${basis}..${SANDBOX_BRANCH}`)

    git(host, 'fetch', '-q', outBundle, `+${SANDBOX_BRANCH}:opencode/1`)
    expect(git(host, 'show', 'opencode/1:new.txt')).toBe('made by the agent')
    expect(git(host, 'rev-parse', 'opencode/1')).toBe(git(sbx, 'rev-parse', 'HEAD'))
  })

  it('refuses to make an empty bundle when nothing changed', () => {
    const host = makeHost()
    const inBundle = join(root, 'in.bundle')
    git(host, 'bundle', 'create', '-q', inBundle, 'HEAD')
    const sbx = makeSandbox()
    adopt(sbx, inBundle)

    const basis = git(host, 'rev-parse', 'HEAD')
    // createBundle() reads this failure as "nothing to send", not an error.
    expect(() => git(sbx, 'bundle', 'create', '-q', join(root, 'e.bundle'), `${basis}..${SANDBOX_BRANCH}`))
      .toThrow(/empty bundle/i)
  })

  it('reports a missing branch rather than bundling nothing', () => {
    const sbx = makeSandbox()
    // A sandbox that never adopted anything has no opencode branch. createBundle
    // checks for it and returns false instead of throwing.
    expect(() => git(sbx, 'rev-parse', '--verify', '--quiet', `refs/heads/${SANDBOX_BRANCH}`)).toThrow()
  })
})
