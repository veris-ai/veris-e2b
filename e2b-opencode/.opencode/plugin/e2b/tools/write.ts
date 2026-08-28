/**
 * Copyright Veris AI, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { E2BSessionManager } from '../core/session-manager'
import { resolveIn } from './paths'

export const writeTool = (
  sessionManager: E2BSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Writes a file to the E2B sandbox, creating parent directories as needed',
  args: {
    filePath: z.string().describe('Path to the file, absolute or relative to the project directory'),
    content: z.string().describe('Full contents to write'),
  },
  async execute(args: { filePath: string; content: string }, ctx: ToolContext) {
    const sandbox = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const path = resolveIn(sessionManager.repoPath, args.filePath)
    await sandbox.files.write(path, args.content)
    return `Wrote ${args.content.length} bytes to ${path}`
  },
})
