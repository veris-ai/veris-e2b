# Changelog

Both packages version together. See [CONTRIBUTING.md](CONTRIBUTING.md#releasing).

## 0.2.0 — Unreleased

- SDK receipts paginate by stable request ID, exclude control/probe evidence,
  and report incomplete windows. New baseline APIs detect reset/history loss and
  session replacement while retaining interception integrity and blind spots.
- Gateway receipt reads fail when credentials needed to verify the canary are absent.
  The reconnect change belongs to the separate CLI draft #22.
- OpenCode exposes consistent session/twin discovery, manuals and scoped schema,
  state, seed/fault and raw trace access. Data writes honor user permissions;
  provisioning and teardown remain plugin-owned.
- Both packages align with the shared skills adapter; canonical skills remain
  in veris-ai/plugins. SDK stays SDK-only. Publish SDK before dependent plugin.
### `@veris-ai/e2b`

- Add the `veris-e2b` executable: `provision --sandbox`, local `push`, streaming
  `exec`, and `teardown` for separate application-test boxes. Provision uses E2B
  templates and strict gateway egress, prints JSON and preserves the attached twin.
- Read Veris CLI login profiles in the CLI, prepare bundled certificates after
  installing dependencies, preserve command argv/status and clean up interrupted
  or timed-out commands. Refuse to manage SDK/OpenCode-owned boxes.
- Derive an attached twin's environment from the twin itself; reject gateway
  reconnects without a fresh credential; report a box ID if failed setup cannot
  delete it.
- Ship the CLI guide and check the packed executable in CI and before releases.

## 0.1.1 — 2026-08-31

No behaviour changes in either package: not a line of `@veris-ai/e2b` source
differs from `0.1.0`. This release exists to ship both packages through the
release workflow rather than by hand, so that they carry a build provenance
attestation — `0.1.0` was published from a laptop and has none.

### `@veris-ai/e2b-opencode`

- Declares `@opencode-ai/plugin` as an optional `peerDependency` at `>=1.18`,
  stating the OpenCode host floor the plugin is built against. It stays a
  devDependency too, and nothing is added to your install.

### Release pipeline

- A release run is now re-runnable: a package already on npm at that version is
  skipped rather than aborting the run, so a publish that fails halfway is
  finished by pressing the button again.
- Prereleases publish. The npm dist-tag is derived from the version
  (`0.2.0-rc.1` → `rc`), which npm 11 requires and the workflow never passed.
- Each publish is checked for a provenance attestation before the release is
  tagged.
- The local `npm run release` script is gone. The workflow is the only path to
  npm, which is what makes the attestation worth anything.

## 0.1.0 — 2026-08-31

First release.

### `@veris-ai/e2b`

- A drop-in for `e2b`: re-exports the whole SDK and overrides only `Sandbox`,
  so a single changed import puts a Veris twin behind every sandbox.
- `create()` provisions the twin, mints an egress credential, points the
  sandbox's network at the Veris gateway and installs the interception CA
  before it resolves; `kill()` deletes the twin with it.
- Two interception modes, picked by `mode: 'auto' | 'gateway' | 'proxy'`.
  `auto` prefers the gateway and falls back to the in-sandbox proxy.
- `connect()` rehydrates the same surface from sandbox metadata, so a resumed
  session keeps its receipts.
- `fork()` is refused: clones would share one twin and corrupt receipts.
- `sbx.veris`: `receipt()`, `assertTouched()`, `services()`,
  `getDataPlaneEnv()`, `getTrustEnv()`, `deliverTo()`.
- Typed errors for every failure phase — `MissingCredentialsError`,
  `VerisGatewayUnreachableError`, `ReceiptIntegrityError`, `VerisUntouchedError`,
  `TwinExpiredError` and the rest.

### `@veris-ai/e2b-opencode`

- An OpenCode plugin: one line in `opencode.json` and every session in that
  repo runs in a Veris-intercepted E2B sandbox.
- The agent's `bash`, `read`, `write`, `edit`, `glob`, `grep` and `ls` execute
  in the sandbox while the reasoning loop stays on the host — so the sandbox
  never holds a model key.
- Adds the `verisReceipt` tool, because an agent that fabricated an API response
  and one that really called it produce identical transcripts, and different
  receipts.
- Git sync and preview-URL tools for working against the sandbox's checkout.
