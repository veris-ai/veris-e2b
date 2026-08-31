/**
 * Copyright Veris AI, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { E2BSessionManager } from '../core/session-manager'

export const getPreviewURLTool = (
  sessionManager: E2BSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) => ({
  description:
    'Public URL for a port inside the E2B sandbox. Start the server first — the URL exists ' +
    'whether or not anything is listening.',
  args: { port: z.number().describe('Port the server is listening on inside the sandbox') },
  async execute(args: { port: number }, ctx: ToolContext) {
    const sandbox = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    const url = `https://${sandbox.getHost(args.port)}`
    return (
      `${url}\n\n` +
      `Reachable while the sandbox is alive. If a vendor needs to call back into this ` +
      `app, register it with the twin rather than assuming delivery.`
    )
  },
})
