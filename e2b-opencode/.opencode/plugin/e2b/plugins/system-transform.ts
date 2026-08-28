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
        'Outbound calls to external vendor APIs are answered by a Veris twin, not the real',
        'vendor. Production hostnames and credentials are correct as written — do not',
        'rewrite base URLs or add mock code.',
        '',
        'A green run does not prove the code reached its dependency: a fabricated response',
        'and a real one read identically from in here. After any change meant to reach an',
        'external API, call the verisReceipt tool and report what the twin actually',
        'received. An empty receipt means it did not work yet.',
        'When the user asks to sync, hand off, or finalize, run gitSync and report its result.',
      ].join('\n'),
    )
  }
}
