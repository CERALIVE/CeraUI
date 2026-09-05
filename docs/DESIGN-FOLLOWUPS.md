# CeraUI Design Follow-ups

**Status:** `[EXISTS]`

Deferred **design** findings from the `ceraui-experience-stability` Wave-3 UI pass
(todos 24–29). Opened by todo 29 (C4 consolidation).

## Why this file and not `docs/TECHNICAL_DEBT.md`

[`docs/CONVENTIONS.md`](CONVENTIONS.md) → Technical-Debt Register defines that ledger
as **marker-bound**: an entry exists to back a shipped source marker
(`data-debt-id="TD-NNN"`, a `coming-soon` affordance, or an in-source `[PARTIAL]`),
and [`scripts/check-tech-debt.mjs`](../scripts/check-tech-debt.mjs) additionally
requires `exit_criteria` to be executable — a backticked command, `capability:…`,
or `PR #…`, **never prose** (`isExecutableExitCriteria`, `check-tech-debt.mjs:69-76`).

None of the findings below ships a source marker, and several have exit conditions
that are genuinely a judgement call rather than a command. Registering them there
would mean inventing markers for work that has none. Per todo 29's own instruction,
they live here instead, and this file is linked from
[`DESIGN.md`](../DESIGN.md) § 9 Pass 2.

`docs/TECHNICAL_DEBT.md` remains the single register for marker-bound debt. **Do not
migrate entries between the two files** — they answer different questions.

---

## 1. Deferred by decision D7

D7 (`.omo/drafts/ceraui-experience-stability.md:97`) scoped the UI pass to the
critique's top-5 plus the touch/motion/i18n items, and deferred the rest.

### DF-1 — Colour-literal consolidation

- **Origin:** D7 audit, `.omo/drafts/ceraui-experience-stability.md:83` — "132 colour
  literals across 62 svelte files".
- **Status when re-measured (todo 29):** **the audit figure is not reproducible, and
  the codebase looks materially cleaner than it claims.** Two candidate definitions,
  both measured over `apps/frontend/src/**/*.svelte`:
  - raw CSS colour literals (`#rgb`/`#rrggbb`, `rgb()/rgba()`, `hsl()/hsla()`) →
    **4 occurrences in 2 files**;
  - Tailwind palette classes (`bg-|text-|border-|…` × `slate…rose` × `50…950`) →
    **0 occurrences in 0 files**.
- **Reading:** the surfaces use semantic design tokens, not palette colours. The
  draft does not state the metric's glob or definition, and the underlying critique
  document is not preserved in the workspace (see DF-4), so the 132/62 figure cannot
  be reconciled. It is most likely counting a third thing (e.g. token *declarations*
  in `app.css`, or `--link-N` ramp entries) rather than per-surface literals.
- **Files:** `apps/frontend/src/**/*.svelte` (2 files carry the 4 literals).
- **Exit condition:** re-run the two commands recorded above; if both stay at
  ≤ 4 / 0, close this entry as *not-debt* with the measurement attached. Only open
  real consolidation work if a third definition reproduces a number near 132.

### DF-2 — `text-status-*` / `bg-status-*/10` contrast debt

- **Origin:** D7 audit, `.omo/drafts/ceraui-experience-stability.md:83` — "the
  baselined contrast debt", 64 files.
- **Status when re-measured (todo 29):** **65 files** — unchanged by Wave 3 (+1).
  Real, open, and untouched.
- **What it is:** the `text-status-<kind>` foreground paired with a
  `bg-status-<kind>/10` (10 % alpha) background is a low-contrast combination whose
  ratio was baselined rather than fixed. It is used for every calm info / warning /
  degraded band across the app.
- **Files:** 65 `.svelte` files under `apps/frontend/src` —
  `grep -rlE 'text-status-[a-z]+|bg-status-[a-z]+/10' --include='*.svelte' apps/frontend/src`.
- **Why deferred:** it is a design-token decision (raise the alpha, or darken the
  foreground ramp) with a 65-file blast radius and a golden re-baseline attached to
  every one. It is not a per-surface fix.
- **Exit condition:** every `text-status-*` on `bg-status-*/10` measures ≥ 4.5:1 in
  both themes, asserted by a test over the resolved token values (not per surface);
  then `bun run --filter frontend test:e2e -- --grep "@a11y"` stays green.

### DF-3 — Reduced-motion guards outside D7's four files

- **Origin:** D7 audit named four files with bare `animate-*`:
  `Layout.svelte:242`, `NavigationRenderer.svelte:106`, `IdentityPreview.svelte`,
  `DevTools.svelte`.
- **Status when re-measured (todo 29): ALL FOUR ARE RESOLVED.** Todo 28 took
  `IdentityPreview` and `DevTools` too (its brief allowed them "if trivially in
  scope"). Verified: `main/Layout.svelte:239`, `main/navigation/NavigationRenderer.svelte:101`,
  `main/tabs/DevTools.svelte:43`, `main/tabs/IdentityPreview.svelte:144,506,569` — every
  one now carries `motion-safe:`. **This part of D7 carries no residual debt.**
- **What remains (new, wider than D7 scoped):** **30 `.svelte` files** still contain at
  least one `animate-*` with neither a `motion-safe:` nor a `motion-reduce:` guard.
  14 are shadcn-managed primitives under `lib/components/ui/` (dialog, sheet, select,
  popover, tooltip, dropdown-menu, alert-dialog, drawer, accordion, skeleton, sonner) —
  these are CLI-managed and must not be hand-edited (see `CeraUI/AGENTS.md`
  ANTI-PATTERNS). The remaining 16 are first-party, e.g.
  `lib/components/custom/{InputPicker,mobile-link,BondToggle}.svelte`,
  `lib/components/custom/pwa/{pwa-status,pull-to-refresh,offline-page}.svelte`,
  `main/{LiveView,shared/StreamingControls,live/LiveSummaryStrip}.svelte`,
  `main/notifications/{PersistentNotices,NotificationsPanel}.svelte`,
  `main/dialogs/{ModemConfigDialog,WifiNetworkList}.svelte`.
- **Why deferred:** the shadcn half needs a global CSS answer (a
  `@media (prefers-reduced-motion)` rule in `app.css` that neutralises the
  `animate-*` keyframes) rather than 14 forbidden edits; that is a design decision,
  not a mechanical pass.
- **Exit condition:** with `prefers-reduced-motion: reduce` emulated, no element on
  the Live / Network / Settings destinations reports a non-`none` `animation-name`,
  asserted by a computed-style e2e leg in the existing `@a11y` lane (the
  `modem-a11y.spec.ts` RM-1…RM-4 precedent).

### DF-4 — Critique backlog items 6–7, 16–21, 23–25 (provenance gap)

- **Origin:** D7 states verbatim: *"UI refinement executes the critique's TOP-5 +
  touch/motion/i18n items only (backlog 1–5, 8–15, 22); items 6–7, 16–21, 23–25
  recorded as follow-ups."*
- **Problem: the critique's numbered backlog is not preserved anywhere in the
  workspace.** Searched: `.omo/plans/`, `.omo/drafts/`, `.omo/notepads/`,
  `.omo/research/`, and `DESIGN.md`. The draft records only the *outcome* (top-5 +
  the audit line), never the enumerated 1–25 list. The plan's todo numbers 6–7 /
  16–21 / 23–25 are a **different numbering space** (they are unrelated, already-`[x]`
  engineering todos: the vitest spike, wire vocabulary, remember-me, etc.) and must
  not be mistaken for these.
- **Consequence:** these ten items cannot be honoured as written. What survives of the
  design critique's residue is captured concretely in DF-1 … DF-3, which is the
  audit content the draft *does* preserve.
- **Exit condition:** either (a) re-run the Pass-2 implementation critique against
  the current tree to regenerate a numbered finding list, and open real entries from
  it; or (b) close this entry as unrecoverable, recording that DF-1…DF-3 supersede
  it. **Do not fabricate the ten items from their numbers.**

---

## 2. Residual findings raised by todos 24–28

Each was surfaced by the owning todo's own work and deliberately left unfixed.

### DF-5 — `hud-bitrate-limit` has no word-label sibling (todo 26)

- **Where:** `apps/frontend/src/main/HudBar.svelte:423`.
- **What:** in the compact HUD strip the bitrate *limit* renders as a bare numeric
  `<span data-testid="hud-bitrate-limit">` with no adjacent word label, while its
  siblings in the expanded sheet do carry one (`hud-bitrate-limit-row`,
  `HudBar.svelte:642`). `HudBar.test.ts:532` already reaches for
  `previousElementSibling`, so the asymmetry is known to the suite.
- **Why deferred:** the compact strip is under a hard 4-fact scope
  (`CeraUI/AGENTS.md` → HUD 4-fact scope); adding a word costs horizontal budget at
  375 px, which is exactly what todo 26 had just reclaimed.
- **Exit condition:** the limit is comprehensible without the surrounding sheet at
  375 px — either a word label that fits, or an `aria-label` plus a documented
  decision that the visual bareness is intentional.

### DF-6 — `NavigationRenderer`'s transition spinner is unreachable (todo 28)

- **Where:** `apps/frontend/src/lib/stores/navigation.svelte.ts:114` (definition),
  `:230` (export); spinner at `main/navigation/NavigationRenderer.svelte:101`.
- **What:** `setTransitioning()` has **zero callers in shipped source**. The only
  other reference in the tree is a comment in
  `main/navigation/NavigationRenderer.test.ts:198` recording that fact. The spinner
  it gates therefore cannot render in a browser — todo 28 still added its
  `motion-safe:` guard rather than leave a half-state.
- **Why deferred:** deleting it is a behaviour decision (is a navigation transition
  indicator wanted at all?), and todo 28 was scoped to motion guards.
- **Exit condition:** either wire `setTransitioning` at the real navigation
  boundary and prove the spinner renders, or delete the store field, the export, the
  spinner branch and the test comment together — leaving no dead export.

### DF-7 — `sharing-diagnostics` never renders in `multi-modem-wifi` (todo 25)

- **Where:** `apps/frontend/tests/e2e/visual/network-density.visual.spec.ts:196`
  and `:220` — both `@visual` tests in "NetworkView density — disclosures".
- **What:** **PRE-EXISTING, and proven so.** Todo 25 established it by reverting to
  HEAD and re-running: the Sharing card is *quiet* in the `multi-modem-wifi`
  scenario, so `sharing-diagnostics` never mounts and both tests fail on a
  disclosure that is not there. The spec predates that scenario change.
- **Confirmed still failing at todo 29** — 2 of the 21 visual failures. **Not a
  Wave-3 regression; do not re-baseline.**
- **Exit condition:** either seed `sharing_diag` in the scenario the spec runs
  under, or move the two tests to a scenario where the Sharing card is loud. The
  spec must exercise a disclosure that actually renders.

### DF-8 — Duplicate `bond-toggle-dg1h` row (todo 25)

- **Where:** `apps/frontend/src/lib/components/custom/BondToggle.svelte:169`
  (`data-testid={`bond-toggle-${name}`}`); frozen inventory entry at
  `tests/e2e/visual/network-density.visual.spec.ts:363`.
- **What:** the dongle projection's metadata-only union
  (`netif.dg1h.dongle`, see `src/tests/netif-dongle-ingestion.test.ts:58,122`)
  yields a row that renders a second `bond-toggle` for the same physical unit.
- **Why deferred:** the row is load-bearing for the isolated-dongle surface, and
  suppressing it collides with the marker-plus-roster-claim rule in
  `apps/backend/AGENTS.md` → "AN ISOLATED DONGLE IS SURFACED WITHOUT ENTERING THE
  BOND". Todo 25 was explicitly barred from changing that rule.
- **Exit condition:** one physical unit renders exactly one bond toggle, with the
  frozen 49-testid inventory updated in the same change and the isolated-dongle
  honesty band still present.

---

## 3. Findings raised by todo 29 consolidation

### DF-9 — Twelve visual goldens were invalidated by Wave 3 and not re-baselined

- **What:** 12 of the 21 visual failures are stale committed goldens. Wave 3 changed
  **shared** layout — `app.css` (+30 lines, the touch lift), `main/Layout.svelte`,
  `main/SettingsView.svelte` (todo 28, `f5bf85e4`), and
  `main/network/{SharingSection,BondedLinksSection}.svelte` (todo 25, `4c524251`) —
  but each todo re-baselined only the golden its *own* spec owned.
- **Affected goldens** (spec → failures): `live.visual` 1, `network.visual` 1,
  `settings.visual` 1, `sharing.visual` 3, `signal-indicator.visual` 6.
- **Evidence it is staleness, not a rendering-environment artifact:**
  - `network.visual` expects `1280×2032`, receives `1280×1873` — a **159 px** delta
    that exactly matches the gain todo 25 recorded for its fixture amendment
    (2036 → 1877 px). The golden was baselined *before* that amendment.
  - `preview-toggle.visual` (2 goldens) **passes**. That is the control group: a
    font/DPI environment delta would have broken it too.
  - `settings.visual`'s golden was last written 2026-07-01, before Wave 3 touched
    `SettingsView.svelte` and `app.css`.
- **Do not re-baseline from todo 29** — todo 29 is consolidation-only and the plan
  forbids re-baselining a golden to make a lane pass.
- **Exit condition:** re-baseline each golden **from the owning todo's scope**, with
  the diff visually reviewed (not blind `--update-snapshots`), then
  `bun run test:e2e:visual` is green on both projects.

### DF-10 — Five `@visual` specs predate the PR-#137 removal of `#encoder-source`

- **What:** 5 of the 21 failures are specs clicking `page.locator("#encoder-source")`,
  which **never resolves** — the element is absent from the DOM.
- **This is intended app behaviour, not a break.** The source picker moved out of
  `EncoderDialog` into `SourceSection` under the device-first source model
  (`3a6fb08b`, "Experience simplification: device-first sources", PR #137, 2026-07-04;
  refined by `ed0ec625`, 2026-07-07). Both **predate Wave 3** (`git merge-base
  --is-ancestor 3a6fb08b 78a071fc` → true). The current design is asserted
  positively: `src/main/dialogs/EncoderDialog.axes.test.ts:428` and `:460` require
  `document.body.querySelector("#encoder-source")` to be **null**.
- **Affected specs:** `encoder-capability.visual:153`, `task-3-cohesion.visual:153`,
  `task-10-audio-comingsoon.visual:117`, `task-13-quick-wins.visual:159` and `:185`,
  `task-25-live-audio-swap.visual:132`.
- **Deterministic**, not flaky: re-run serially at `--workers=1 --retries=0`, 7
  failed / 1 passed.
- **Exit condition:** rewrite each spec against the shipped source surface
  (`SourceSection`), or retire it where a newer spec already covers the behaviour.
  Retiring must state which spec inherits the coverage — never a bare deletion.

### DF-11 — `field-sync-state.visual` needs the dev-only DevTools route

- **Where:** `apps/frontend/tests/e2e/visual/field-sync-state.visual.spec.ts:21`
  (`openDevTools`), failing test at `:33`.
- **What:** the spec navigates to the **DevTools** destination, which ships only in
  development builds. Under the CI server topology (production bundle served by
  `vite preview`) the nav button does not exist, so the click times out.
- **Exit condition:** either gate the spec on a dev build, or drive the field-sync
  states through a production-reachable surface.

### DF-12 — CI never runs the `@visual` or `@a11y` lanes (root cause of DF-9…DF-11)

- **Where:** `.github/workflows/build-check.yml:440` — the *only* e2e job runs
  `--grep-invert "@visual|@a11y|@gallery|@premigration-upgrade"`. No other workflow
  references `@visual` or `test:e2e:visual`.
- **What:** 50 `@visual` specs and their 14 committed golden PNGs are **never
  executed by any automated gate**. Nothing tells an author that a shared-layout
  change invalidated another spec's golden, which is precisely how DF-9 accumulated
  silently and how DF-10's specs stayed red since July without anyone noticing.
- **Why this is the highest-leverage entry here:** DF-9, DF-10 and DF-11 are
  symptoms. Fixing them without closing this gap guarantees the drift returns.
- **Exit condition:** a required job runs the `@visual` and `@a11y` lanes on both
  projects and is green — or, if the goldens are judged too environment-sensitive
  for CI, the golden-comparing specs are deleted rather than left as unexecuted
  files implying coverage that does not exist.

### DF-13 — Design-pass gallery is 24 PNGs / 4 surfaces, not the expected 30 / 5

- **What:** todo 29's criterion expected ≥ 30 PNGs (5 surfaces × 3 viewports ×
  before/after). Actual: **24 PNGs across 4 surfaces** (todo 24 live-idle ×3,
  todo 26 hud-strip ×3, todo 27 updating-overlay ×3 and updates-dialog ×3).
- **Why:** todos **25** and **28** correctly shipped *numeric* evidence rather than
  screenshot pairs — their acceptance criteria were a page-height cap, a ≥ 44 px hit
  area, and a computed animation style, none of which a screenshot can assert. Todo 27
  contributed two surfaces, so 5 todos yielded 4 PNG surfaces.
- **Not backfillable from this tree:** todo 25's "before" exists only behind
  `4c524251^` and would need a separate historical build.
- **Where:** `apps/frontend/test-results/design-pass/README.md` (gitignored) §3.
- **Exit condition:** decide whether the design-pass evidence standard requires a PNG
  pair per surface at all; if yes, amend the plan template so geometry-only todos are
  not held to it.
