import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { E2BSessionManager } from '../core/session-manager'

export const verisControlTool = (sessionManager: E2BSessionManager, projectId: string, worktree: string, pluginCtx: PluginInput) => ({
  description: 'Access a fixed control resource on the attached twin from the host. Discover schema/manual before inspecting or seeding data/fault tables. No credentials, arbitrary URLs or lifecycle operations are accepted. Keep control work outside receipt windows.',
  args: {
    service: z.string(), resource: z.enum(['manual', 'schema', 'operations', 'data', 'requests']),
    method: z.enum(['GET', 'POST', 'PATCH']).optional(),
    query: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional().describe('POST/PATCH data envelope: {"data":{"table":[rows]}}; use discovered schema.'),
  },
  async execute(args: { service: string; resource: 'manual' | 'schema' | 'operations' | 'data' | 'requests'; method?: 'GET' | 'POST' | 'PATCH'; query?: Record<string, string>; body?: unknown }, ctx: ToolContext) {
    const sandbox = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
    if (!('veris' in sandbox) || !sandbox.veris || !sandbox.verisSandboxId) throw new Error('No Veris twin is attached to this sandbox')
    if (args.method && args.method !== 'GET') {
      if (args.resource !== 'data') throw new Error('Only data supports writes; lifecycle is plugin-owned')
      await ctx.ask({ permission: 'verisControlWrite', patterns: [`${sandbox.verisSandboxId}/${args.service}/data`],
        always: [`${sandbox.verisSandboxId}/${args.service}/data`], metadata: { method: args.method, service: args.service, twinId: sandbox.verisSandboxId } })
    }
    const result = await sandbox.veris.control(args.service, args.resource, { method: args.method, query: args.query, body: args.body })
    ctx.metadata({ title: `${args.service} ${args.resource}` })
    return JSON.stringify({ provider: 'e2b', sessionId: ctx.sessionID, sandboxId: sandbox.sandboxId, twinId: sandbox.verisSandboxId, service: args.service, resource: args.resource, result,
      ...(args.resource === 'requests' || args.resource === 'data' ? { pagination: 'Raw page only; no total inferred. Follow the resource contract and advance the cursor/offset until complete.' } : {}) })
  },
})
