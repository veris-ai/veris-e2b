# veris-e2b

Veris interception for [E2B](https://e2b.dev): vendor API calls made inside an
E2B sandbox are answered by a stateful Veris twin, and every run ends with a
receipt of what the vendor actually received.

Two packages, one repo, because they move together.

| package | what it is |
|---|---|
| [`@veris-ai/e2b`](./e2b) | The SDK. A drop-in subclass of E2B's `Sandbox` whose `create()` also provisions the twin, points the sandbox's egress at the Veris gateway and installs the interception CA — and whose `kill()` deletes the twin with it. |
| [`@veris-ai/e2b-opencode`](./e2b-opencode) | An OpenCode plugin. One line in `opencode.json` and every session in that repo runs in a Veris-intercepted sandbox. |

## The SDK

```ts
import { Sandbox } from '@veris-ai/e2b'   // was: 'e2b'

const sbx = await Sandbox.create()
await sbx.commands.run('curl -sS https://api.stripe.com/v1/customers -u sk_test_veris:')
await sbx.veris.assertTouched('stripe')
await sbx.kill()
```

Every E2B option still works — it is a real subclass — so an existing template
or workflow keeps working with the import changed. Details in
[`e2b/README.md`](./e2b/README.md) and [`e2b/docs/reference.md`](./e2b/docs/reference.md).

## The OpenCode plugin

```jsonc
// opencode.json
{ "plugin": ["@veris-ai/e2b-opencode"] }
```

The agent's `bash`, `read`, `write` and the rest execute in the sandbox while the
reasoning loop stays on your machine — so the sandbox never holds your model
key. Adds a `verisReceipt` tool, because an agent that fabricated an API response
and one that really called it produce identical transcripts. They produce
different receipts. See [`e2b-opencode/README.md`](./e2b-opencode/README.md).

## Working in this repo

```sh
npm install          # links both workspaces
npm run build
npm run typecheck
npm test             # unit tests for both packages
npm run test:live    # SDK only; needs E2B_API_KEY, VERIS_API_KEY, VERIS_ENVIRONMENT_ID
```

`@veris-ai/e2b` must reach npm before `@veris-ai/e2b-opencode` can: the plugin
depends on it by version, and it is unpublished today.
