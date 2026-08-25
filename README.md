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
```

## Verify it end to end

`examples/verify.mjs` stands up a sandbox, reads the credentials the mocks
publish, makes authenticated calls to `www.googleapis.com` and `api.stripe.com`,
and asserts from the receipt that the mocks served them:

```bash
node examples/verify.mjs
```

## 5. Check out the docs

- [API reference](docs/reference.md) — options, receipts, webhooks, modes, errors
- [docs.veris.ai](https://docs.veris.ai) — the vendor catalog and platform docs

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
