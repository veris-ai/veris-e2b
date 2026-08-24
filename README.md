# Veris SDK for E2B

Run your code in an [E2B](https://e2b.dev) sandbox where calls to
`api.stripe.com`, `www.googleapis.com`, and the rest of your vendor stack are
answered by **Veris dependency sandboxes** — stateful, contract-accurate mocks —
with the code under test completely unmodified.

No base-URL overrides, no injected config. Your code keeps its production
hostnames, credentials, and SDKs; the network layer does the rest.

## 1. Install

```bash
npm i @veris-ai/e2b
```

This package re-exports everything from `e2b`, so it's the only one you need.

## 2. Get your keys

| Variable | Where from |
|---|---|
| `E2B_API_KEY` | [e2b.dev/dashboard](https://e2b.dev/dashboard) |
| `VERIS_API_KEY` | your Veris dashboard |
| `VERIS_ENVIRONMENT_ID` | a Veris environment — it decides which vendor services your sandbox gets |

```bash
export E2B_API_KEY=e2b_…
export VERIS_API_KEY=…
export VERIS_ENVIRONMENT_ID=…
```

## 3. Run code against mocked vendors

```ts
import { Sandbox } from '@veris-ai/e2b'

const sbx = await Sandbox.create()

// api.stripe.com is answered by your Veris mock — the code never knows.
const res = await sbx.commands.run(
  'curl -sS https://api.stripe.com/v1/customers -u sk_test_veris:'
)
console.log(res.stdout)

await sbx.kill()
```

## 4. Check the receipt

A test suite that quietly stopped calling its dependency prints the same output
as one that works. The receipt is how you tell them apart:

```ts
// throws unless the service actually saw a matching request
await sbx.veris.assertTouched('stripe', { method: 'POST', path: '/v1/charges' })

const receipt = await sbx.veris.receipt()
console.log(receipt.services.stripe?.requests) // → 3
```

## 5. Check out docs

Full API reference and the vendor catalog: [docs.veris.ai](https://docs.veris.ai).

---

## The `sbx.veris` API

Everything this package adds lives on one accessor, alongside e2b's own
`sbx.commands` and `sbx.files`:

```ts
await sbx.veris.receipt()                   // all services: counts + typed requests
await sbx.veris.receipt('stripe')           // one service
await sbx.veris.assertTouched('stripe')     // throws if it was never called
await sbx.veris.services()                  // what's running in this sandbox
await sbx.veris.getDataPlaneEnv()           // { DATABASE_URL: 'postgresql://…' }
await sbx.veris.getTrustEnv()               // CA paths, for processes that scrub env

sbx.verisSandboxId                          // the Veris sandbox backing this one
sbx.verisMode                               // 'gateway' | 'proxy'
```

## Options

```ts
const sbx = await Sandbox.create({
  timeoutMs: 15 * 60_000,        // any e2b option works
  veris: {
    environmentId: '…',          // default: VERIS_ENVIRONMENT_ID
    apiKey: '…',                 // default: VERIS_API_KEY
    mode: 'auto',                // 'auto' | 'gateway' | 'proxy'
    egress: 'strict',            // 'strict' | 'open'
    allowOut: ['registry.npmjs.org'],  // extra hosts your code may reach
  },
})
```

**`mode`** picks how interception happens. `gateway` routes egress through a
Veris-operated proxy — nothing runs inside your sandbox. `proxy` runs the
interceptor inside the sandbox instead, which works anywhere including
self-hosted E2B. `auto` (the default) uses the gateway when it's available and
falls back to the proxy.

**`egress`** is `strict` by default: only your vendor hosts, `allowOut`
additions, and data planes can leave the sandbox. Use `open` to let everything
out (npm, pip, GitHub) at the cost of two blind spots the receipt annotates.

## Using a template

Any E2B template works — pass it as the first argument:

```ts
const sbx = await Sandbox.create('my-template', { veris: { environmentId } })
```

## Limitations

- **`fork()` is not supported.** Forked sandboxes would share one Veris sandbox
  and corrupt each other's receipts; it throws instead.
- **Clients that pin their own CA bundle** (some vendor SDKs ship one and ignore
  the system trust store) need to be pointed at `/etc/ssl/certs/ca-certificates.crt`.
- **HTTP/2 and WebSockets on mocked hosts** are not yet handled in gateway mode;
  HTTP/1.1 over TLS is. Non-mocked hosts are unaffected.

## Development

```bash
npm install
npm run build      # tsup (ESM+CJS) + tsc (declarations)
npm test           # unit tests — mocked, no account needed
npm run typecheck
```

Live tests need real credentials and are opt-in:

```bash
VERIS_E2E=proxy npm run test:live
```

## License

Apache-2.0
