# @veris-ai/e2b

Run your integration tests and agent-generated code against **Veris dependency
sandboxes** — stateful, contract-accurate twins of Stripe, Google, and the rest
of your vendor stack — from inside **E2B sandboxes**, with the code under test
completely unmodified. Your code keeps its production hostnames, credentials,
and SDKs; the calls to `api.stripe.com` are answered by your Veris twin; and the
twin's **receipt** proves what it actually received.

`@veris-ai/e2b` is a drop-in subclass of the E2B `Sandbox` — the same shape as
[`@e2b/code-interpreter`](https://github.com/e2b-dev/code-interpreter). You
install one package and import `Sandbox` from it.

```ts
// npm i @veris-ai/e2b
// Required env: E2B_API_KEY, VERIS_API_KEY, VERIS_ENVIRONMENT_ID
import { Sandbox } from '@veris-ai/e2b'

const sbx = await Sandbox.create()
try {
  // No base-URL override, no proxy config — https://api.stripe.com is answered
  // by your Veris twin, invisibly.
  const r = await sbx.commands.run('curl -sS https://api.stripe.com/v1/customers -u sk_test_veris:')
  console.log(r.stdout)

  await sbx.veris.assertTouched('stripe')   // never trust green without the receipt
} finally {
  await sbx.kill()                           // kills the E2B sandbox AND deletes the twin
}
```

## Two doctrines

1. **Never point your code at Veris.** No base-URL overrides, no injected
   config. Interception is done by the network layer; the code path you test is
   the code path that ships.
2. **Never trust green without the receipt.** A suite that quietly stopped
   calling its dependency prints the same output as a working one.
   `sbx.veris.assertTouched('stripe')` is that check as one line.

## Status — what is verified today

This package is `2.0.0-alpha`: the class API and **proxy mode** are the
supported surface; **gateway mode** is implemented client-side but its
server-side gateway does not exist yet, so it cannot run end to end.

| Capability | State |
|---|---|
| `Sandbox` class (`create`/`connect`/`kill`/`setTimeout`), `sbx.veris.*` | **Verified** against dev, on proxy mode |
| Proxy mode (in-sandbox `veris-proxy`, the v1 mechanism) | **Verified** — same machinery as v0.1, now class-shaped |
| Receipts, `assertTouched`, data-plane env, trust env | **Verified** on proxy mode |
| Deprecated v1 free functions (`setupVeris`, `withVeris`, …) | **Verified** — unchanged behavior |
| Gateway mode (E2B BYOP SOCKS5 egress, no in-sandbox footprint) | **Client implemented, unit-tested; blocked on** the Veris gateway deploy + E2B BYOP beta. `mode: 'gateway'` throws `VerisGatewayNotOfferedError` until the control plane offers it |

`mode: 'auto'` (the default) uses gateway mode when the control plane offers it
to this SDK version and the post-create canary proves the tunnel is live;
otherwise it falls back to proxy mode with a loud warning, because the two modes
have different trust properties (see [Modes](#modes)).

## The `sbx.veris` surface

Everything this package adds hangs off one namespaced accessor, matching E2B's
own `sbx.commands` / `sbx.files` idiom so a future E2B minor can never collide
with a generic name:

| Call | What it does |
|---|---|
| `sbx.veris.receipt()` | Full receipt: per service, the count and typed list of intercepted requests, `mode`, `integrity`, and (open mode) `leaks`. In gateway mode it runs the canary first and throws if egress is no longer tunneled. |
| `sbx.veris.receipt('stripe')` | Just that service's entry. |
| `sbx.veris.assertTouched('stripe')` | Throws `VerisUntouchedError` unless the service saw ≥1 intercepted request. Optional matcher: `assertTouched('stripe', { method: 'POST', path: '/v1/charges', minRequests: 1 })`. |
| `sbx.veris.services()` | The twin's services (name, url, controlUrl, envHint, routes). |
| `sbx.veris.getDataPlaneEnv()` | `{ [envHint]: dsn }` for non-HTTP twins (e.g. `DATABASE_URL`). Injected at create; exposed for processes that scrub their env. |
| `sbx.veris.getTrustEnv()` | CA-trust env map (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, …). Injected at create. |

`sbx.verisSandboxId` and `sbx.verisMode` are top-level conveniences (the twin id
and `'gateway' | 'proxy'`), handy for asserting the mode in CI.

## Modes

**Proxy mode** (verified today) runs `veris-proxy` inside the sandbox as an
unprivileged user; an nftables redirect sends tcp/80+443 to it, and it MITMs
with a locally minted CA. The API key reaches the sandbox during setup and root
is exempt from the redirect — properties that matter for your threat model.

**Gateway mode** (pending infra) runs nothing Veris in the sandbox. E2B's
native egress ([BYOP](https://docs.e2b.dev/network/byop)) tunnels vendor
hostnames through a Veris-operated SOCKS5 gateway that MITMs them and answers
from your twin; unmapped hosts (npm, GitHub, your own APIs) pass through
untouched. The only in-sandbox footprint is one CA file. A post-create
**canary** proves egress is actually tunneled before any receipt is trusted, so
an E2B account without the BYOP beta flag can never masquerade as a working
sandbox.

Choosing:

- `mode: 'auto'` (default) — gateway when available, else proxy (loud warning).
- `mode: 'gateway'` — require gateway; throw if unavailable.
- `mode: 'proxy'` — require proxy (also the right choice for self-hosted E2B,
  which cannot offer BYOP).

### Egress policy (gateway mode)

- `egress: 'strict'` (default) — deny-all plus an allowlist of your vendor
  hosts, `veris.allowOut` additions, and data-plane endpoints. QUIC/HTTP3 and
  ECH fail closed, so the receipt has no known blind spots. This is the default
  because "never trust green without the receipt" only holds when the receipt
  can see everything.
- `egress: 'open'` — adds a `0.0.0.0/0` catch-all so npm/pip/GitHub work with
  zero config, at the cost of two receipt blind spots (a QUIC/HTTP3 or ECH
  client can reach a real vendor without the receipt seeing it). `receipt()`
  annotates these in its `leaks` field. Use strict if your workload speaks
  HTTP/3 or ECH toward a mocked vendor.

## Migration from v0.1

The v1 free functions still work and are re-exported (deprecated). The class is
the new surface.

| v0.1 | v2 |
|---|---|
| direct `e2b` dependency alongside this package | remove it; import everything from `@veris-ai/e2b` (`e2b` is now a regular dependency — two copies break `instanceof`) |
| `Sandbox.create()` + `setupVeris(sbx, {...})` | `Sandbox.create({ veris: {...} })` |
| `withVeris(t, {...})` + `startVeris(sbx, {...})` | build a plain template; `Sandbox.create('tpl', { veris: {...} })` — or keep both, proxy mode auto-detects |
| `verisTrustEnv(sbx)` spread into every run | nothing (auto), or `sbx.veris.getTrustEnv()` |
| `verisReceipt(sbx, {apiKey})` | `sbx.veris.receipt()` / `sbx.veris.assertTouched('stripe')` — note the receipt shape changed (services under `.services`, camelCase fields, `raw` still verbatim) |
| `verisDataPlaneEnv(sbx, {...})` | auto-injected; `sbx.veris.getDataPlaneEnv()` |
| `verisSandboxId(sbx)` | `sbx.verisSandboxId` |
| `verisTeardown(sbx); sbx.kill()` | `sbx.kill()` |

## Examples

- [`examples/quickstart.mjs`](examples/quickstart.mjs) — the loop above, runnable.
- [`examples/full-loop.mjs`](examples/full-loop.mjs) — clone, `npm ci`, test, prove, tear down.
- [`examples/legacy/`](examples/legacy) — the v0.1 free-function examples, unchanged (proxy mode).

## Development

```sh
npm install
npm run build      # tsup (JS) + tsc (declarations)
npm test           # unit tests (mocked; no E2B/Veris account needed)
npm run typecheck
```

Live tests that touch real E2B + Veris live under `tests/live/` and are opt-in.
