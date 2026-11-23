# Visual PR gate [EXISTS]

Build Check always starts. A separate positive OR paths filter publishes `visual`
and the JSON list `snapshots_files` from the `changes` job. Frontend source, public
assets, E2E specs/fixtures/CSS/PNGs, frontend config, shared i18n/RPC inputs, the
lockfile, manifests, visual scripts and Build Check itself select the visual job.
Backend-only and documentation-only changes leave `visual=false`.
The published visual verdict also requires `code=true`, so a Markdown-only
change inside a frontend source or asset directory keeps the docs-only skip.

`Visual subset (pinned container)` needs `changes` and the existing `setup-e2e`
artifacts. It uses the built frontend and checksum-verified srtla 4.2.0 payload;
it does not rebuild either. The functional E2E exclusion remains unchanged.

`test:e2e:visual:pr` selects these six files under
`apps/frontend/tests/e2e/visual/`: `audio-mixer`, `layout-designer`, `live`,
`network`, `settings` and `signal-indicator`, each ending in `.visual.spec.ts`.
Changed snapshot files additionally select their existing owning spec, including
owners outside this subset. All four configured projects remain selected,
including the two dev projects on port 6174. Existing project exclusions, skips,
masks, assertions and pixel tolerances remain in force. Comparison uses two
workers, zero retries and `--update-snapshots=none`.

The always-running `Test (unit + E2E guardrails)` summary depends on this job.
A failed or cancelled dependency fails the summary regardless of scope. A skipped
visual job is permitted only when `visual=false`; every existing code-job
requirement remains. Invalid or absent scope outputs fail closed.
`bun run test:build-check-shape` exercises frontend, selected/unselected snapshot,
backend and docs scopes and executes the actual summary shell for those verdicts.
The owner must mark **Visual subset (pinned container)** required in branch
protection; the existing summary must remain required. This change does not
modify repository settings.

## Local host and container gates

The file list has one owner: `visualSpecs([])` in `scripts/ci/visual-pr.mjs`.
The hosted selector adds changed snapshot owners to that list.
`bun run test:e2e:visual` sets `E2E_VISUAL_HOST=1`; Playwright's `testIgnore`
derives exact file globs from the same list. It compares every other `@visual`
spec across all configured projects against its host-recorded baselines.
It proves only the host-owned portion. The raw frontend `test:e2e` command
does not apply this environment split.

Run from the repository root on Linux amd64 with Docker, Bun 1.4.5 and Node 26.
The Docker bind mount must be writable as the invoking UID/GID. Ordinary Linux
Engine without user-namespace remapping and Docker Desktop support this setup;
a remapped/rootless daemon must provide equivalent bind-mount permissions.
Prepare the same frontend and checksum/metadata-checked sender artifacts as CI:

```bash
set -euo pipefail
bun install --frozen-lockfile
bun run build:frontend
sender_step="$(bun scripts/ci/visual-container.mjs sender)"
bash -euo pipefail -c "$sender_step"

# Host-owned visual comparisons, with the production preview and reference backend
bash scripts/ci/run-visual-pr.sh \
  bun run test:e2e:visual -- --workers=2 --retries=0 --update-snapshots=none

# Exactly the six container-owned files, in the hosted renderer
bun run test:e2e:visual:container
```

The container wrapper reads its image digest directly from Build Check's
`test-visual.container.image`. It copies the current source and prepared
artifacts into a fresh `node_modules/.cache/visual-container/run.*` directory
(outside Bun's test discovery), mounts the
verified host Bun/Node binaries read-only, and installs the locked dependencies
inside the container. Host dependencies and baselines are not modified.
All workflow extractions are checked assignments; missing, empty or malformed
values fail before Docker starts. The identity body runs with
`bash -euo pipefail`, so an intermediate assertion or pipeline failure aborts.
Source copying omits genuine working-tree deletions while retaining other
filesystem and tar failures, including unreadable files.

The container runs as the invoking UID/GID, including on failure. Its writable
HOME and Bun cache are inside the retained workspace. The host precreates the
Bun bind target so the daemon need not create a root-owned file there.
It executes the workflow's rendering-identity block, then the
existing `run-visual-pr.sh` helper and `test:e2e:visual:pr` with
`CHANGED_SNAPSHOTS=[]`. That selects exactly `visualSpecs([])`, two workers,
zero retries and no snapshot writes. Reports and server logs remain in the
printed copy's `apps/frontend/test-results/` directory.

The hosted job's image user is root (the image declares no user, and the job
does not override it); its bootstrap asserts UID 0 to install only `unzip` for
`setup-bun`. It does not switch users afterward. Local execution mounts an
already installed Bun and therefore needs neither that installer nor unzip;
it installs no system packages and performs no root bootstrap.
Changing UID does not change the image's Chromium, glibc, system fonts or launch
options. Playwright's default Chromium launch disables its sandbox for both
users. The reused identity checks still log the font hash and exact versions,
and the real comparison must pass the unchanged container baselines.
The local user change is explicit; it is not a claim that the hosted UID changed.

Complete local visual coverage requires **both** commands. The six files have
container-recorded baselines; comparing them on the host produces renderer
mismatches. Other files retain host-recorded baselines and are not moved into
the container by this split. When CI additionally selects a changed snapshot
owner outside the six files, its baseline must also match the CI environment;
the host exclusion list still derives only from the six-file owner.

## Rendering environment

The image is
`mcr.microsoft.com/playwright:v1.65.0-noble@sha256:f6fe3cf9a493670b9a20f33597a807262abb25c40c31839ba4ac1dbc51fe7366`.
This is the immutable Linux amd64 manifest, rather than a moving tag. MCR's
`v1.65.0-noble` index resolved on November 16, 2026 to
`sha256:9beb546099e11f52d62e505537914870e01a67e0e6b00ae41da4775324e73dbe`;
its amd64 child is the pinned digest above. Playwright's package comes from
`bun.lock` (1.65.0); its browsers and font/system libraries come from the image.
Node 26 runs Playwright; Bun 1.4.5 runs installation and repository tooling.
CI and recording use headless Chromium, Linux amd64, `--ipc=host --init`,
`CI=true`, `TZ=UTC`, `LANG=C.UTF-8` and `LC_ALL=C.UTF-8`.
The job logs Node, Bun, Playwright, Chromium, glibc and the sorted font-list hash.
The image omits `unzip`, which `setup-bun` needs, so the first step installs only
that package as the image's root user. It fails if any other package is added,
upgraded or removed, and it trusts only the checkout through `safe.directory`.
No browser is installed: `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` selects the
image's browsers, and the identity step fails unless Chromium launches from
there. The runner sets `HOME=/github/home`; the identity step also requires Bun
at `$HOME/.bun/bin` and its install cache at the `~/.bun/install/cache` path the
cache step saves.
Playwright's output directory is `test-results/visual-pr`, keeping its startup
cleanup away from the server logs and JSON/blob reports beside it.

The image is pulled by the Actions container lifecycle before the first step.
There is no image-presence guard: a cold runner follows the same digest pull.
Only the Bun dependency store is cached, separately from ordinary Ubuntu jobs.
No host image deletion is needed to establish that path. A cold pull's time
belongs to the hosted job's real elapsed time.

## Measured hosted timing

Build Check run [44001423704](https://github.com/CERALIVE/CeraUI/actions/runs/44001423704)
on #636 measured 115 s for the visual job, about 1.92 runner-minutes:
container start 28 s, bootstrap 6 s and comparison 50 s. It selected 34 cases
on 2 workers: 25 passed, 9 existing skips and 0 failed. The Bun cache missed
on this first run. The job finished 5 min 14 s before the slowest E2E lane,
so it added no wall time to that run.

## Recording and image bumps

Use a disposable checkout and the exact image above, on Linux amd64 with the same
container options and environment. Install Bun 1.4.5 and Node 26, then:

```bash
bun install --frozen-lockfile
bun run build:frontend
# Prepare dist/ci-runtime with the exact checksum/metadata-checked srtla payload
# from Build Check's "Prepare pinned srtla-send runtime" step.
CHANGED_SNAPSHOTS='[]' bash scripts/ci/run-visual-pr.sh \
  bun scripts/ci/visual-pr.mjs --grep @visual --workers=2 --retries=0 \
  --update-snapshots=all --output=test-results/visual-pr --reporter=line,json,blob
```

The helper activates the real sender, generates catalogs, seeds auth and starts
the preview/reference backend with CI enabled before startup. Playwright owns the
separate dev server. Keep networking online; do not record in an offline network
namespace. Record once, then review every changed old/new PNG. Embed before/after
images at the top of the PR body. Do not refresh unrelated snapshots or change
tolerances to absorb a rendering difference. Compare on the exact PR head in CI;
retain JSON/blob reports, actual/diff screenshots, traces and server logs.
The showcase page object reuses its caller's authenticated page; a second full
dev reload would spend the same per-test startup budget twice. The live
audio-mixer capture frames its card from the viewport top: the idle-to-live swap
leaves a timing-dependent scroll offset that otherwise moves the sticky header
across the card.

For a future bump, update the Playwright lockfile resolution first, choose its
matching official noble image, and resolve it directly from the registry:

```bash
docker buildx imagetools inspect mcr.microsoft.com/playwright:v<VERSION>-noble
docker buildx imagetools inspect --raw mcr.microsoft.com/playwright:v<VERSION>-noble
```

Select the `linux/amd64` child digest from the returned index, inspect that
manifest/config, and update the workflow and this document together. Record the
same subset once in that new digest, review the PNG migration and exact-head
hosted comparison, and report the actual job wall time and added runner minutes.
Do not dispatch a workflow, auto-accept CI screenshots, publish an image or remove
shared images as part of this process.

The subset leaves unchanged visual surfaces outside these six files untested.
A pinned container controls the renderer and fonts; it does not eliminate host
timing or application readiness races. Local recording time is not hosted CI time.
