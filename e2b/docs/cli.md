# Hosted application tests with `veris-e2b`

The CLI manages a separate E2B box on an **existing Veris twin**. The controlling
machine runs `veris up`, seeds the twin, reads its trace and data, and eventually
runs `veris down`. The box runs the application's install and tests. These four
verbs do not configure OpenCode or adopt/delete session-owned sandboxes.

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
all four commands before creating resources:

```sh
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

## Run

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
   There is no remote-clone flag; upload avoids git-host routing and credentials.

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
   Require application `handler` or `fault` entries from this flow and the expected
   response/state. Provisioning probes, `control` operations and cumulative SDK
   receipts cannot establish that the application ran. `exec` returns the actual
   command status, 124 on timeout, 130/143 on interruption; it does not produce a
   `veris run` receipt or `--require-service` verdict. Save evidence after failures
   as well as successes.
7. Restore any task callback destination, save the evidence, then delete the box:
   ```sh
   veris-e2b teardown <e2bSandboxId>
   veris down
   ```
   Teardown requires only the E2B key and works after the twin expires. It deletes
   only a box marked as owned by this CLI; SDK/OpenCode-owned boxes are refused.
   An absent E2B box succeeds. The task retains responsibility for its twin, and
   `veris down` does not delete an E2B box. Explicitly clean up failures and
   cancellations; the E2B lifetime is the backstop for an abandoned box.

## Network differences and limitations

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
- Callbacks need `provision --allow-public-traffic`, which sets
  `network.allowPublicTraffic`. They are not registered by these four commands.
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
