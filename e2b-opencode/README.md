# OpenCode, in an E2B sandbox, against a Veris twin

Add one line to `opencode.json` and every OpenCode session in that repo runs in
an E2B sandbox whose outbound vendor API calls are answered by a Veris twin —
with a receipt of what the vendor actually received.

```jsonc
// opencode.json
{ "plugin": ["@veris-ai/e2b-opencode"] }
```

```sh
export E2B_API_KEY=…           # https://e2b.dev/dashboard
export VERIS_API_KEY=…         # https://app.veris.ai
export VERIS_ENVIRONMENT_ID=…
```

Then `opencode`. No image to build, no template to register, no server to start,
no URL to copy.

## What the agent gets

Eight sandbox-backed replacements for OpenCode's built-in tools — `bash`,
`read`, `write`, `edit`, `multiedit`, `ls`, `glob`, `grep` — plus three
additions:

- **`verisReceipt`** — what the twin *received*. The tool that separates a real
  integration from a plausible-looking one.
- **`gitSync`** — commit in the sandbox and pull into the local `opencode/N`
  branch, returning only once the changes are on your machine.
- **`getPreviewURL`** — the public URL for a port inside the sandbox.

```
Veris receipt — twin sbx_a1b2c3
  interception: gateway   integrity: verified

1 request(s) reached the twin:
  stripe: 1 request(s)
    POST /v1/charges -> 200
```

An empty receipt after a green run means the code never reached its dependency.
Ask an agent to call the Stripe API and it will report success whether or not it
made the call; the transcripts are identical. The receipts are not.

## Where the agent runs, and why that matters

The reasoning loop, the model calls and your context stay **on your machine**.
Only the tools reach into the sandbox.

That is not an implementation detail. It means the sandbox never holds your
model provider key, and its egress never has to be widened to reach
`api.anthropic.com`. The narrower the sandbox's egress, the more the receipt is
worth.

```
your laptop                     E2B sandbox
┌──────────────────┐            ┌──────────────────────┐
│ agent loop       │            │ bash · read · write  │
│ model calls      │──tools────▶│ edit · glob · grep   │──▶ Veris twin
│ your context     │            │ the code under test  │
└──────────────────┘            └──────────────────────┘
```

## File sync

Your work reaches the sandbox, and the agent's work comes back, as **git
bundles** moved over E2B's filesystem API. There is no SSH endpoint, no listening
service, no open port and no credential in either direction.

- At session start, local `HEAD` is bundled and adopted in the sandbox as the
  `opencode` branch, so the agent opens on the commit you were looking at.
- On idle, and whenever the agent runs `gitSync`, the sandbox commits and the new
  history is bundled home onto a local `opencode/N` branch — one per sandbox.
- Bundles are incremental where possible, using the branch tip you already have
  as the basis, and fall back to the full branch.

> [!CAUTION]
> The plugin owns the `opencode/*` branches. Local changes on them are
> overwritten by a sync. It only ever syncs sandbox → local; to hand work the
> other way, commit locally and start a new session.

Without a git repo in the working directory, sync is disabled and the sandbox
still works — you just have to move files yourself.

## Configuration

| variable | required | meaning |
|---|---|---|
| `E2B_API_KEY` | yes | E2B account |
| `VERIS_API_KEY` | yes | Veris account |
| `VERIS_ENVIRONMENT_ID` | yes | which vendor services the twin runs |
| `VERIS_E2B_TEMPLATE` | no | an E2B template name; defaults to E2B's base image |
| `VERIS_API_BASE` | no | non-production Veris control plane |

Sandboxes are created with `egress: 'open'` because an agent needs npm, git and
package registries. The cost is two blind spots the receipt names honestly in
`leaks` — a QUIC or ECH client could reach a real vendor unseen. Vendor
hostnames are still answered by the twin either way.

## Logs and state

```sh
tail -f ~/.local/share/opencode/log/veris-e2b.log
cat ~/.local/share/opencode/storage/veris-e2b/*.json | jq
```

The storage file maps each OpenCode session to its sandbox and branch number, so
sandboxes survive restarting OpenCode.

## Sandbox lifetime

Quitting OpenCode does **not** destroy the sandbox — neither here nor in
Daytona's plugin. A sandbox is killed, and its twin deleted with it, when the
OpenCode *session* is deleted.

What stops an abandoned sandbox billing is the timeout. Daytona's platform
auto-stops after 15 minutes idle; E2B's `timeoutMs` is wall-clock from creation
and has no idle notion, so the plugin supplies one: a 20-minute window pushed
forward (at most once every 5 minutes) whenever a tool runs. Walk away and the
sandbox pauses ~20 minutes later; keep working and it never expires.

It **pauses** rather than dies — `lifecycle: { onTimeout: 'pause' }` — so the
filesystem survives and reconnecting to the session resumes it where you left
off.

## Layout

```
e2b-opencode/                @veris-ai/e2b-opencode
└── .opencode/plugin/e2b/
    ├── core/                session lifecycle, storage, logging, toasts
    ├── git/                 host · sandbox · session — the bundle transport
    ├── tools/               the eleven tools
    └── plugins/             the four OpenCode hooks
```

The SDK is the sibling workspace `../e2b` (`@veris-ai/e2b`). It owns twin
provisioning, egress, the interception CA and teardown, so this package only
ever says create, connect and kill.

## Developing against it

Symlink the plugin into a scratch repo; OpenCode reads the TypeScript sources
directly, so there is no build step between an edit and the next run.

```sh
ln -sfn /path/to/veris-e2b/e2b-opencode/.opencode .opencode
```

> [!IMPORTANT]
> `tsc` emits `.js` and `.d.ts` **beside** the sources (upstream's layout, where
> `.npmignore` strips the `.ts` on publish). OpenCode globs that directory, so
> after a build it discovers three entry points and loads the plugin three
> times. Build only when publishing; `find .opencode/plugin -name '*.js' -o
> -name '*.d.ts' | xargs rm` restores the dev flow.

## Attribution

The session-lifecycle design, the git-sync contract and four utility modules
(`logger`, `toast`, `types`, `project-data-storage`) are adapted from
[`@daytona/opencode`](https://www.npmjs.com/package/@daytona/opencode)
(Apache-2.0, Daytona Platforms Inc.). Copyright notices are retained in each
adapted file.
