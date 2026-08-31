# Contributing

```sh
npm install      # workspaces link @veris-ai/e2b into the plugin
npm run build    # must come first -- see below
npm run typecheck
npm test         # unit tests for both packages, no credentials needed
```

`build` before `typecheck`, on a clean clone, is not a style preference.
`e2b/dist/` is gitignored and `@veris-ai/e2b`'s `types` points into it, so until
the SDK is built the workspace link resolves to a package with no type
declarations -- and the plugin's `tsc` reports that as an error on every
`import … from '@veris-ai/e2b'`. The order in CI is the same, for the same
reason.

## Live verification

`npm run test:live` runs the SDK against a real E2B sandbox and a real Veris
twin -- it creates the sandbox, calls a vendor hostname, reads the receipt, and
cleans up after itself:

```sh
export E2B_API_KEY=… VERIS_API_KEY=… VERIS_ENVIRONMENT_ID=…
npm run test:live
```

It costs money and it deletes what it creates, including on failure. A leaked
twin bills silently, so if you change the cleanup path, check it.

`VERIS_E2E=gateway npm run test:live` is also the acceptance gate for gateway
mode, and it runs in the direction people get backwards. The control plane
version-gates gateway on the `X-Veris-SDK` header (`e2b/src/version.ts`, injected
from `package.json` at build time) and answers a too-old SDK with a 409
`sdk_too_old` carrying `min_sdk` -- but `min_sdk` is *set from* whichever SDK
version first passes this suite against real infra. It is not a constraint the
version has to clear; a release does not bend its number to fit the gate, it
passes the suite and the gate moves.

What the suite protects against is the silent half. It forces `mode: 'gateway'`,
so a refusal surfaces as `VerisGatewayNotOfferedError`. Under the default
`mode: 'auto'` the same refusal is not an error at all -- it falls back to the
in-sandbox proxy -- so an SDK below `min_sdk` degrades quietly and no unit test
notices. Run the gateway suite after any change to the version number, and move
`min_sdk` with it.

## Layout

| directory | package |
|---|---|
| `e2b/` | `@veris-ai/e2b` — the SDK, a drop-in `Sandbox` subclass |
| `e2b-opencode/` | `@veris-ai/e2b-opencode` — the OpenCode plugin |

The root package is private and publishes nothing; both packages are siblings so
npm links them. Do not move either to the repo root -- npm links sibling
workspaces, never the root, and the plugin would stop resolving the SDK.

The plugin ships its compiled output from `.opencode/plugin/`, which is where
OpenCode also installs a local runtime (`.opencode/node_modules/`) when you
develop against it. That directory must never reach the tarball: `files` in
`e2b-opencode/package.json` names `.opencode/plugin` specifically, and the
release workflow fails the build if `node_modules` appears in the pack or the
tarball crosses 1 MB.

`@opencode-ai/plugin` is a devDependency, not a runtime one: every import of it
is an `import type`, and OpenCode injects the real API at runtime. Shipping it as
a runtime dependency would force a second, stale copy of the OpenCode SDK on
every consumer. It is *also* an optional `peerDependency` at `>=1.18`, which is
the only thing in the manifest that says which host versions this plugin works
against -- OpenCode has no `engines`-style field to declare it with. The peer
range is documentation; nothing enforces it at install time, so move it when the
plugin starts relying on a newer host API.

## Releasing

Both packages version together, and the plugin depends on an exact-minor range
of the SDK, so bumping one without the other publishes a plugin that resolves an
SDK it was never built against. `version:set` does both halves:

```sh
npm run version:set 0.2.0     # both package.json files, and the cross-dependency
# update CHANGELOG.md
git commit -am "chore: 0.2.0"  # PR, merge
```

Then: **Actions → release → Run workflow**. It re-derives the version from
`e2b/package.json`, decides which packages still need publishing, builds, packs
and inspects both tarballs, publishes to npm in dependency order, checks that
each publish came back with a provenance attestation, then tags `v0.2.0` and
creates the GitHub release. `dry_run: true` does everything except the two
publishes, the attestation check and the release.

There is deliberately no local publish path. The workflow is the only way either
package reaches npm, which is what makes the provenance attestation on every
published version mean something.

### Re-running a failed release

Press the button again. Every step that changes something off-machine checks
first whether it has already happened: a package already on npm at that version
is skipped, an existing tag is not re-created, an existing GitHub release is left
alone. So the bad case -- the SDK publishes and the plugin then fails -- is
recovered by re-running, not by publishing the plugin by hand.

That includes a run that published both packages and then failed on a later step
— it will skip both publishes and go on to create the tag and release the first
attempt never got to. The only thing the workflow refuses outright is a version
that is *fully* released: both packages on npm, and the tag and its GitHub
release already there. That one means someone forgot to bump.

Build, typecheck, test and the pack assertions re-run unconditionally, so a retry
re-proves the artifacts rather than trusting the first attempt's.

One thing to expect rather than worry about: npm ingests a publish
asynchronously, and `npm publish` will tell you so — *"Your package is being
processed and may take a few minutes to become available."* During that window
`npm view` returns a 404 for a version that published perfectly well. The
provenance check polls for up to five minutes for exactly this reason, and
distinguishes "not ingested yet" from "ingested without an attestation". Do not
replace it with a single assertion; that is what broke the `0.1.1` release.

### Prereleases

`version:set` accepts them (`npm run version:set 0.2.0-rc.1`) and the workflow
derives the npm dist-tag from the version: `0.2.0` publishes to `latest`,
`0.2.0-rc.1` to `rc`, `0.2.0-alpha.3` to `alpha`. This is not a nicety -- npm 11
refuses to publish a prerelease without an explicit `--tag` rather than silently
putting it on `latest`, so a bare publish of an rc simply fails.

Use a prerelease identifier that starts with a letter. npm rejects a dist-tag
that parses as a semver range, so `0.2.0-0` derives the tag `0` and the workflow
stops at the resolve step rather than after the build. The `dist_tag` input
overrides the derivation when you need something else -- publishing a backport
under `legacy`, say, without moving `latest`.

Publishing is npm **trusted publishing** (OIDC) -- no token, no secret. It is
configured per package on npmjs.com under Settings → Trusted Publisher, pinned to
this repo and to the workflow filename `release.yml`. Renaming that file breaks
publishing for both packages, silently, until the npm-side config is updated.

Both packages are scoped, so both carry `publishConfig.access: public` -- without
it `npm publish` refuses outright.

Pre-1.0 the caret does the lockstep enforcement for free: `^0.1.0` resolves
`>=0.1.0 <0.2.0`, so the plugin cannot float onto an SDK minor it was never built
against. At `1.0.0` that stops being true, and `scripts/version.mjs` refuses to
write a 1.x version until it is changed to emit an exact pin instead.

## Conventions

- [Conventional Commits](https://www.conventionalcommits.org/) for commit
  subjects (`feat:`, `fix:`, `chore:`, `docs:`).
- [Semantic Versioning](https://semver.org/). Both packages version together.
- Comments explain *why*, not *what*. Several decisions in this repo look wrong
  until you know the constraint behind them. If you change one, change its
  reason.
