/**
 * Copyright Daytona Platforms Inc.
 * Modifications copyright Veris AI, Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted from @daytona/opencode (Apache-2.0). This module is engine-agnostic;
 * it is shared verbatim with the Daytona plugin so the two stay consistent.
 */

/**
 * Type definitions and constants for the E2B OpenCode plugin
 */

import type { Sandbox } from '@veris-ai/e2b'

// OpenCode Types

export type EventSessionDeleted = {
  type: 'session.deleted'
  properties: {
    info: { id: string }
  }
}

export type EventSessionIdle = {
  type: 'session.idle'
  properties: {
    sessionID: string
  }
}

export type ExperimentalChatSystemTransformInput = {
  sessionID?: string
  model: any
}

export type ExperimentalChatSystemTransformOutput = {
  system: string[]
}

// OpenCode constants

export const EVENT_TYPE_SESSION_DELETED = 'session.deleted'
export const EVENT_TYPE_SESSION_IDLE = 'session.idle'

// Plugin types

export type LogLevel = 'INFO' | 'ERROR' | 'WARN'

export type SandboxInfo = {
  id: string
}

export type SessionInfo = {
  sandboxId: string
  /**
   * Only set when the local worktree is a git repo (used to create opencode/N branches/remotes).
   */
  branchNumber?: number
  created: number
  lastAccessed: number
}

export type ProjectSessionData = {
  projectId: string
  worktree: string
  sessions: Record<string, SessionInfo>
}

export type SessionSandboxMap = Map<string, Sandbox | SandboxInfo>

// Plugin constants

export const LOG_LEVEL_INFO: LogLevel = 'INFO'
export const LOG_LEVEL_ERROR: LogLevel = 'ERROR'
export const LOG_LEVEL_WARN: LogLevel = 'WARN'
