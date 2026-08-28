/**
 * Copyright Veris AI, Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * OpenCode plugin: every session runs in an E2B sandbox whose outbound vendor
 * API calls are answered by a Veris twin.
 *
 * Four hooks and nothing else. The agent loop, the model calls and the user's
 * context stay on their machine; only the tools reach across. That is what
 * keeps the sandbox from ever needing a model key, and lets its egress stay
 * narrow enough for the receipt to mean something.
 *
 * Requires: E2B_API_KEY, VERIS_API_KEY, VERIS_ENVIRONMENT_ID.
 * Optional: VERIS_E2B_TEMPLATE (an E2B template name), VERIS_API_BASE.
 */
import { join } from 'path'
import { homedir } from 'os'
import { xdgData } from 'xdg-basedir'
import type { PluginInput } from '@opencode-ai/plugin'
import { logger, setLogFilePath } from './core/logger'
import { E2BSessionManager } from './core/session-manager'
import { SessionGitManager } from './git/session-git-manager'
import { toast } from './core/toast'
import { customTools } from './plugins/custom-tools'
import { eventHandlers } from './plugins/session-events'
import { systemPromptTransform } from './plugins/system-transform'

export type { EventSessionDeleted, LogLevel, SandboxInfo, SessionInfo, ProjectSessionData } from './core/types'

const xdgDataDir = xdgData ?? join(homedir(), '.local', 'share')
const LOG_FILE = join(xdgDataDir, 'opencode', 'log', 'veris-e2b.log')
const STORAGE_DIR = join(xdgDataDir, 'opencode', 'storage', 'veris-e2b')
// E2B's default user is `user`; keep the repo somewhere it can always write.
const REPO_PATH = '/home/user/project'

setLogFilePath(LOG_FILE)

const sessionManager = new E2BSessionManager(STORAGE_DIR, REPO_PATH, process.env.VERIS_E2B_TEMPLATE)

async function verisE2BPlugin(ctx: PluginInput) {
  toast.initialize(ctx.client?.tui)

  // All three are required before the first tool call: the SDK refuses to create
  // a sandbox without an environment, because without one there is no twin and
  // nothing to intercept. Say so at load rather than letting it surface as an
  // opaque sandbox error the first time the agent runs a command.
  const missing = (['E2B_API_KEY', 'VERIS_API_KEY', 'VERIS_ENVIRONMENT_ID'] as const).filter(
    (key) => !process.env[key],
  )
  if (missing.length) {
    const list = missing.join(', ')
    logger.warn(`${list} not set; sandbox creation will fail on the first tool call.`)
    toast.show({
      title: 'Veris E2B plugin',
      message:
        `${list} not set. Export ${missing.length > 1 ? 'them' : 'it'} and restart OpenCode.` +
        (missing.includes('VERIS_ENVIRONMENT_ID')
          ? ' List your environments: GET /v1/environments with X-API-Key.'
          : ''),
      variant: 'error',
    })
  }

  return {
    tool: await customTools(ctx, sessionManager),
    event: await eventHandlers(ctx, sessionManager, REPO_PATH),
    'experimental.chat.system.transform': await systemPromptTransform(ctx, REPO_PATH),
    // Awaited by OpenCode when the plugin scope closes. Draining keeps a
    // graceful shutdown from abandoning a sync the idle hook started, and is
    // bounded so a stalled sandbox cannot wedge process exit.
    dispose: async () => {
      const drained = await SessionGitManager.waitForAllPendingSyncs(60_000)
      if (!drained) {
        logger.warn('[dispose] exiting with git syncs still pending after 60s; a sync may be stalled')
      }
    },
  }
}

export default verisE2BPlugin
