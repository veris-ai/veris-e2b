/**
 * Copyright Veris AI, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { PluginInput } from '@opencode-ai/plugin'
import type {
  ExperimentalChatSystemTransformInput,
  ExperimentalChatSystemTransformOutput,
} from '../core/types'

export async function systemPromptTransform(_ctx: PluginInput, repoPath: string) {
  return async (
    _input: ExperimentalChatSystemTransformInput,
    output: ExperimentalChatSystemTransformOutput,
  ) => {
    output.system.push(
      [
        '## E2B sandbox, Veris twin',
        'This session runs in an E2B sandbox, not on the user\'s machine.',
        `The project repository is at ${repoPath}; bash runs there.`,
        'Put new work in that directory. Do NOT use host paths.',
        'Use the background option for long-running commands.',
        'Before showing a preview URL, make sure the server is running on that port.',
        '',
        'Configured vendor hostnames are intercepted through the attached Veris twin.',
        'Keep production hostnames and client libraries; do not rewrite base URLs or add mocks.',
        'The SDK selects gateway or proxy fallback mode. Open egress permits other destinations;',
        'preserve the actual receipt mode, integrity and blind spots. Do not claim exclusive',
        'twin access or weaken the active trust/network configuration.',
        '',
        'This plugin owns the sandbox and its attached twin. Reuse them; do not create another',
        'twin, start another proxy, reset history or tear down resources to finish a task.',
        'Revalidate the twin id using an unfiltered verisReceipt after reconnect or resume.',
        '',
        'Before the application flow, capture a verisReceipt baseline on this twin. Read again',
        'afterward and attribute new entries to that flow, excluding probes and control traffic.',
        'The receipt includes earlier work and can be truncated: a nonzero total alone proves',
        'nothing about the current run. Keep response/state assertions. If the log is empty or',
        'insufficient to attribute the requests, report the integration as unproven.',
        'When the user asks to sync, hand off, or finalize, run gitSync and report its result.',
      ].join('\n'),
    )
  }
}
