/**
 * Copyright Veris AI, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { PluginInput } from '@opencode-ai/plugin'
import { createE2BTools } from '../tools'
import { logger } from '../core/logger'
import type { E2BSessionManager } from '../core/session-manager'

export async function customTools(ctx: PluginInput, sessionManager: E2BSessionManager) {
  logger.info('OpenCode started with the Veris E2B plugin')
  // ctx.worktree is the active checkout; ctx.project.worktree is the first one
  // ever seen for the project, which is wrong after a worktree switch.
  return createE2BTools(sessionManager, ctx.project.id, ctx.worktree, ctx)
}
