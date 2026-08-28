/**
 * Copyright Veris AI, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { E2BSessionManager } from '../core/session-manager'
import { SessionGitManager } from '../git/session-git-manager'

export const gitSyncTool = (
  sessionManager: E2BSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description:
    'Commit pending sandbox changes and pull them into the local opencode/N branch. ' +
    'Returns only once the changes are on the local machine, so use this as the final ' +
    'step when handing work off — the idle sync is best-effort and does not block.',
  args: {},
  async execute(_args: Record<string, never>, ctx: ToolContext) {
    const sandbox = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const branchNumber = sessionManager.getBranchNumberForSandbox(projectId, sandbox.sandboxId)
    if (!branchNumber) {
      return 'File sync is disabled for this session — the local directory is not a git repository.'
    }
    const git = new SessionGitManager(sandbox, sessionManager.repoPath, worktree, branchNumber)
    const pulled = await git.autoCommitAndPull(ctx.sessionID)
    return pulled
      ? `Synced. Sandbox changes are on the local branch opencode/${branchNumber}.`
      : `Nothing to sync — no new commits in the sandbox since the last pull.`
  },
})
