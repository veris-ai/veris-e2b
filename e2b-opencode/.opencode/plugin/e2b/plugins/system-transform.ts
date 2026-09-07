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
        'Use verisTwin to verify the current provider, sandbox, twin and remote repository.',
        'Use verisControl for the attached service manual/schema/data and fault rows; finish',
        'seeding and diagnostic probes before measuring. The plugin owns provisioning and',
        'teardown; skills reuse this session without reset, creation or deletion.',
        'Capture verisReceipt with action=baseline BEFORE each isolated application test.',
        'After it finishes, read verisReceipt with that baseline token. An unscoped receipt',
        'is cumulative. Failed reads and incomplete lower bounds are not empty evidence;',
        'display omissions require raw trace inspection. Keep response/state assertions,',
        'integrity and blind spots; insufficient attribution leaves the integration unproven.',
        'Use verisSkill for installed workflow files and helpers; read/bash operate remotely.',
        'When the user asks to sync, hand off, or finalize, run gitSync and report its result.',
      ].join('\n'),
    )
  }
}
