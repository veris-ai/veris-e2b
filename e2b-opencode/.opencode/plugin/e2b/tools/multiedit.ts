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

export const multieditTool = (
  sessionManager: E2BSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Applies several exact-string edits to one file in the E2B sandbox, in order',
  args: {
    filePath: z.string(),
    edits: z
      .array(z.object({ oldString: z.string(), newString: z.string(), replaceAll: z.boolean().optional() }))
      .describe('Applied in sequence; each sees the result of the previous'),
  },
  async execute(
    args: { filePath: string; edits: Array<{ oldString: string; newString: string; replaceAll?: boolean }> },
    ctx: ToolContext,
  ) {
    const sandbox = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const path = resolveIn(sessionManager.repoPath, args.filePath)
    let content = await sandbox.files.read(path)
    // All-or-nothing: a half-applied multiedit is worse than a failed one, so
    // the file is only written once every edit has matched.
    for (const [i, e] of args.edits.entries()) {
      try {
        content = applyReplacement(content, e.oldString, e.newString, e.replaceAll ?? false, path)
      } catch (err) {
        throw new Error(`Edit ${i + 1} of ${args.edits.length} failed, no changes written: ${err}`)
      }
    }
    await sandbox.files.write(path, content)
    return `Applied ${args.edits.length} edit(s) to ${path}`
  },
})
