/**
 * Copyright Veris AI, Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Structure follows @daytona/opencode's session-events (Apache-2.0), including
 * the two ordering rules that matter: the whole idle pipeline is enqueued
 * synchronously before any await, and deletion is re-checked inside the queue
 * entry so a sync cannot resurrect a sandbox that is being torn down.
 */
import type { PluginInput } from '@opencode-ai/plugin'
import { SessionGitManager } from '../git/session-git-manager'
import { EVENT_TYPE_SESSION_DELETED, EVENT_TYPE_SESSION_IDLE, type EventSessionDeleted } from '../core/types'
import { toast } from '../core/toast'
import { logger } from '../core/logger'
import type { E2BSessionManager } from '../core/session-manager'

export async function eventHandlers(ctx: PluginInput, sessionManager: E2BSessionManager, repoPath: string) {
  const projectId = ctx.project.id
  // The ACTIVE worktree, not ctx.project.worktree: the latter is persisted the
  // first time a project is opened and never updated, so with linked worktrees
  // it can name a different checkout than the one running now.
  const worktree = ctx.worktree

  return async (args: any) => {
    const event = args.event

    if (event.type === EVENT_TYPE_SESSION_DELETED) {
      const sessionId = (event as EventSessionDeleted).properties.info.id
      try {
        const deleted = await sessionManager.deleteSandbox(sessionId, projectId)
        if (deleted) {
          toast.show({
            title: 'Session deleted',
            message: 'Sandbox and Veris twin deleted.',
            variant: 'success',
          })
        }
      } catch (err: any) {
        toast.show({
          title: 'Delete failed',
          message: err?.message || 'Failed to delete sandbox.',
          variant: 'error',
        })
        throw err
      }
      return
    }

    if (event.type === EVENT_TYPE_SESSION_IDLE) {
      const sessionId = event.properties.sessionID
      const start = Date.now()
      try {
        // Enqueued synchronously, before any await, so a delete or dispose
        // arriving while the sandbox is still resolving cannot see an empty
        // queue and proceed mid-operation. commitAndPull() is the UNQUEUED
        // form on purpose — the queued one here would wait on itself.
        const didSync = await SessionGitManager.enqueueSessionSync(sessionId, async () => {
          if (sessionManager.isSessionDeleting(sessionId)) return false
          const sandbox = await sessionManager.getSandbox(sessionId, projectId, worktree, ctx)
          const branchNumber = sessionManager.getBranchNumberForSandbox(projectId, sandbox.sandboxId)
          if (!branchNumber) return false
          const git = new SessionGitManager(sandbox, repoPath, worktree, branchNumber)
          return git.commitAndPull()
        })
        logger.info(`[idle] done sessionId=${sessionId} synced=${didSync} in ${Date.now() - start}ms`)
      } catch (err: any) {
        // Logged, not re-thrown: a failed background sync must not take down
        // the idle hook, and the user already sees any toast it raised.
        logger.error(`[idle] error sessionId=${sessionId} in ${Date.now() - start}ms: ${err}`)
      }
    }
  }
}
