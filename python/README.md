# Veris SDK for E2B — Python

Run your code in an [E2B](https://e2b.dev) sandbox where calls to
`api.stripe.com`, `www.googleapis.com`, and the rest of your vendor stack are
answered by **Veris dependency sandboxes** — stateful, contract-accurate mocks —
with the code under test completely unmodified.

No base-URL overrides, no injected config. Your code keeps its production
hostnames, credentials, and SDKs; the network layer does the rest.

This is the Python sibling of [`@veris-ai/e2b`](../e2b). Same control plane, same
contract, same option names in snake_case — see [differences](#differences-from-the-typescript-sdk).

## 1. Install

```bash
uv add veris-e2b        # or: pip install veris-e2b
```

It depends on `e2b`, so that comes with it.

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

```python
from veris_e2b import Sandbox

sbx = Sandbox.create()

# api.stripe.com is answered by your Veris mock — the code never knows.
result = sbx.commands.run("curl -sS https://api.stripe.com/v1/customers -u sk_test_veris:")
print(result.stdout)

sbx.kill()
```

Inside an event loop, use `AsyncSandbox` — same contract, awaited:

```python
from veris_e2b import AsyncSandbox

sbx = await AsyncSandbox.create()
await sbx.commands.run("curl -sS https://api.stripe.com/v1/customers -u sk_test_veris:")
await sbx.kill()
```

## 4. Check the receipt

A test suite that quietly stopped calling its dependency prints the same output
as one that works. The receipt is how you tell them apart:

```python
from veris_e2b import TouchMatcher

# raises VerisUntouchedError unless the service actually saw a matching request
sbx.veris.assert_touched("stripe", TouchMatcher(method="POST", path="/v1/charges"))
```

## Creating a sandbox

Every E2B option still works; the Veris options live under one `veris` keyword so
a future e2b release cannot collide with them. Pass a `VerisOpts` or a plain dict.

```python
from veris_e2b import Sandbox, VerisOpts

sbx = Sandbox.create(
    "my-template",  # any e2b template
    timeout=15 * 60,  # any e2b option, seconds
    veris=VerisOpts(
        environment_id="env_…",  # default: VERIS_ENVIRONMENT_ID
        api_key="…",  # default: VERIS_API_KEY
        api_base="https://svc.api.veris.ai",  # default: VERIS_API_BASE
        snapshot_id="snap_…",  # boot the twin from a snapshot
        attach_sandbox_id="sb_…",  # or reuse an existing twin
        egress="strict",  # "strict" | "open"
        allow_out=["pypi.org"],  # extra hosts your code may reach
        ttl_minutes=25,  # twin lifetime; default: timeout + 10
        install_ca=True,  # trust the interception CA
        data_plane_env=True,  # inject DATABASE_URL etc.
    ),
)
```

| Option | Default | What it does |
|---|---|---|
| `environment_id` | `VERIS_ENVIRONMENT_ID` | Which Veris environment the mocks come from — it decides which vendor services you get. |
| `api_key` | `VERIS_API_KEY` | Veris credential. |
| `api_base` | `VERIS_API_BASE` or `https://svc.api.veris.ai` | Control plane to talk to. |
| `snapshot_id` | — | Boot the twin from one of the environment's snapshots instead of its baseline, so every run starts from the same known state. Mutually exclusive with `attach_sandbox_id`. |
| `attach_sandbox_id` | — | Attach to an existing Veris sandbox instead of creating one. `kill()` will not delete it. |
| `ttl_minutes` | timeout + 10 | Backstop lifetime for the Veris sandbox, in case teardown never runs. |
| `egress` | `"strict"` | What may leave the sandbox — see [egress policy](#egress-policy). |
| `allow_out` | `[]` | Extra hosts or CIDRs your code may reach. A hostname is interceptable; a CIDR is passed through. |
| `install_ca` | `True` | Install the interception CA into the sandbox's trust stores. |
| `data_plane_env` | `True` | Inject non-HTTP connection strings (e.g. `DATABASE_URL`) as env. |
| `mode` | `"auto"` | `"auto"` and `"gateway"` both mean gateway mode here — see [differences](#differences-from-the-typescript-sdk). |

### Starting from a known state

A twin booted from the environment's baseline starts wherever that environment
starts. `snapshot_id` pins it to a snapshot you captured earlier, so a suite, a
benchmark, or a person exploring by hand all begin from the same rows:

```python
sbx = Sandbox.create(veris=VerisOpts(environment_id="env_…", snapshot_id="snap_…"))
```

The snapshot must belong to that environment — the control plane refuses one that
does not, and the error names the snapshot rather than the environment. It is
recorded in the sandbox's E2B metadata as `veris_snapshot_id`, so a running
sandbox can always say what state it started from.

## The `sbx.veris` API

```python
sbx.veris.receipt()  # all services: counts + typed requests
sbx.veris.receipt("stripe")  # one service
sbx.veris.assert_touched("stripe")  # raises if it was never called
sbx.veris.services()  # what's running in this twin
sbx.veris.get_data_plane_env()  # {"DATABASE_URL": "postgresql://…"}
sbx.veris.get_trust_env()  # CA paths, for processes that scrub env
sbx.veris.deliver_to(3000)  # send webhooks to this sandbox
sbx.veris.update_network({...})  # change egress without losing interception

sbx.veris_sandbox_id  # the Veris twin backing this sandbox
sbx.veris_mode  # "gateway"
```

`AsyncSandbox` exposes the same names, awaited.

### Receipts

```python
receipt = sbx.veris.receipt()
receipt.services["stripe"].requests  # 3
receipt.integrity  # "verified" — the tunnel was re-proven just now
receipt.leaks  # [] in strict mode
```

`integrity` is `"verified"` only when the canary probe confirmed egress is still
tunneled at read time. `leaks` names blind spots the current egress mode genuinely
has (`udp-quic-possible`, `ech-possible`) rather than implying a receipt sees
everything.

### Webhooks

If your app *receives* callbacks, tell the mocks where to deliver them:

```python
sbx = Sandbox.create(network={"allow_public_traffic": True})
sbx.commands.run("python app.py", background=True)  # listening on :3000

sbx.veris.deliver_to(3000)  # → https://3000-<id>.e2b.app
sbx.veris.deliver_to("https://my.tunnel.dev")  # or your own URL
sbx.veris.deliver_to(None)  # unregister
sbx.veris.deliver_to(3000, probe=False)  # skip the reachability check
```

`deliver_to` resolves the sandbox's own public URL — the address a vendor would
POST to in production — registers it with **every** mocked service in one call,
and verifies they can actually reach it before returning.

### Reattaching

```python
sbx = Sandbox.reconnect("i7x2qk9d0v3mnbhs", api_key="…")
```

`reconnect` restores the whole Veris surface from the sandbox's metadata, re-asserts
egress in case a raw update dropped it, and re-proves the tunnel. It is named
`reconnect` rather than `connect` because e2b's `connect` is also an instance method
(resume *this* sandbox), and one name cannot mean two things.

## Egress policy

- **`egress="strict"`** (default) — only your vendor hosts, `allow_out` additions,
  and data planes may leave the sandbox. QUIC/HTTP3 and ECH fail closed, so the
  receipt has no known blind spots.
- **`egress="open"`** — everything may leave (pip, npm, GitHub work with no
  configuration), at the cost of two blind spots the receipt annotates in `leaks`:
  a QUIC or ECH client could reach a real vendor unseen.

To change egress later without losing interception, use `sbx.veris.update_network()`
rather than the raw e2b call — the raw one clears omitted fields and would drop
the interception config.

## Templates

Any E2B template works — pass it as the first argument. The image needs
`ca-certificates` (to trust the interception CA); a template without it raises
`TemplateUnsupportedError` rather than running half-configured.

## Errors

Every error subclasses `VerisError`, so one `except` separates Veris failures from
e2b's, and each carries a `phase` naming where it died.

| Error | When |
|---|---|
| `MissingCredentialsError` | A required key or environment id is absent — raised before any network call, naming the variable. |
| `VerisGatewayNotOfferedError` | The control plane does not offer gateway mode. |
| `VerisGatewayUnreachableError` | The gateway is down. |
| `ReceiptIntegrityError` | Interception could not be proven — a receipt read now would lie. |
| `VerisUntouchedError` | `assert_touched` found no matching requests. |
| `TwinExpiredError` | The Veris sandbox is gone (expired or deleted). |
| `TemplateUnsupportedError` | The template can't host the interception CA. |
| `UnsupportedOperationError` | An operation that would break the one-sandbox-one-twin invariant, e.g. `fork()`. |

## Differences from the TypeScript SDK

- **Gateway mode only.** The in-sandbox `proxy` fallback needs the veris-proxy
  machinery that `@veris-ai/e2b` carries; `mode="proxy"` raises rather than
  pretending. A control plane that does not offer the gateway is refused loudly,
  not silently un-intercepted — use the TypeScript package there.
- **`reconnect`, not `connect`** — see [Reattaching](#reattaching).
- **snake_case options**, and `veris=` is a keyword argument rather than a key in
  the options object.
- **Both sync and async**: `Sandbox` and `AsyncSandbox`, mirroring e2b's own pair.

## Limitations

- **`fork()` is not supported.** Forked sandboxes would share one twin and corrupt
  each other's receipts, so it raises.
- **Clients that pin their own CA bundle** (some vendor SDKs ship one and ignore
  the system trust store) must be pointed at `/etc/ssl/certs/ca-certificates.crt`.
- **HTTP/2 and WebSockets on mocked hosts** are not yet handled in gateway mode;
  HTTP/1.1 over TLS is. Non-mocked hosts are unaffected.

## Development

```bash
uv sync
uv run pytest         # unit tests — mocked, no account needed
uv run ruff check .
uv run ruff format .
```

## Releasing

```bash
uv version 0.2.0      # then uv lock, commit, PR, merge
```

Then **Actions → release-python → Run workflow**. It builds, checks the artifacts
and publishes to PyPI over trusted publishing (OIDC, no token), then tags
`python-v0.2.0`. `dry_run: true` rehearses everything but the publish. Versions
are PEP 440 (`0.2.0rc1`, not `0.2.0-rc.1`), and this package versions separately
from the npm pair. Details in [CONTRIBUTING.md](../CONTRIBUTING.md#releasing-the-python-package).

## License

Apache-2.0
