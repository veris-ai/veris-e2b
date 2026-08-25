# API reference

Everything beyond the [quickstart](../README.md). `Sandbox` is a real subclass
of E2B's, so anything the [E2B SDK](https://e2b.dev/docs) does works here too;
this covers what Veris adds.

## Contents

- [Creating a sandbox](#creating-a-sandbox)
- [The `sbx.veris` API](#the-sbxveris-api)
- [Receipts](#receipts)
- [Webhooks](#webhooks)
- [Interception modes](#interception-modes)
- [Egress policy](#egress-policy)
- [Templates](#templates)
- [Errors](#errors)
- [Limitations](#limitations)

## Creating a sandbox

Every E2B option works as usual; Veris options live under one `veris` key so a
future E2B release can't collide with them.

```ts
const sbx = await Sandbox.create({
  timeoutMs: 15 * 60_000,              // any e2b option works
  veris: {
    environmentId: '…',                // default: VERIS_ENVIRONMENT_ID
    apiKey: '…',                       // default: VERIS_API_KEY
    apiBase: 'https://api.veris.ai',   // default: VERIS_API_BASE
    mode: 'auto',                      // 'auto' | 'gateway' | 'proxy'
    egress: 'strict',                  // 'strict' | 'open'
    allowOut: ['registry.npmjs.org'],  // extra hosts your code may reach
    ttlMinutes: 25,                    // twin lifetime; default: timeout + 10
    installCa: true,                   // trust the interception CA (default true)
    dataPlaneEnv: true,                // inject DATABASE_URL etc. (default true)
    attachSandboxId: '…',              // reuse an existing Veris sandbox
  },
})
```

| Option | Default | What it does |
|---|---|---|
| `environmentId` | `VERIS_ENVIRONMENT_ID` | Which Veris environment the mocks come from — it decides which vendor services you get. |
| `apiKey` | `VERIS_API_KEY` | Veris credential. |
| `apiBase` | `VERIS_API_BASE` or `https://api.veris.ai` | Control plane to talk to. |
| `mode` | `'auto'` | How interception happens — see [modes](#interception-modes). |
| `egress` | `'strict'` | What may leave the sandbox — see [egress policy](#egress-policy). |
| `allowOut` | `[]` | Extra hosts or CIDRs your code may reach (npm, your own API). A hostname is interceptable; a CIDR is passed through. |
| `ttlMinutes` | `timeoutMs` + 10 | Backstop lifetime for the Veris sandbox, in case teardown never runs. |
| `installCa` | `true` | Install the interception CA into the sandbox's trust stores. |
| `dataPlaneEnv` | `true` | Inject non-HTTP connection strings (e.g. `DATABASE_URL`) as env. |
| `attachSandboxId` | — | Attach to an existing Veris sandbox instead of creating one. `kill()` will not delete it. |

`Sandbox.connect(id)` reattaches to a running sandbox and restores all of the
above from its metadata; you only need the E2B sandbox id and your API key.

## The `sbx.veris` API

```ts
await sbx.veris.receipt()                   // all services: counts + typed requests
await sbx.veris.receipt('stripe')           // one service
await sbx.veris.assertTouched('stripe')     // throws if it was never called
await sbx.veris.services()                  // what's running in this sandbox
await sbx.veris.getDataPlaneEnv()           // { DATABASE_URL: 'postgresql://…' }
await sbx.veris.getTrustEnv()               // CA paths, for processes that scrub env
await sbx.veris.deliverTo(3000)             // send webhooks to this sandbox
await sbx.veris.updateNetwork({ … })        // change egress without losing interception

sbx.verisSandboxId                          // the Veris sandbox backing this one
sbx.verisMode                               // 'gateway' | 'proxy'
```

## Receipts

A suite that quietly stopped calling its dependency prints the same output as
one that works. The receipt is how you tell them apart.

```ts
await sbx.veris.assertTouched('stripe')
await sbx.veris.assertTouched('stripe', { method: 'POST', path: '/v1/charges' })
await sbx.veris.assertTouched('stripe', { minRequests: 3 })
```

`assertTouched` throws `VerisUntouchedError` when nothing matched, and a plain
`VerisError` when the service name doesn't exist — a typo and an untouched
dependency are different failures.

`receipt()` returns the whole picture:

```ts
{
  services: { stripe: { requests: 3, controlUrl: '…', entries: [ { method, path, status } ], raw } },
  mode: 'gateway',            // which mechanism produced this
  integrity: 'verified',      // interception was re-proven just now
  leaks: [],                  // known blind spots of THIS mode (see below)
}
```

`integrity` is `'verified'` only when the tunnel was re-proven at read time; in
proxy mode it is `'proxy-mode-unverified'`, because that mode can't prove it.
`leaks` names blind spots the mode genuinely has — `udp-quic-possible` and
`ech-possible` — rather than implying a receipt sees everything.

## Webhooks

If your app *receives* callbacks, tell the mocks where to deliver them:

```ts
const sbx = await Sandbox.create({ allowPublicTraffic: true })
await sbx.commands.run('node app.js', { background: true })  // listening on :3000

await sbx.veris.deliverTo(3000)          // → https://3000-<id>.e2b.app
await sbx.veris.deliverTo('https://my.tunnel.dev')   // or your own URL
await sbx.veris.deliverTo(null)          // unregister
await sbx.veris.deliverTo(3000, { probe: false })    // skip the reachability check
```

`deliverTo` resolves the sandbox's own public URL — the address a vendor would
POST to in production — registers it with **every** mocked service in one call,
and verifies they can actually reach it before returning. The sandbox must be
created with `allowPublicTraffic: true`, or the mocks can't reach it.

## Interception modes

Both end with the mock answering; they differ in where the interception runs.

| | `gateway` | `proxy` |
|---|---|---|
| Where interception runs | a Veris-operated egress gateway | inside the sandbox |
| In-sandbox footprint | one CA file | interceptor process + network rules |
| Bypassable by sandbox code | no (host-side) | yes, by code running as root |
| Works on self-hosted E2B | no | yes |

`mode: 'auto'` (the default) uses the gateway when the control plane offers it
and interception is proven live, and otherwise falls back to the proxy with a
warning — the two carry different guarantees, so the fallback is never silent.

## Egress policy

- **`egress: 'strict'`** (default) — only your vendor hosts, `allowOut`
  additions, and data planes may leave the sandbox. QUIC/HTTP3 and ECH fail
  closed, so the receipt has no known blind spots.
- **`egress: 'open'`** — everything may leave (npm, pip, GitHub work with no
  configuration), at the cost of two blind spots the receipt annotates in
  `leaks`: a QUIC or ECH client could reach a real vendor unseen.

Use `strict` if your code speaks HTTP/3 or ECH to a mocked vendor.

To change egress later without losing interception, use
`sbx.veris.updateNetwork()` rather than the raw E2B call — the raw one clears
omitted fields and would drop the interception config.

## Templates

Any E2B template works — pass it as the first argument:

```ts
const sbx = await Sandbox.create('my-template', { veris: { environmentId } })
```

Gateway mode needs `ca-certificates` in the image (to trust the interception
CA); a template without it fails with `TemplateUnsupportedError` rather than
running half-configured.

## Errors

Every error extends `VerisError`, so one `catch` separates Veris failures from
E2B's, and each carries a `phase` naming where it died.

| Error | When |
|---|---|
| `MissingCredentialsError` | A required key or environment id is absent — thrown before any network call, naming the variable. |
| `VerisGatewayNotOfferedError` | Gateway mode was forced but the control plane doesn't offer it. |
| `VerisGatewayUnreachableError` | The gateway is down. |
| `ReceiptIntegrityError` | Interception could not be proven — a receipt read now would lie. |
| `VerisUntouchedError` | `assertTouched` found no matching requests. |
| `TwinExpiredError` | The Veris sandbox is gone (expired or deleted). |
| `TemplateUnsupportedError` | The template can't host the interception CA. |
| `UnsupportedOperationError` | An operation that would break the one-sandbox-one-mock invariant, e.g. `fork()`. |

## Limitations

- **`fork()` is not supported.** Forked sandboxes would share one Veris sandbox
  and corrupt each other's receipts, so it throws.
- **Clients that pin their own CA bundle** (some vendor SDKs ship one and ignore
  the system trust store) must be pointed at
  `/etc/ssl/certs/ca-certificates.crt`.
- **HTTP/2 and WebSockets on mocked hosts** are not yet handled in gateway mode;
  HTTP/1.1 over TLS is. Non-mocked hosts are unaffected.
