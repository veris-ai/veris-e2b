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

Remote `bash`, `read`, `write`, `edit`, `multiedit`, `ls`, `glob`, `grep`,
`getPreviewURL`, and `gitSync`, plus the session tools below.

**`verisTwin`** returns JSON with `provider`, `sessionId`, execution `sandboxId`,
`twinId`, `environmentId`, `workingDirectory`, `lifecycleOwner`, `twinOwnership`,
service routes/control URLs and available capabilities. It lists services even
when the request log is empty. Pass `service` to read its manual. Verify remote
`pwd` and `git rev-parse HEAD`; a stored path does not prove source sync succeeded.

**`verisReceipt`** has two actions:

1. Finish seeding/probes and background work. Call `{"action":"baseline"}` before
   the isolated application test. Save the returned opaque `baseline` token.
2. Run and await that application command through `bash`, preserving TLS/network
   settings and recording its command, exit status and response/state assertions.
3. Call `{"action":"read","baseline":"<returned-token>","service":"stripe"}`.
   Omit `service` for all HTTP control services. Twin, sandbox and OpenCode session
   identity, interception mode, integrity and blind spots remain in every result.

Without a token the result is explicitly `scope: "cumulative"`, not current-run
proof. Baselines pin per-service request IDs and a unique read-only schema request
in the trace; reset, removed history, changed service coordinates or replacement
sessions invalidate them. A restart or eviction of an old token requires a new
baseline **before** rerunning the test. Services must retain control request headers;
an unsupported trace format fails baseline capture rather than pretending it is empty.

The SDK paginates up to 20 pages of 1,000 rows, within a newest-ID snapshot. It
filters control/reserved paths and explicitly marked probe tiers. A complete
zero means no application entries were observed in that window. Failed reads
throw; page budgets, stalled pagination and failures after partial progress set
`complete: false`, `countKind: "at-least"` and `incompleteReason`. Never subtract
two cumulative counts. The display includes at most 50 entries per service and
reports `omittedEntries`; this is separate from an incomplete underlying read.
Use `verisControl` requests with the returned `sinceId`/`untilId` window for raw
trace bodies, advancing `since_id` and filtering beyond `untilId` yourself.

An unmarked request to a vendor API made by a diagnostic probe looks like an
application call. Isolate the measurement; concurrent runs cannot be automatically
attributed. Bodies may be redacted/truncated and missing trace rows cannot be
recovered by the reader. Receipts remain observations, not tamper-proof execution
attestations; retain response/state assertions and reported blind spots.

**`verisControl`** provides host-side access to the attached service's `manual`,
`schema`, `operations`, `data` and `requests`. Pass `service` and `resource`;
`method` defaults to `GET`. Inspect schema/manual first, then read data with
`query: {"entity_type":"<table>","limit":"50","offset":"0"}`. Seed rows or
configure schema-defined faults with `POST`/`PATCH` `data` and
`body: {"data":{"<table>":[<rows>]}}`; read back the result. Raw data/request
responses are pages, not inferred totals. Service support is checked by its
response, and unsupported operations fail explicitly.

Writes request the `verisControlWrite` permission (default `ask`). User permissions,
including blanket/wildcard rules, win. The tool accepts no credentials, arbitrary
control URLs, reset, promotion, creation or deletion. The host resolves the service
from this session's twin, so neither credentials nor control endpoints need to be
guessed. File-byte transfer is outside this small control interface; a workflow
requiring it must use an available provider file interface or report the missing
capability. Canonical workflow content stays in `veris-ai/plugins`.

## MCP and permissions

The plugin registers host MCP `veris` at the configured Veris API base's `/mcp`
when `VERIS_API_KEY` is present, using header authentication with OAuth disabled.
Existing MCP configuration is preserved. Lifecycle defaults match Daytona:
`veris_create_sandbox`/`veris_delete_sandbox` deny, and
`veris_reset_sandbox`/`veris_promote_sandbox` ask. Skills reuse the plugin's twin;
these controls do not give skills permission to provision another session.

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

## TLS

Gateway mode installs the gateway CA and provides system-bundle trust variables
plus `NODE_EXTRA_CA_CERTS`; proxy fallback supplies its own trust environment.
The command wrapper reapplies the active defaults. Preserve them and diagnose
certificate failures without disabling verification. SDKs using a pinned private
CA bundle may need their supported trust configuration; no universal fix is claimed.

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

Release prerequisites: this provider SDK/plugin pair **0.2.0**, and the first
published **@veris-ai/veris-opencode 0.7.3** from plugins PR #49. The composition
is tested using packed release candidates; these versions are not published by
this PR. Use the configuration after those npm releases exist. Resolve npm
versions once and pin the installed semantic versions for replay; do not use a
Git checkout/build installation fallback. PR #49's provider reference must also
reflect the new baseline/control capability contract before release.

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
plugin-owned twin. The skills discover `verisTwin`, `verisReceipt` and `verisControl` capabilities
on the current session; MCP configuration preserves existing user choices. They retain evidence gates and leave
session cleanup to the provider. Replace any old `@veris-ai/veris-sim-opencode`
entry, restart OpenCode, and record resolved versions. Select only one sandbox
provider and one skills package; ignored evidence needs an explicit host handoff.

## Layout

```
e2b-opencode/                @veris-ai/e2b-opencode
└── .opencode/plugin/e2b/
    ├── core/                session lifecycle, storage, logging, toasts
    ├── git/                 host · sandbox · session — the bundle transport
    ├── tools/               remote application and session tools
    └── plugins/             OpenCode hooks
```

The SDK is the sibling workspace `../e2b` (`@veris-ai/e2b`). It owns twin
provisioning, egress, the interception CA and teardown, while this package binds tools to the current OpenCode session.

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
