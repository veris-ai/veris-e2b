/**
 * Copyright Veris AI, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { E2BSessionManager } from '../core/session-manager'
import { resolveIn, shq } from './paths'

export const grepTool = (
  sessionManager: E2BSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description: 'Searches file contents in the E2B sandbox',
  args: {
    pattern: z.string().describe('Regular expression to search for'),
    path: z.string().optional().describe('Directory to search, defaults to the project directory'),
    include: z.string().optional().describe('Only search files matching this glob'),
  },
  async execute(args: { pattern: string; path?: string; include?: string }, ctx: ToolContext) {
    const sandbox = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const dir = resolveIn(sessionManager.repoPath, args.path ?? '')
    const inc = args.include ? `--include=${shq(args.include)}` : ''
    // ripgrep is not guaranteed to be in an arbitrary template; grep -r is.
    const res = await sandbox.commands.run(
      `(command -v rg >/dev/null && rg -n --no-heading ${args.include ? `-g ${shq(args.include)}` : ''} ` +
        `-e ${shq(args.pattern)} ${shq(dir)} || ` +
        `grep -rnI ${inc} --exclude-dir=.git -e ${shq(args.pattern)} ${shq(dir)}) | head -200`,
      { cwd: dir, timeoutMs: 120_000 },
    ).catch((e: any) => ({ stdout: e?.stdout ?? '', exitCode: 1 }))
    return res.stdout.trim() || `No matches for ${args.pattern} under ${dir}`
  },
})
