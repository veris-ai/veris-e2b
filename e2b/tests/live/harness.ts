// Shared live-suite harness: gate on the mode under test and guarantee teardown.
// Modeled on code-interpreter's tests/setup.ts fixture — the kill-on-teardown
// safety net is the one thing that must not be copy-pasted per file, and the
// metadata tag makes an orphaned sandbox (and its twin) attributable.
import { afterAll, describe } from 'vitest'

import { Sandbox } from '../../src'
import type { SandboxOpts } from '../../src'

/** `describe` for a live mode, skipped unless VERIS_E2E names it. */
export const describeLive = (mode: 'proxy' | 'gateway'): typeof describe =>
  (process.env.VERIS_E2E === mode ? describe : describe.skip) as typeof describe

const live: Sandbox[] = []
afterAll(async () => {
  await Promise.all(live.splice(0).map((s) => s.kill().catch(() => {})))
})

/** Create a sandbox that is killed (with its twin) when the file finishes. */
export async function liveSandbox(opts: SandboxOpts = {}): Promise<Sandbox> {
  const sbx = await Sandbox.create({
    ...opts,
    metadata: { ...(opts.metadata ?? {}), veris_test: 'live' },
  })
  live.push(sbx)
  return sbx
}
