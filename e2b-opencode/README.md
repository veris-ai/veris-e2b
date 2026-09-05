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

- **`verisReceipt`** — a bounded request log from the twin, used with per-run
  baselines and application assertions.
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

Receipts include earlier work and control traffic, so compare a baseline with
subsequent evidence from the application's own flow. The full view displays at
most 20 entries per HTTP service; the service-only view displays at most 50 and
omits the twin id. At zero total traffic the full view gives the id and service
count, but no service names. Check a code-inferred service with the `service`
argument, or use host service metadata; there is no `verisTwin`/manual tool or
automatically registered MCP in this plugin. Keep response/state assertions and
report insufficient current-run attribution when complete traces are unavailable.

## Where the agent runs, and why that matters

The reasoning loop, the model calls and your context stay **on your machine**.
Only the tools reach into the sandbox.

That is not an implementation detail. It means the sandbox never holds your
model provider key, and its egress never has to be widened to reach
`api.anthropic.com`. This plugin currently requests open egress; the network
limits below still apply.

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
service or git credential needed inside the sandbox. The host authenticates
the file transport with its E2B credentials.

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

The plugin requests `egress: 'open'` for package registries and leaves the SDK's
mode at `auto`: gateway interception when available, otherwise the SDK-managed
in-sandbox proxy fallback. Keep the actual receipt mode: fallback reports
`proxy-mode-unverified`, while gateway integrity checks a canary route. Neither
establishes exclusive twin access. Open egress allows other destinations, and the
reported `udp-quic-possible` / `ech-possible` blind spots mean some vendor traffic
could bypass interception. Preserve the active mode's trust and network settings.

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

The plugin requests a 20-minute window and attempts to refresh it when a tool
runs, at most once every 5 minutes. Refresh is best effort; it is not a guarantee
that a long-running command or an active session will never expire. E2B timeout
is wall-clock, so a background command needs subsequent tool activity to refresh
the window. Daytona's idle/stop/delete settings are separate provider settings.

The requested timeout behavior is pause with auto-resume, preserving the remote
filesystem. Reconnect also checks the attached twin: if its TTL expired, the SDK
reports `TwinExpiredError` rather than silently attaching a replacement. Persisted
files do not make old twin measurements current. Deleting a session attempts to
sync pending changes first; a failed sync can preserve the sandbox for recovery.

## Adding Veris's skills

[Plugins PR #49](https://github.com/veris-ai/plugins/pull/49) adds the shared
setup/build/fix workflow to these sessions. Its package is
`@veris-ai/veris-opencode`, built from canonical
[veris/skills](https://github.com/veris-ai/plugins/tree/main/veris/skills).
As checked on 2026-09-04, the name is not yet published; after its first release:

```json
{
  "plugin": [
    "@veris-ai/e2b-opencode@latest",
    "@veris-ai/veris-opencode@latest"
  ]
}
```

Use `/veris:setup`, `/veris:build <request>` and `/veris:fix <request>` with this
plugin-owned twin. The skills discover available control interfaces rather than
assuming Daytona's tools or MCP are present. They retain evidence gates and leave
session cleanup to the provider. Replace any old `@veris-ai/veris-sim-opencode`
entry, restart OpenCode, and record resolved versions. Select only one sandbox
provider and one skills package; ignored evidence needs an explicit host handoff.

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
