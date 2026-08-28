/**
 * Copyright Veris AI, Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Orchestrates the two halves of the sync. Same contract as
 * @daytona/opencode's session-git-manager (Apache-2.0) — per-session
 * serialisation, a drainable set of in-flight syncs, opencode/N branch
 * allocation — over a bundle transport instead of an SSH remote.
 */

import type { Sandbox } from '@veris-ai/e2b'
import type { PluginInput } from '@opencode-ai/plugin'
import { join } from 'path'
import { logger } from '../core/logger'
import { HostGitManager } from './host-git-manager'
import { SandboxGitManager, SANDBOX_BRANCH } from './sandbox-git-manager'

const IN_BUNDLE = '/tmp/veris-opencode-in.bundle'
const OUT_BUNDLE = '/tmp/veris-opencode-out.bundle'

export class SessionGitManager {
  private readonly hostGit = new HostGitManager()
  private readonly sandboxGit: SandboxGitManager
  private readonly localBranch: string

  constructor(
    private readonly sandbox: Sandbox,
    private readonly repoPath: string,
    private readonly worktree: string,
    private readonly branchNumber: number,
  ) {
    this.sandboxGit = new SandboxGitManager(sandbox, repoPath)
    this.localBranch = `opencode/${branchNumber}`
  }

  /**
   * The lowest N whose opencode/N branch is free. Reserving by name means two
   * sandboxes in one repo cannot collide even across OpenCode restarts.
   */
  static allocateAndReserveBranchNumber(
    worktree: string,
    alreadyAssigned: Iterable<number> = [],
    prefix = 'opencode',
  ): number {
    const host = new HostGitManager()
    if (!host.hasRepo(worktree)) throw new Error('not a git repository')
    // Existing branches are not enough. A branch only appears after the first
    // successful pull, so two sandboxes created back to back would both be
    // handed the same number and then overwrite each other's branch. Numbers
    // recorded against other sessions count as taken even before the branch
    // exists.
    const taken = new Set(host.branchNames(worktree))
    const assigned = new Set(alreadyAssigned)
    let n = 1
    while (taken.has(`${prefix}/${n}`) || assigned.has(n)) n++
    return n
  }

  // ---- in-flight sync bookkeeping -------------------------------------------
  // OpenCode dispatches session.idle without awaiting the plugin, so observing
  // that event does not mean the work has landed. These let deletion and
  // shutdown wait for it.

  private static pendingSyncs = new Map<string, Promise<void>>()

  static enqueueSessionSync<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prior = SessionGitManager.pendingSyncs.get(sessionId) ?? Promise.resolve()
    const run = prior.then(fn, fn)
    SessionGitManager.pendingSyncs.set(
      sessionId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }

  static async waitForPendingSync(sessionId: string): Promise<void> {
    await SessionGitManager.pendingSyncs.get(sessionId)?.catch(() => undefined)
  }

  static async waitForAllPendingSyncs(timeoutMs = 60_000): Promise<boolean> {
    const all = Promise.allSettled([...SessionGitManager.pendingSyncs.values()])
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs))
    return (await Promise.race([all.then(() => 'done' as const), timeout])) === 'done'
  }

  hasLocalRepo(): boolean {
    return this.hostGit.hasRepo(this.worktree)
  }

  /**
   * Ship the engineer's current HEAD into the sandbox. Runs once, at creation:
   * the agent should open on the same commit they were looking at.
   */
  async initializeAndSync(_pluginCtx?: PluginInput): Promise<void> {
    await this.sandboxGit.ensureRepo()

    if (!this.hasLocalRepo()) {
      logger.info('No local git repo; sandbox gets an empty repo and sync is disabled.')
      return
    }

    const tmp = this.hostGit.makeTempDir()
    try {
      const local = join(tmp, 'in.bundle')
      if (!this.hostGit.bundleHead(this.worktree, local)) return

      const bytes = await readFileAsArrayBuffer(local)
      await this.sandboxGit.writeBundle(IN_BUNDLE, bytes)
      await this.sandboxGit.adoptBundle(IN_BUNDLE)
      await this.sandboxGit.removeFile(IN_BUNDLE)
      logger.info(`Seeded sandbox ${this.sandbox.sandboxId} at local HEAD on ${SANDBOX_BRANCH}`)
    } finally {
      this.hostGit.removeTempDir(tmp)
    }
  }

  /**
   * Commit whatever the agent changed and bring it home to opencode/N.
   * Returns false when there was nothing new, which is most idle ticks.
   */
  async commitAndPull(): Promise<boolean> {
    if (!this.hasLocalRepo()) return false

    const committed = await this.sandboxGit.autoCommit()
    const basis = this.hostGit.branchOid(this.worktree, this.localBranch)
    const head = await this.sandboxGit.getHeadOid()
    if (!committed && basis && head && basis === head) return false

    const tmp = this.hostGit.makeTempDir()
    try {
      const hasNew = await this.sandboxGit.createBundle(OUT_BUNDLE, basis)
      if (!hasNew) return false

      const bytes = await this.sandboxGit.readBundle(OUT_BUNDLE)
      const local = join(tmp, 'out.bundle')
      await writeArrayBufferToFile(local, bytes)
      this.hostGit.fetchBundleToBranch(this.worktree, local, this.localBranch)
      await this.sandboxGit.removeFile(OUT_BUNDLE)
      return true
    } finally {
      this.hostGit.removeTempDir(tmp)
    }
  }

  /** The idle-tick path: serialised per session so two ticks cannot interleave. */
  async autoCommitAndPull(sessionId: string): Promise<boolean> {
    return SessionGitManager.enqueueSessionSync(sessionId, () => this.commitAndPull())
  }
}

async function readFileAsArrayBuffer(path: string): Promise<ArrayBuffer> {
  const { readFile } = await import('fs/promises')
  const buf = await readFile(path)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

async function writeArrayBufferToFile(path: string, bytes: Uint8Array): Promise<void> {
  const { writeFile } = await import('fs/promises')
  await writeFile(path, bytes)
}
