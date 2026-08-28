/**
 * Copyright Veris AI, Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * These keys are the built-in OpenCode tool names. OpenCode appends plugin
 * tools after its own, so registering them here shadows the built-ins and
 * relocates execution into the sandbox. That substitution is the whole
 * mechanism; everything else is bookkeeping around it.
 */
import { bashTool } from './tools/bash'
import { readTool } from './tools/read'
import { writeTool } from './tools/write'
import { editTool } from './tools/edit'
import { multieditTool } from './tools/multiedit'
import { lsTool } from './tools/ls'
import { globTool } from './tools/glob'
import { grepTool } from './tools/grep'
import { getPreviewURLTool } from './tools/get-preview-url'
import { gitSyncTool } from './tools/git-sync'
import { verisReceiptTool } from './tools/veris-receipt'
import type { E2BSessionManager } from './core/session-manager'
import type { PluginInput } from '@opencode-ai/plugin'

export function createE2BTools(
  sessionManager: E2BSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) {
  const repoPath = sessionManager.repoPath
  return {
    // Shadowed built-ins.
    bash: bashTool(sessionManager, projectId, worktree, pluginCtx, repoPath),
    read: readTool(sessionManager, projectId, worktree, pluginCtx),
    write: writeTool(sessionManager, projectId, worktree, pluginCtx),
    edit: editTool(sessionManager, projectId, worktree, pluginCtx),
    multiedit: multieditTool(sessionManager, projectId, worktree, pluginCtx),
    ls: lsTool(sessionManager, projectId, worktree, pluginCtx),
    glob: globTool(sessionManager, projectId, worktree, pluginCtx),
    grep: grepTool(sessionManager, projectId, worktree, pluginCtx),
    // Additions.
    getPreviewURL: getPreviewURLTool(sessionManager, projectId, worktree, pluginCtx),
    gitSync: gitSyncTool(sessionManager, projectId, worktree, pluginCtx),
    verisReceipt: verisReceiptTool(sessionManager, projectId, worktree, pluginCtx),
  }
}
