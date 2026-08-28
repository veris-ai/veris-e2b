/**
 * Copyright Veris AI, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { E2BSessionManager } from '../core/session-manager'
import { resolveIn } from './paths'

export const lsTool = (
  sessionManager: E2BSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Lists a directory in the E2B sandbox',
  args: { path: z.string().optional().describe('Directory, defaults to the project directory') },
  async execute(args: { path?: string }, ctx: ToolContext) {
    const sandbox = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const dir = resolveIn(sessionManager.repoPath, args.path ?? '')
    const entries = await sandbox.files.list(dir)
    if (!entries.length) return `${dir} is empty`
    return entries
      .map((e: { name: string; type?: string }) => (e.type === 'dir' ? `${e.name}/` : e.name))
      .sort()
      .join('\n')
  },
})
