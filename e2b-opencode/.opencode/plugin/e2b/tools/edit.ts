/**
 * Copyright Veris AI, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { E2BSessionManager } from '../core/session-manager'
import { resolveIn } from './paths'
import { applyReplacement } from './replace'

export const editTool = (
  sessionManager: E2BSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Replaces an exact string in a file in the E2B sandbox',
  args: {
    filePath: z.string(),
    oldString: z.string().describe('Exact text to replace; must appear exactly once unless replaceAll'),
    newString: z.string(),
    replaceAll: z.boolean().optional(),
  },
  async execute(
    args: { filePath: string; oldString: string; newString: string; replaceAll?: boolean },
    ctx: ToolContext,
  ) {
    const sandbox = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const path = resolveIn(sessionManager.repoPath, args.filePath)
    const before = await sandbox.files.read(path)
    const after = applyReplacement(before, args.oldString, args.newString, args.replaceAll ?? false, path)
    await sandbox.files.write(path, after)
    return `Edited ${path}`
  },
})
