/**
 * Copyright Veris AI, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { E2BSessionManager } from '../core/session-manager'

export const bashTool = (
  sessionManager: E2BSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
  repoPath: string,
) => ({
  description:
    'Executes a shell command in the E2B sandbox. Vendor API calls made here are answered by the Veris twin.',
  args: {
    command: z.string().describe('Shell command to run'),
    background: z.boolean().optional().describe('Start it and return immediately'),
    timeout: z.number().optional().describe('Timeout in seconds'),
  },
  async execute(args: { command: string; background?: boolean; timeout?: number }, ctx: ToolContext) {
    const sandbox = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)

    if (args.background) {
      const handle = await sandbox.commands.run(args.command, { cwd: repoPath, background: true })
      return `Command started in background (pid: ${handle.pid})`
    }

    try {
      const result = await sandbox.commands.run(args.command, {
        cwd: repoPath,
        timeoutMs: (args.timeout ?? 300) * 1000,
      })
      return `Exit code: ${result.exitCode}\n${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`
    } catch (err: any) {
      // A non-zero exit is a normal result for the agent to reason about, not a
      // plugin failure — report it the same way a zero exit is reported.
      if (typeof err?.exitCode === 'number') {
        return `Exit code: ${err.exitCode}\n${err.stdout ?? ''}${err.stderr ? `\n${err.stderr}` : ''}`
      }
      throw err
    }
  },
})
