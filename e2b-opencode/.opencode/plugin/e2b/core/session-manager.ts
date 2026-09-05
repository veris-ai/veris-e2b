/**
 * Copyright Veris AI, Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Session lifecycle, modelled on @daytona/opencode's DaytonaSessionManager
 * (Apache-2.0) so the two plugins keep the same guarantees: a sandbox is keyed
 * by OpenCode session id, survives an OpenCode restart, and a queued sync can
 * never resurrect a sandbox for a session that is being deleted.
 *
 * The Veris wiring is not here. `@veris-ai/e2b` exports a Sandbox subclass
 * whose create() also provisions the twin, points the sandbox's egress at the
 * Veris gateway and installs the interception CA — and whose kill() deletes the
 * twin with it. So this file only ever says create / connect / kill.
 */

import { Sandbox } from '@veris-ai/e2b'
import type { PluginInput } from '@opencode-ai/plugin'
import { logger } from './logger'
import { toast } from './toast'
import { ProjectDataStorage } from './project-data-storage'
import type { SessionSandboxMap, SandboxInfo } from './types'
import { SessionGitManager } from '../git/session-git-manager'
import { SandboxGitManager } from '../git/sandbox-git-manager'

/**
 * E2B's timeoutMs is wall-clock rather than inactivity. A long wall-clock timeout
 * therefore bills for the whole window even after the engineer walks away.
 *
 * So: a short window, pushed forward on activity. An abandoned sandbox pauses
 * after the requested window. Refresh is best effort; long-running work can
 * still expire without subsequent tool activity. Pausing
 * rather than killing keeps the filesystem, and connect() resumes it, which is
 * what getSandbox() already relies on for reconnects.
 */
const IDLE_TIMEOUT_MS = 20 * 60_000
/** Don't spend an API call per tool call just to push the timeout out. */
const TIMEOUT_REFRESH_EVERY_MS = 5 * 60_000

export class E2BSessionManager {
  private readonly dataStorage: ProjectDataStorage
  private sessionSandboxes: SessionSandboxMap
  // Sessions whose teardown has begun. getSandbox creates on demand, so without
  // this tombstone a sync queued behind a deletion would silently create a
  // fresh sandbox for a session that no longer exists — invisible and billed.
  private readonly deletingSessions = new Set<string>()
  private readonly deletionPromises = new Map<string, Promise<boolean>>()
  private currentProjectId?: string
  public readonly repoPath: string
  /** E2B template new sandboxes are created from; undefined uses E2B's default. */
  public readonly template?: string

  constructor(storageDir: string, repoPath: string, template?: string) {
    this.dataStorage = new ProjectDataStorage(storageDir)
    this.repoPath = repoPath
    this.template = template?.trim() || undefined
    this.sessionSandboxes = new Map()
  }

  private isFullyInitialized(sandbox: Sandbox | SandboxInfo | undefined): sandbox is Sandbox {
    return sandbox !== undefined && 'commands' in sandbox
  }

  private isPartiallyInitialized(sandbox: Sandbox | SandboxInfo | undefined): sandbox is SandboxInfo {
    return sandbox !== undefined && 'id' in sandbox && !('commands' in sandbox)
  }

  private loadProjectSessions(projectId: string): void {
    if (this.currentProjectId === projectId) return
    this.currentProjectId = projectId
    this.sessionSandboxes = new Map()
    const data = this.dataStorage.load(projectId)
    if (!data) return
    for (const [sessionId, info] of Object.entries(data.sessions)) {
      this.sessionSandboxes.set(sessionId, { id: info.sandboxId })
    }
  }

  setProjectContext(projectId: string): void {
    this.loadProjectSessions(projectId)
  }

  getBranchNumberForSandbox(projectId: string, sandboxId: string): number | undefined {
    return this.dataStorage.getBranchNumberForSandbox(projectId, sandboxId)
  }

  /**
   * Numbers already handed to other sessions in this project. A branch only
   * appears after the first successful pull, so branch names alone would let
   * two sandboxes created back to back share a number and clobber each other.
   */
  private assignedBranchNumbers(projectId: string): number[] {
    const data = this.dataStorage.load(projectId)
    if (!data) return []
    return Object.values(data.sessions)
      .map((sess) => sess.branchNumber)
      .filter((n): n is number => typeof n === 'number')
  }

  hasSandbox(sessionId: string, projectId: string): boolean {
    this.loadProjectSessions(projectId)
    return this.sessionSandboxes.has(sessionId)
  }

  isSessionDeleting(sessionId: string): boolean {
    return this.deletingSessions.has(sessionId)
  }

  private readonly lastTimeoutRefresh = new Map<string, number>()

  /**
   * Push the sandbox's expiry back out because it is still being used. Throttled,
   * and deliberately fire-and-forget: a tool call must not fail because a
   * keepalive did, and the next call retries anyway.
   */
  private refreshTimeout(sandbox: Sandbox): void {
    const now = Date.now()
    const last = this.lastTimeoutRefresh.get(sandbox.sandboxId) ?? 0
    if (now - last < TIMEOUT_REFRESH_EVERY_MS) return
    this.lastTimeoutRefresh.set(sandbox.sandboxId, now)
    sandbox
      .setTimeout(IDLE_TIMEOUT_MS)
      .catch((err) => logger.warn(`Failed to extend sandbox ${sandbox.sandboxId} timeout: ${err}`))
  }

  private ensureNotDeleted(sessionId: string): void {
    if (this.deletingSessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} is being deleted; its sandbox is no longer usable.`)
    }
  }

  /**
   * The sandbox for a session, creating one on first use. Every tool goes
   * through here, so it must be cheap on the hot path: the in-memory map is
   * checked first and returns without any network call.
   */
  async getSandbox(
    sessionId: string,
    projectId: string,
    worktree: string,
    pluginCtx?: PluginInput,
  ): Promise<Sandbox> {
    this.ensureNotDeleted(sessionId)
    this.loadProjectSessions(projectId)

    const cached = this.sessionSandboxes.get(sessionId)
    if (this.isFullyInitialized(cached)) {
      void this.refreshTimeout(cached)
      return cached
    }

    // Known id but no live handle: this process restarted, or the mapping came
    // off disk. Reconnect rather than stranding the session's work.
    const existing = this.isPartiallyInitialized(cached) ? cached : undefined
    if (existing) {
      try {
        // connect() resumes a paused sandbox and rehydrates the Veris wiring
        // from sandbox metadata, so only the id and the API key are needed.
        const sandbox = await Sandbox.connect(existing.id)
        this.sessionSandboxes.set(sessionId, sandbox)

        let branchNumber = this.dataStorage.getBranchNumberForSandbox(projectId, sandbox.sandboxId)
        if (!branchNumber) {
          try {
            branchNumber = SessionGitManager.allocateAndReserveBranchNumber(
              worktree,
              this.assignedBranchNumbers(projectId),
            )
          } catch {
            // No local git repo (or git unavailable) must not block sandbox use.
            branchNumber = undefined
          }
        }
        this.dataStorage.updateSession(projectId, worktree, sessionId, sandbox.sandboxId, branchNumber)
        toast.show({ title: 'Sandbox connected', message: 'Connected to existing sandbox.', variant: 'info' })

        if (!branchNumber) {
          try {
            await new SandboxGitManager(sandbox, this.repoPath).ensureDirectory()
          } catch (err) {
            logger.warn(`Failed to ensure sandbox project directory exists: ${err}`)
          }
        }
        return sandbox
      } catch (err) {
        // A sandbox past its timeout is gone for good — clear the mapping and
        // fall through to a replacement. Anything else (network, auth, rate
        // limit) keeps the mapping so a retry does not lose the branch number.
        if (isGoneError(err)) {
          logger.error(`Sandbox ${existing.id} no longer exists; creating a replacement.`)
          this.sessionSandboxes.delete(sessionId)
          this.dataStorage.removeSession(projectId, worktree, sessionId)
        } else {
          logger.error(`Failed to reconnect to sandbox ${existing.id}: ${err}`)
          throw err
        }
      }
    }

    // Recover a session that was recorded under a different project id.
    if (!existing) {
      const migrated = this.dataStorage.getSession(projectId, worktree, sessionId)
      if (migrated?.sandboxId) {
        logger.info(`Recovered session ${sessionId} for project ${projectId} (migrated)`)
        this.sessionSandboxes.set(sessionId, { id: migrated.sandboxId })
        return this.getSandbox(sessionId, projectId, worktree, pluginCtx)
      }
    }

    return this.createSandbox(sessionId, projectId, worktree, pluginCtx)
  }

  private async createSandbox(
    sessionId: string,
    projectId: string,
    worktree: string,
    pluginCtx?: PluginInput,
  ): Promise<Sandbox> {
    logger.info(`Creating new sandbox for session: ${sessionId} in project: ${projectId}`)
    const createStart = Date.now()
    const waitingLog = setTimeout(() => {
      logger.warn(`E2B create still waiting after ${Date.now() - createStart}ms (sessionId=${sessionId})`)
    }, 15_000)

    // One call: E2B sandbox, Veris twin, egress pointed at the gateway, CA
    // installed. egress 'open' because an agent needs npm, git and its own
    // package registries; the twin still answers every vendor hostname.
    let sandbox: Sandbox
    try {
      const opts = {
        timeoutMs: IDLE_TIMEOUT_MS,
        lifecycle: { onTimeout: 'pause' as const, autoResume: true },
        veris: { egress: 'open' as const },
      }
      sandbox = this.template
        ? await Sandbox.create(this.template, opts)
        : await Sandbox.create(opts)
    } catch (err) {
      logger.error(`Failed to create sandbox for session ${sessionId}: ${err}`)
      toast.show({
        title: 'Sandbox error',
        message: err instanceof Error ? err.message : String(err),
        variant: 'error',
      })
      throw err
    } finally {
      clearTimeout(waitingLog)
    }

    logger.info(
      `Sandbox created: ${sandbox.sandboxId} twin=${sandbox.verisSandboxId} ` +
        `mode=${sandbox.verisMode} in ${Date.now() - createStart}ms`,
    )

    // The session was deleted while creation was in flight. Nothing else knows
    // about this sandbox, so it would leak — discard it here.
    if (this.deletingSessions.has(sessionId)) {
      logger.warn(`Session ${sessionId} deleted during creation; discarding sandbox ${sandbox.sandboxId}`)
      try {
        await sandbox.kill()
      } catch (err) {
        logger.error(`Failed to discard sandbox ${sandbox.sandboxId}: ${err}`)
        throw new Error(
          `Session ${sessionId} is deleted and discarding sandbox ${sandbox.sandboxId} failed; ` +
            `if it still exists, kill it from the E2B dashboard.`,
        )
      }
      throw new Error(`Session ${sessionId} is deleted; the newly created sandbox was discarded.`)
    }

    this.sessionSandboxes.set(sessionId, sandbox)

    let branchNumber = this.dataStorage.getBranchNumberForSandbox(projectId, sandbox.sandboxId)
    if (!branchNumber) {
      try {
        branchNumber = SessionGitManager.allocateAndReserveBranchNumber(
          worktree,
          this.assignedBranchNumbers(projectId),
        )
      } catch (err) {
        logger.warn(`allocateAndReserveBranchNumber failed sessionId=${sessionId}: ${err}`)
        branchNumber = undefined
      }
    }
    this.dataStorage.updateSession(projectId, worktree, sessionId, sandbox.sandboxId, branchNumber)

    try {
      if (branchNumber) {
        const sessionGit = new SessionGitManager(sandbox, this.repoPath, worktree, branchNumber)
        await sessionGit.initializeAndSync(pluginCtx)
      } else {
        await new SandboxGitManager(sandbox, this.repoPath).ensureDirectory()
      }
    } catch (err: any) {
      logger.error(`Failed to initialize git repo in sandbox: ${err}`)
      toast.show({
        title: 'Git error',
        message: err?.message || 'Failed to initialize git repo in sandbox.',
        variant: 'error',
      })
    }

    // Deletion may have raced the awaits above; the mapping is registered, so
    // the delete flow owns the sandbox now.
    this.ensureNotDeleted(sessionId)
    toast.show({ title: 'Sandbox created', message: 'Created new sandbox for session.', variant: 'success' })
    return sandbox
  }

  /**
   * Delete the sandbox for a session — and, through kill(), its Veris twin.
   * Concurrent callers share one promise: a second teardown racing the first
   * would observe an already-dead sandbox, throw, and wrongly clear the tombstone.
   */
  async deleteSandbox(sessionId: string, projectId: string): Promise<boolean> {
    const inFlight = this.deletionPromises.get(sessionId)
    if (inFlight) return inFlight

    const run = (async () => {
      this.deletingSessions.add(sessionId)
      this.loadProjectSessions(projectId)
      const entry = this.sessionSandboxes.get(sessionId)
      if (!entry) {
        logger.info(`No sandbox recorded for session ${sessionId}; nothing to delete.`)
        return false
      }

      const sandboxId = this.isFullyInitialized(entry) ? entry.sandboxId : entry.id

      // Pull anything the agent has not handed back yet. If this fails we keep
      // the sandbox rather than destroying unsynced work.
      try {
        await SessionGitManager.waitForAllPendingSyncs(60_000)
        const branchNumber = this.dataStorage.getBranchNumberForSandbox(projectId, sandboxId)
        const data = this.dataStorage.load(projectId)
        if (branchNumber && data && this.isFullyInitialized(entry)) {
          const git = new SessionGitManager(entry, this.repoPath, data.worktree, branchNumber)
          await git.commitAndPull()
        }
      } catch (err) {
        logger.error(`Aborting deletion of ${sandboxId}: unsynced changes could not be pulled: ${err}`)
        this.deletingSessions.delete(sessionId)
        toast.show({
          title: 'Sandbox preserved',
          message: 'Unsynced changes could not be pulled, so the sandbox was kept.',
          variant: 'error',
        })
        return false
      }

      try {
        const sandbox = this.isFullyInitialized(entry) ? entry : await Sandbox.connect(sandboxId)
        await sandbox.kill()
        logger.info(`Deleted sandbox ${sandboxId} (and its Veris twin) for session ${sessionId}`)
      } catch (err) {
        if (!isGoneError(err)) {
          logger.error(`Failed to delete sandbox ${sandboxId}: ${err}`)
          this.deletingSessions.delete(sessionId)
          return false
        }
        logger.info(`Sandbox ${sandboxId} was already gone.`)
      }

      const data = this.dataStorage.load(projectId)
      if (data) this.dataStorage.removeSession(projectId, data.worktree, sessionId)
      this.sessionSandboxes.delete(sessionId)
      return true
    })()

    this.deletionPromises.set(sessionId, run)
    try {
      return await run
    } finally {
      this.deletionPromises.delete(sessionId)
    }
  }
}

/**
 * True when the sandbox is confirmed gone rather than momentarily unreachable.
 * The distinction decides whether we drop the session mapping (losing its
 * branch number) or preserve it for a retry, so it is matched narrowly.
 */
function isGoneError(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? ''
  if (name === 'SandboxNotFoundError' || name === 'NotFoundError') return true
  const msg = err instanceof Error ? err.message : String(err)
  return /not\s*found|does not exist|no longer exists/i.test(msg)
}
