<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## Release & CI rules

These two rules govern how multi-repo efforts land. They COMPLEMENT — never replace
— the root workflow rules (`../AGENTS.md` Rules A–E) and CeraUI's testing gate.

**R1 — CI-green gate:** Every commit must pass lint + typecheck + Tier-1 unit tests (DB-free).
`check:tech-debt` runs on **CeraUI only** (ceralive-platform has no such script).
Every PR additionally passes Tier-2 integration tests (live Postgres/Redis) + Playwright e2e +
CeraUI backend tests + `bun run build` (platform). Tier-3 is release/manual only — NOT a PR gate.
A red gate blocks the PR; no skip/weaken of any test.

**R2 — single integration branch → one PR per repo:** All work for an effort lands on ONE
integration branch per repo (e.g. `feat/refined-experience`), stacked as wave-ordered coherent
commits. Exactly ONE PR per repo. Merge order: root policy PR → ceralive-platform → CeraUI.
Rebase onto `origin/<canonical>` between waves (Rule B); conflicts STOP-and-surface.
R2 is a COMPLEMENT to Rule C ("one focused PR per repo"), not an override.

The Build Check E2E topology is intentionally split: `setup-e2e` builds and
uploads the frontend and caches only Playwright browser binaries, while four
isolated runners install their own Playwright OS dependencies: desktop shards
1–3 and mobile shard 1. The matrix `include` row carries each project's `total`
so the functional command and `-of-<total>` blob artifact names remain
project-correct. Browser cache keys use the exact installed Playwright CLI
version, and the four lanes retain unique blob artifacts for the merged report. The
setup job also downloads the published `srtla` 4.1.0 amd64 `.deb`,
verifies its pinned SHA-256 and Debian package metadata, extracts only its runtime
payload, and uploads that payload as a one-day artifact. The backend unit lane
fetches the same pinned package independently — it does not depend on the E2E
setup job — and exports `SRTLA_SEND_BIN` so the live-producer contract test runs
against the real sender instead of skipping. Each E2E lane restores
the executable bit, adds the extracted `usr/bin` to `PATH`, rewrites its local
`setup.json` `srtla_path`, and asserts the real `srtla_send` binary before server
startup. No stub, `sudo` install, sibling checkout, or skipped backend preflight
is permitted. Each functional lane serves the uploaded production bundle with
one `vite preview` process on port 6173, shared by that lane's Playwright workers;
the lane's reference backend on port 3002 supports startup and global setup but
is not the backend used by functional test pages. Under CI preview only,
the E2E fixture installs an HttpOnly SameSite=Strict cookie containing its
validated 3100-3199 worker port and a random per-worker proxy secret. The proxy
consumes and strips that routing value only when the raw request target is the
literal `/ws` or `/preview` path (optionally followed by a query), injects the
secret as a proxy-only backend admission header, and fails
closed on missing/malformed routing state or explicit query/header steering.
Worker backends require the exact header before upgrading in E2E mode, so direct
browser sockets cannot connect through the shared preview to another worker's
backend. This keeps every browser paired with its worker-scoped backend, preview
upstream, and scenario. The CI lane seeds the
reference backend's password and persistent token before server startup, so
Playwright global setup never depends on a missing-cookie fallback through the
preview proxy; local global setup retains its browser-driven flow.
Runtime E2E code must use fixture RPC/socket seams and must not import Vite-only
`/src` modules. Local E2E retains `window.__ceraSocketPort`, which selects the
page's worker-scoped 3100-3199 backend; the reference backend on port 3002 is not
the functional page backend. Local Vite dev does not enable cookie routing. The
semantic YAML contract is
`bun run test:build-check-shape`.

Four further Build Check facts, all landed 2026-08-14:

- **The frontend Vitest lane runs on BUN; the Playwright lanes stay on Node 26**
  (`NODE_VERSION: "26"`, still set at workflow level and still consumed by
  `test-be`, `setup-e2e`, `test-e2e`, `merge-e2e-reports` and `build`). The Vitest
  blocker was `vitest@4.1.10`'s collection failure, not Bun's: at the time of that
  flip, under the then-current `vitest@5.0.0-rc.3` pin, the suite was green at
  **354 files / 5,779 tests — identical to the pre-bump rc.2 baseline** (a HISTORICAL
  figure, kept only because it is what the flip was proven against; the pin is now
  stable `5.0.0` and the suite has since grown — see DEP BASELINE for the current
  count, and never re-copy the figure into this paragraph), so the frontend `test`
  script now invokes `bun --bun vitest run` and `test-fe` carries no `setup-node`
  step at all. **The Playwright half is NOT flipped and has never produced a green
  parity run** — that lane keeps Node 26, and nothing here authorises moving it.
  Two consequences: this was a build-check RUN-STEP change, so the root
  workspace CI manifest set-equality model must be resynced to match; and the
  prerelease `vitest` pin is now load-bearing for a required lane, so bumping it to
  stable 5.0 means re-confirming the same-lockfile parity counts, not just editing
  the version.
- **The former `tsgo-canary` is retired.** TypeScript 7 remains a separately
  owned major-version migration; do not recreate an advisory canary without a
  demonstrated additional signal.
- **`setup-e2e` typechecks and measures before it uploads**: `bun run --filter
  frontend check` gates the build, and `bun scripts/ci/bundle-report.mjs` fails
  the job when the initial-route JS gzip set exceeds its documented budget.
- **The e2e exclusion tag list lives in TWO files** — the root `test:e2e` script
  and the Functional E2E step's `--grep-invert`. Both carry
  `@visual|@a11y|@gallery|@premigration-upgrade`; change one and you must change
  the other (and the workspace manifest legs with it).

Any change to this workflow's jobs or run steps also changes the workspace
manifest — the build-check manifest and execution contract tests model the job set and
per-job run-step digests with SET EQUALITY and fail on anything unmodeled.

### THE FRONTEND VITEST LANE IS SHARDED FOUR WAYS [EXISTS]

`test-fe` was the workflow's critical path — a single ~22-minute vitest job that
also carried five unrelated seconds-long gates. It is now a static four-way shard
matrix plus two sibling jobs, and five properties of that split are load-bearing:

- **`test` is unchanged; the shard scripts are additive.** `test:ci-shard` and
  `test:ci-merge` are CI-only; `bun run --filter frontend test` still runs the
  whole suite plus the preflight locally. Do not "unify" them — a developer running
  the local script must not need a `VITEST_SHARD` in their environment.
- **Both Vitest projects run inside this shape.** `test:ci-shard` uses the same
  `vitest.config.ts` classifier and project-scoped setup files as the local suite;
  no `--project` filter may retire either `pure` or `components`. Every Build Check
  `setup-bun` step must match the root `packageManager` runtime pin, including
  newly introduced shard, guardrail and report jobs. The shape suite checks that
  agreement so a clean textual rebase cannot silently restore an older runtime.
- **Four, not more, and the arithmetic is recorded.** Every added lane re-pays a
  measured fixed cost (checkout + setup-bun + install + `generate:i18n`) of ~7.1 s
  against a ~1,343 s vitest step: 4 × 7.077 s = 28.3 s of overhead against 335.8 s
  of per-shard work, so the fan-out is still overwhelmingly worth it at 4. The rule
  the number came from is `fixed × N ≤ duration ÷ N`; re-run it before changing N,
  and change the manifest legs with it.
- **`include-hidden-files: true` is not boilerplate.** Vitest writes its blob under
  `apps/frontend/.vitest/blob/`, and `upload-artifact` skips dot-directories by
  default — without the opt-in the artifact uploads empty and the merged report
  silently shrinks while every job stays green.
- **Blob uploads are `!cancelled()`, never `always()` and never `success()`.** A
  FAILING shard's blob is precisely what the merged report must carry; gating on
  success would hide the failures the merge exists to show.
- **`guardrails` owns the hardware preflight, and dropping it is silent.** The
  frontend `test` script chains `test:hardware-preflight`; `test:ci-shard`
  deliberately does not, so the only thing keeping that gate in CI is the explicit
  `guardrails` step. `scripts/ci/build-check-contract.mjs` asserts it, along with
  the shard width, the `VITEST_SHARD` spec, both upload flags, the artifact name
  template, and the six-way `test.needs` closure.

