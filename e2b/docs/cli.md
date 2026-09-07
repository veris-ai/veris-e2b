# Hosted application tests with `veris-e2b`

The CLI ships **inside `@veris-ai/e2b`**, like `veris-daytona` inside
`@veris-ai/daytona`. It manages a separate E2B box for application tests with
the same five verbs: `run`, `provision`, `push`, `exec`, and `teardown`.
Use the task's **existing Veris twin** with `--sandbox`; `run --environment`
can also create a twin when the task needs a new one. The controlling machine
seeds the twin and inspects its data. These commands do not configure OpenCode
or adopt/delete session-owned sandboxes.

## Install a published release

Use Node 20 or newer. Reuse the concrete version already recorded for the task;
on first setup, resolve latest once:

```sh
npm view @veris-ai/e2b@latest version
# Substitute the returned concrete version for <version> below.
npm view @veris-ai/e2b@<version> version bin --json
```

**The CLI is unreleased; npm 0.1.1 has no `bin` or executable.** A new published
release exporting `veris-e2b` is a prerequisite. Do not use a source build as the
application-test installation workaround. Once that release is available, verify
all five commands before creating resources:

```sh
npx --yes --package=@veris-ai/e2b@<version> veris-e2b run --help
npx --yes --package=@veris-ai/e2b@<version> veris-e2b provision --help
npx --yes --package=@veris-ai/e2b@<version> veris-e2b push --help
npx --yes --package=@veris-ai/e2b@<version> veris-e2b exec --help
npx --yes --package=@veris-ai/e2b@<version> veris-e2b teardown --help
```

Record that version and the expanded invocations in the project's run notes;
reuse it for the whole task. The steps below abbreviate the verified invocation
to `veris-e2b`. `npx` does not require a global install. Provision's returned
commands include the concrete package version it is running.

## Prerequisites

- `E2B_API_KEY` for the right team, authorized to create, access and kill boxes
  and use the selected template. Get it from the [E2B dashboard](https://e2b.dev/dashboard).
- Veris credentials on the same plane as the task twin: the CLI reads
  `VERIS_API_KEY`, or the selected profile in `~/.veris/twin.yaml` saved by
  `veris login`. `VERIS_PROFILE` selects a profile, then `active_profile`, then
  `default`. `VERIS_API_BASE` overrides that profile's `api_base`; the final
  default is `https://svc.api.veris.ai`. It does not read a project's `profile:`
  setting: export `VERIS_PROFILE` for both CLIs when needed. Neither control key
  is uploaded or injected into the workload.
- A healthy Veris gateway offering egress credentials for this SDK version, and
  E2B Cloud or a deployment supporting `network.egressProxy`. `veris doctor`
  must show configured gateway mode. This workflow forces gateway mode and strict
  egress; it cannot fall back to an in-box proxy while attaching to this twin.
- An accessible **E2B template name or ID**, containing the app's runtime,
  a POSIX shell, `curl`, `tar`, `ca-certificates` / `update-ca-certificates` and
  root for CA installation. `--template` defaults to `base`; inspect its actual
  runtime version rather than assuming one. A Docker image tag, local image or
  Daytona snapshot is not an E2B template. Prepare a suitable template separately
  when needed. Local `push` also requires `tar` on the controlling machine.
  `--repo` requires remote `git`. `run` additionally needs trace endpoints with
  numeric IDs, tiers, `limit`, `order`, and `since_id`; missing or malformed
  capabilities fail the run and require a compatible published twin release.

## One-command run

From the application's directory, attach to the task twin and run:

```sh
veris-e2b run --sandbox <twin-id> --template <template-id> \
  --allow-out registry.npmjs.org --setup 'npm ci' \
  --require-service stripe --timeout 600 --lifetime 1800 -- npm test
```

This uploads current source, runs setup, refreshes system trust, patches known
bundled CAs, records each service's trace watermark, executes the application,
and prints new application traffic. The box is deleted afterward; the attached
twin stays with the task. Repeat `--require-service` for every dependency the
test must touch. Without it, at least one service must show new traffic.
Check the application's expected response and state as well: a receipt proves
traffic reached the twin, not that every business assertion is correct.

`--source <directory>` uploads a different local tree. To use a remote repository:

```sh
veris-e2b run --sandbox <twin-id> --template <template-id> \
  --repo https://github.com/your-org/your-app.git --ref main \
  --allow-out github.com --allow-out registry.npmjs.org \
  --setup 'npm ci' --require-service stripe -- npm test
```

Replace the example repository with the application's repository. Cloning uses
the supported E2B `commands.run` interface and remote `git clone --depth 1`;
`--ref` accepts a branch or tag, not an arbitrary commit SHA. No submodules or
Git LFS objects are downloaded. `GITHUB_TOKEN` (then `GH_TOKEN`) can authenticate
an exact `https://github.com` URL. A temporary askpass script reads the token
from the clone process environment; it contains no token and is removed afterward.
The token is never embedded in argv or saved in the origin URL. It is available
inside the sandbox during cloning, so use task-scoped repository access.
Other HTTPS hosts are public-only; inline credentials, nonstandard ports and
redirects are refused. If routing to the Git host is unavailable, use local upload.

`--timeout` limits each setup/main command (default 1800 seconds). `--lifetime`
sets the **total** E2B lifetime from creation (default 3600 seconds), subject to
plan limits; budget time for upload, installation, tests and receipt collection.
It does not extend an attached twin. `--env KEY=VALUE` applies to setup and tests;
explicit command values override managed trust/DSNs. The bundled CA patch uses
the same environment. These are the same execution semantics as `exec` below.

For a task that needs a new twin, replace `--sandbox <twin-id>` with
`--environment <environment-id>` (or set `VERIS_ENVIRONMENT_ID`). These two flags
are exclusive; ambient `VERIS_ENVIRONMENT_ID` is ignored when attaching.
`run` owns the twin it creates and deletes **both resources** afterward, including
after an application/setup failure. An owned twin's initial TTL is the E2B
lifetime plus ten minutes, with a ten-minute minimum. There is no automatic
extension during the run. Failed twin provisioning also attempts cleanup and
reports its ID if deletion fails.

`--keep` retains resources after success or failure for inspection and prints
both IDs and a version-pinned `teardown` command. Lifetimes still apply. Teardown
deletes only resources owned by this CLI; an owned twin requires the original
Veris credentials/profile, while an attached twin is preserved. Both deletions
are attempted even if one fails. If E2B has already expired, its metadata cannot
identify the owned twin; remove that twin separately using the recorded ID and
environment, or let its TTL expire.

The receipt excludes setup and older traffic by taking marks immediately before
the application. It counts only new application rows -- `handler`, `fault` and the `fallback`
tiers -- and never `control`, reserved `/veris/*` paths, callback delivery or
canary activity, and prints their IDs/methods/paths/statuses.
It verifies the gateway canary again before reading. Trace reads page forward
in batches of 1000, up to 20 pages per service; reaching that budget prints
counts as **at least N**. A positive observed count can satisfy the traffic gate;
read remaining pages separately for a complete audit. Keep the twin free of other
workloads during the measured flow: watermarks cannot distinguish concurrent
callers, and trace evidence alone cannot prove which caller made a request.

A failed test keeps its exit status even if the receipt also fails. A passing
command exits 1 when required traffic is missing, the trace/integrity cannot be
verified, or cleanup fails. Setup failure skips the application. SIGINT/SIGTERM
during an active command stop its handle; signals during other stages wait for
that stage to return and then proceed to cleanup. SIGKILL or a host crash relies
on the E2B/twin lifetime backstops. Save stdout/stderr as task evidence; use
`--keep` if you need to inspect an owned twin's data before deleting it.

## Step-by-step workflow

1. Start or reuse the task's twin with `veris up`; take its ID from `veris status`
   or `.veris/twin.local.yaml`'s `sandbox.id`. Check its service credentials and
   lifetime. Provision attaches to that ID and ignores `VERIS_ENVIRONMENT_ID`.
2. Create the box, choosing runtime and download hosts before any installation:
   ```sh
   veris-e2b provision --sandbox <twin-id> --template <template-id> \
     --allow-out registry.npmjs.org --timeout 1800
   ```
   `--timeout` is the box's lifetime in seconds, subject to the E2B plan. It does
   not extend the twin. `--workdir <absolute-path>` changes the default
   `/home/user/veris-run`; select a writable path for your template. `--env
   KEY=VALUE` sets persistent application variables, with Veris-managed trust
   and data-plane values taking precedence.

   Stdout is one JSON object; progress goes to stderr. Save `e2bSandboxId` and
   confirm `verisSandboxId` is this task's twin. The object includes `ownsTwin:
   false`, `workDir`, `services`, the E2B `expiresAt`, CA trust paths, and commands
   for upload, execution, certificate patching and deletion. Keep it out of git.
   Successful provisioning proves its canary reached the twin, not that the
   application did.
3. From the application directory, upload current code:
   ```sh
   veris-e2b push <e2bSandboxId>
   ```
   `--source <directory>` chooses another local directory. The fixed exclusions
   printed by `push --help` omit `.git`, dependencies/build outputs, `.veris`,
   `.veris-e2b`, `.env` and `.env.*` at every level. This is not `.gitignore`:
   review other untracked files and deliberately include only the app's required
   twin credential files. Local symlinks and executable bits are preserved.
   Alternatively, `push <e2bSandboxId> --repo <https-url> --ref <branch-or-tag>`
   uses the same clone behavior as `run`. The work directory must be empty;
   cloning into a previous upload/checkout fails without removing its files.

   Re-upload after editing locally. Matching files are overwritten, but removed
   local files remain remotely; use a fresh box after removals or renames. The
   archive is held in memory, capped at 1 GiB compressed. Large/native dependency
   trees belong in the template or the install step.
4. Install dependencies and patch any installed SDK certificate bundles:
   ```sh
   veris-e2b exec <e2bSandboxId> -- npm ci
   veris-e2b exec <e2bSandboxId> -- sh /tmp/veris-patch-bundled-cas.sh
   ```
   Replace `npm ci` with the project's actual install command and use the
   `patchBundledCasCommand` in the provision JSON. Creation installs the gateway
   CA **before** downloads. Every `exec` refreshes system/JVM/NSS trust and applies
   the trust/data-plane environment. The patch script then appends the CA to
   recognized writable pip/certifi, botocore, Stripe and httplib2 bundles, once
   per bundle. It reports unwritable matching files as a failure. For other pinned
   bundles, use the client's supported trust option or explicitly prepare its
   actual bundle; do not disable TLS verification.
5. On the controlling machine, in the project root, record a trace watermark for
   each required service immediately before the application flow:
   ```sh
   veris sandbox trace --service <service> --limit 1 --json
   ```
   A successful empty result means watermark 0. Resolve failed reads first.
   Then run the actual application test command:
   ```sh
   veris-e2b exec <e2bSandboxId> --timeout 600 -- npm test
   ```
   Arguments after `--` stay literal, including spaces and command flags. Use
   `-- sh -c 'export KEYS_DIR="$PWD/test-keys"; npm test'` for shell expansion.
   `--cwd` selects another remote directory and repeatable `--env KEY=VALUE`
   overrides variables for that command. Explicit overrides win over trust and
   DSNs, so do not point them at local certificate files or real data planes.
   Shell exports from one execution do not persist into the next.
6. Read the trace and tested outcome from the controlling machine:
   ```sh
   veris sandbox trace --service <service> --since <watermark>
   veris sandbox data get <service> <table>
   ```
   Require application entries (`handler`, `fault` or a `fallback` tier) from this
   flow and the expected response/state. Provisioning probes, `control` operations and cumulative SDK
   receipts cannot establish that the application ran. `exec` returns the actual
   command status, 124 on timeout, 130/143 on interruption; it does not produce a
   `veris-e2b run` receipt or `--require-service` verdict. Save evidence after failures
   as well as successes.
7. Restore any task callback destination, save the evidence, then delete the box:
   ```sh
   veris-e2b teardown <e2bSandboxId>
   veris down
   ```
   Teardown requires only the E2B key and works after the twin expires. It deletes
   only the attached-twin box marked as owned by this CLI; SDK/OpenCode-owned boxes are refused.
   An absent E2B box succeeds. The task retains responsibility for its twin, and
   `veris down` does not delete an E2B box. Explicitly clean up failures and
   cancellations; the E2B lifetime is the backstop for an abandoned box.

## Network differences and limitations

| Daytona CLI capability | E2B CLI behavior |
| --- | --- |
| `run`, `provision`, `push`, `exec`, `teardown` | Same workflow verbs, packaged in the SDK with an `npx` executable |
| Local upload or `--repo` / `--ref` | Tar/files API upload, or shallow HTTPS clone through `commands.run` |
| `--setup`, `--require-service`, `--keep` | Setup, fresh traffic gate, retained resources with ownership-aware teardown |
| Image / snapshot selection | `--template` chooses an existing E2B template |
| Download/network allowances | E2B strict gateway rules; explicit download hosts, no default registries |
| Sandbox lifetime | E2B `--lifetime` for `run`; `provision --timeout`; attached twin TTL is independent |

- Strict egress allows the twin's vendor routes, canary, non-HTTP data-plane hosts
  and explicit `--allow-out` entries. It has no default package registries and no
  Daytona 20-domain trimming. The E2B deployment still enforces its own limits.
  npm commonly needs `registry.npmjs.org`; pip needs `pypi.org` and
  `files.pythonhosted.org`. Add lockfile URLs, redirect/CDN hosts and runtime/native
  postinstall downloads explicitly. Verify the actual install: an allowance does
  not prove the shared Veris gateway forwards that host correctly. Use upload or
  preinstalled templates when GitHub/download routing is unavailable.
- Non-HTTP service DSNs are allowed and injected through the twin's `env_hint`
  values (e.g. `DATABASE_URL`). Verify a real application query and its state;
  fetching a DSN does not establish a working data-plane connection. Local
  databases and processes do not move with the upload.
- The CLI only exposes strict gateway egress. The SDK's open egress, raw network
  updates and proxy fallback have different guarantees. Change the create-time
  allowlist and recreate the box when install requirements change. HTTP/2 and
  WebSockets to mocked hosts remain unsupported by the gateway; QUIC/ECH and
  broad CIDR passthrough require the care described in the [SDK reference](reference.md).
- Callbacks need `provision --allow-public-traffic` (or the same flag on `run`),
  which sets `network.allowPublicTraffic`. They are not registered by these commands.
  Start a receiver listening on `0.0.0.0`, then use the supported SDK's
  `sbx.veris.deliverTo(portOrUrl)` with explicit/environment Veris credentials.
  Record and restore the attached twin's previous destination; it is shared
  across services. The SDK updates it before probing and requires only one
  answering service; verify the required delivery traces and application handling.
  Unregister a task-owned destination with `deliverTo(null)` before teardown,
  including after a failed probe. No callback URL is injected into the app by the CLI.
- A command timeout is separate from the box and twin lifetimes. Timeouts and
  interruptions kill an established command handle; a transport failure before
  a handle is returned may leave a remote command running. Teardown ends the
  task's box in that case. This CLI does not pause/resume sessions or extend the
  twin's TTL. Record the actual expiry, template/runtime, commands, version and
  trace evidence in the task notes.

CLI packaging, argument handling and simulated provider/control-plane tests can
run without keys. They are not a live smoke: report **live execution was not
tested** unless an actual application request and its twin trace were observed.
