/**
 * Copyright Veris AI, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { E2BSessionManager } from '../core/session-manager'
import { resolveIn } from './paths'

export const readTool = (
  sessionManager: E2BSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Reads a file from the E2B sandbox',
  args: {
    filePath: z.string().describe('Path to the file, absolute or relative to the project directory'),
    offset: z.number().optional().describe('First line to read (0-based)'),
    limit: z.number().optional().describe('Maximum number of lines to read'),
  },
  async execute(args: { filePath: string; offset?: number; limit?: number }, ctx: ToolContext) {
    const sandbox = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const path = resolveIn(sessionManager.repoPath, args.filePath)
    const content = await sandbox.files.read(path)
    if (args.offset === undefined && args.limit === undefined) return content
    const lines = content.split('\n')
    const start = args.offset ?? 0
    return lines.slice(start, args.limit ? start + args.limit : undefined).join('\n')
  },
})
