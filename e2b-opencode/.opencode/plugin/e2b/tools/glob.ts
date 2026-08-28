/**
 * Copyright Veris AI, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { E2BSessionManager } from '../core/session-manager'
import { resolveIn, shq } from './paths'

export const globTool = (
  sessionManager: E2BSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Finds files matching a glob pattern in the E2B sandbox',
  args: {
    pattern: z.string().describe('Glob pattern, e.g. **/*.ts'),
    path: z.string().optional().describe('Directory to search, defaults to the project directory'),
  },
  async execute(args: { pattern: string; path?: string }, ctx: ToolContext) {
    const sandbox = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const dir = resolveIn(sessionManager.repoPath, args.path ?? '')
    // -path with a leading */ makes a bare '*.ts' behave the way callers expect.
    const res = await sandbox.commands.run(
      `find ${shq(dir)} -type f -not -path '*/.git/*' -path ${shq(`*/${args.pattern}`)} -o ` +
        `-type f -not -path '*/.git/*' -path ${shq(`${dir}/${args.pattern}`)} | sort | head -200`,
      { cwd: dir, timeoutMs: 60_000 },
    ).catch((e: any) => ({ stdout: e?.stdout ?? '', exitCode: 1 }))
    return res.stdout.trim() || `No files matching ${args.pattern} under ${dir}`
  },
})
