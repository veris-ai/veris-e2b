# @veris-ai/e2b

Run your integration tests and agent-generated code against **Veris dependency
sandboxes** — stateful, contract-accurate twins of Stripe, Google, and the rest
of your vendor stack — from inside **E2B sandboxes**, with the code under test
completely unmodified. `veris-proxy` reroutes outbound HTTPS at the kernel;
your code keeps its production hostnames, credentials, and SDKs, and the Veris
sandbox's **receipt** proves what it actually received.

One function layers all of it onto any E2B template:

```js
import { Template } from 'e2b'
import { withVeris } from '@veris-ai/e2b'

const template = withVeris(
  Template().fromTemplate('my-base-template'),   // everything you already have
  { binaryPath: './veris-proxy-linux-amd64' },
)
await Template.build(template, { alias: 'my-app-veris' })
```

Then every run:

```js
import { Sandbox } from 'e2b'
import { wakeVeris, verisTrustEnv, verisReceipt, verisTeardown } from '@veris-ai/e2b'

const sbx = await Sandbox.create('my-app-veris')
await wakeVeris(sbx, { apiKey: VERIS_API_KEY, environmentId: VERIS_ENVIRONMENT_ID })

const envs = await verisTrustEnv(sbx)                      // JVM truststore, CA paths…
await sbx.commands.run('cd ~/repo && npm test', { user: 'user', envs })

const receipt = await verisReceipt(sbx, { apiKey: VERIS_API_KEY })
// receipt.stripe.requests === 0 with green tests? The tests never touched
// Stripe. Don't trust that green.

await verisTeardown(sbx)                                   // deletes the per-run Veris sandbox
await sbx.kill()
```

## How it works

An E2B template is a snapshot of a **running** VM. `withVeris` adds layers that
install nftables and the proxy, create a dedicated unprivileged `veris` user
(uid 14741 — the kernel redirect's exemption), and set a start command that
installs the redirect, mints and trusts a CA, and then parks a tiny
supervisor. The snapshot captures all of it: every sandbox cloned from the
template boots (~1s) with interception pre-wired in its kernel, and **no run
ever uses root**.

Waking the supervisor starts `veris-proxy serve` as the `veris` user; the
proxy deploys a fresh Veris sandbox for the run (hermetic state, deleted at
teardown, TTL backstop), and every mapped vendor hostname your code dials —
`api.stripe.com`, `www.googleapis.com` — is answered by its twin. Unmapped
hosts (package registries, your own APIs) pass through untouched.

## Zero-touch mode (per-customer templates)

Bake the coordinates and clones need **no commands at all** — the supervisor
detects the snapshot resume by wall-clock jump and starts itself:

```js
const template = withVeris(Template().fromTemplate('acme-base'), {
  binaryPath: './veris-proxy-linux-amd64',
  environmentId: 'acme-vendor-env',     // this template ↔ this Veris environment
  apiKey: process.env.VERIS_API_KEY,    // PRIVATE templates only — lives in the snapshot
})
// later: Sandbox.create('acme-veris') → intercepting ~13s later, zero setup calls
```

The values ride a root-owned `/etc/veris/baked.env` (0600) — not `setEnvs`,
because template env vars don't survive the supervisor's sudo hop and
create-time envs never reach snapshot-resumed processes. `wakeVeris`
(run.env) still overrides per clone. Key rotation = rebuild (cheap, cached).

## Publishing a public template?

Pass `mintCaAtBoot: true`. It moves CA minting from build time to each
clone's first wake (~1–2s), so a published template carries **no shared CA
private key**. Never publish a template built with a baked `apiKey`.

## Options

| `withVeris(template, opts)` | |
|---|---|
| `binaryPath` (required) | local `veris-proxy-linux-amd64` from the [veris-proxy release](https://github.com/veris-ai/veris-proxy/releases) |
| `environmentId` | bake the Veris environment id (per-customer pattern) |
| `apiKey` | bake the key too → zero-touch clones (private templates only) |
| `apiBase` | non-default Veris control plane |
| `mintCaAtBoot` | per-clone CA — required before publishing publicly |
| `startCmd` | your template's own start command, chained before the supervisor (must exit or background) |

Runtime helpers: `wakeVeris(sbx, {…})`, `verisReady(sbx)`, `verisTrustEnv(sbx)`,
`verisSandboxId(sbx)`, `verisReceipt(sbx, {…})`, `verisTeardown(sbx)`.

## The two rules

1. **Never point the code at Veris.** No base-URL overrides. The proxy is the
   mechanism; the code path you test is the code path that ships.
2. **Never trust green without the receipt.** A suite that quietly stopped
   calling its dependency prints the same output as a working one.

## Requirements

- E2B account (the template builds on E2B's infra; sandboxes need nothing special)
- `VERIS_API_KEY` + a Veris environment naming your vendor services
- The `veris-proxy` linux-amd64 binary ≥ v0.5.0 (the nftables fallback E2B's
  kernel needs shipped in v0.5.0; route serving in v0.6.0)

## Publish checklist (maintainers)

- [ ] Make `veris-proxy` release binaries publicly downloadable (repo public, or
      push to a public bucket / `install.veris.ai`) → drop the `binaryPath`
      requirement and download at build via `runCmd`
- [ ] `npm publish` under `@veris-ai` (this package is dependency-free; `e2b` is a peer)
- [ ] PyPI mirror (`veris-e2b`) for the Python Template SDK
- [ ] Publish a public trial template (`mintCaAtBoot`, no baked key) via `e2b template publish`
- [ ] PR an example into `e2b-dev/e2b-cookbook` (precedent: their Claude Code template example)
- [ ] Verify `fromTemplate()` start-command chaining semantics on a customer-style base
