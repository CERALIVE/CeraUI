# CeraUI Design Follow-ups

**Status:** `[EXISTS]`

Deferred **design** findings from the `ceraui-experience-stability` Wave-3 UI pass
(todos 24–29), opened by todo 29 (C4 consolidation), plus the marker-less
**engineering** deferrals from that same effort's other waves (§4, opened by todo 38).
Both live here for the same reason: neither ships a source marker, so neither is
admissible to the marker-bound register (see the next section). §5 holds the System
Logs critique residuals (device-log-system todo 36), §6 what its hardening pass (todo 37)
found outside System Logs, §7 what its polish and audit pass (todo 38) left open.

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
  both the host-owned `bun run test:e2e:visual` and the container-owned
  `bun run test:e2e:visual:container` are green; see [Visual CI](VISUAL-CI.md).

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
- **Resolved:** the test is tagged `@dev-only`, so it runs only in the `desktop-dev`
  project, against a Vite dev server (`apps/frontend/playwright.config.ts`).

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

---

## 4. Engineering follow-ups from the rest of the effort (opened by todo 38)

These are not design findings. They are deferrals raised while landing the apt
family-selection, DNS, remember-me and roster-truth work, and they are recorded here
rather than in `docs/TECHNICAL_DEBT.md` for the reason stated at the top of this file:
none of them ships a `data-debt-id`, a `coming-soon` affordance or an in-source
`[PARTIAL]`, and several have exit conditions that are a judgement call rather than a
command. Registering them there would mean inventing markers for work that has none.

### DF-14 — SRTLA, the control WebSocket and pairing still pick a family implicitly

- **What:** the per-run address-family verdict (`apps/backend/AGENTS.md` → APT REACHES
  THE REPOSITORY OVER THE FAMILY THAT WORKS) is scoped to apt, and the gateway family
  race is scoped to default-route election. Three other outbound paths still take
  whatever the resolver and the routing table hand them: the SRTLA sender's own
  endpoint resolution, the device→hub control WebSocket, and the platform pairing POST.
  On a board holding complete AAAA answers with no usable IPv6 route — the measured
  Orange Pi 5+ topology, and the exact condition that produced the apt work — each of
  those can spend its budget on an address that cannot carry traffic.
- **Why it is deferred rather than fixed here:** the three have genuinely different
  correctness constraints. SRTLA pins a link to a resolved origin at connect time, so a
  family choice there is a bonding-math decision, not a retry policy. The control
  channel and the pairing POST are ordinary client sockets whose failure is visible and
  retried. Applying one rule to all three is the wrong shape, and applying the apt rule
  in particular would be wrong for SRTLA.
- **Where:** `apps/backend/src/modules/streaming/srtla.ts`,
  `apps/backend/src/modules/remote-control/channel.ts`,
  `apps/backend/src/modules/pairing/`.
- **Exit condition:** a per-path decision recorded for each of the three — either an
  explicit family policy with a test naming it, or a written statement that the default
  behaviour is correct for that path and why. Not one shared helper by default.

### DF-15 — The Debian mirror is still reached over plain HTTP in the shipped image

- **What:** the reachability probe classifies a plain-HTTP redirect to a foreign host as
  `captive`, which is the right call precisely because the mirror is reached over HTTP
  and a portal can therefore intercept it transparently. Over HTTPS that interception is
  visible as a TLS failure instead of a 302, and the whole `captive` heuristic becomes a
  backstop rather than the primary signal.
- **Why it is deferred:** the sources list ships in the device image, not in this repo,
  so the change belongs to `image-building-pipeline` and lands on its release cycle.
  Flipping it also changes what a genuine outage looks like on a board (a TLS error
  rather than a redirect), so it wants a board drill of its own.
- **Where:** the deb822 stanzas under `/etc/apt/sources.list.d` as baked by
  `image-building-pipeline`; consumed read-only here by
  `apps/backend/src/modules/system/apt-source-origins.ts`.
- **Exit condition:** the image's Debian origin is `https://`, and the captive-portal
  classification is re-verified on a board against a real portal — confirming it still
  reports honestly rather than silently degrading to "unreachable".

### DF-16 — Remember-me is a device-scoped token; there is no cloud-issued server token

- **What:** `localStorage.auth` holds a token the DEVICE issued and the device can
  revoke. It does not span devices, so an operator with three boards signs into three
  boards. A cloud-issued credential that the device would verify instead is a different
  design and does not exist.
- **Why it is deferred:** it is a security-boundary decision (who issues, who revokes,
  what an offline device accepts when the issuer is unreachable), not an implementation
  gap. Shipping a half of it is worse than shipping none.
- **Where:** `apps/frontend/src/lib/stores/auth-status.svelte.ts` (the consumer),
  `apps/backend/AGENTS.md` → A REMEMBER-ME CREDENTIAL IS A REVOCABLE TOKEN (the issuer).
- **Exit condition:** a written decision on issuance and offline-verification, before
  any code. If the answer is "device-scoped is correct", close this as not-debt with
  that reasoning attached.

### DF-17 — Colour-literal consolidation, as re-measured

- **What:** this is DF-1 above, listed here only so a reader arriving from the effort's
  named follow-up list finds it. Do not open a second entry for it.
- **Exit condition:** DF-1's.

## 5. Findings left by the Live screen design pass

The final design pass on the Live screen and the Encoder dialog
([`docs/agents/live-screen.md`](agents/live-screen.md), "The final design
pass") fixed every finding its audit rated blocking or serious. These findings were
rated minor or polish. Each open entry states why it is deferred; resolved
entries record the follow-up that removed their blocker.

### DF-18 — Inset panels inside cards on the Live screen

- **What:** the detector flags three bordered, muted panels that sit inside a
  card: the preview's hardware-encode control, the second input's opacity
  control, and the encoder-load block of the telemetry card.
- **Why it is deferred:** each is the system's inset panel (`bg-muted/40
  rounded-lg border`) for a control and its outcome, the same pattern the
  Encoder dialog's bitrate control uses. Dropping it on one screen would split
  the pattern; changing it everywhere is a system decision, not a polish fix.
- **Where:** `apps/frontend/src/main/live/PreviewEncodeControl.svelte`,
  `apps/frontend/src/main/live/CompositionCard.svelte`,
  `apps/frontend/src/lib/components/custom/IngestStats.svelte`.
- **Exit condition:** a DESIGN.md rule on whether an inset panel is allowed inside
  a card; then apply it to every user at once.

### DF-19 — Small type in the now-streaming summary and the mixer notes

- **What:** the "Now streaming" label is 10.4 px uppercase, the "Simulated" badge
  is as small, and the mixer's "Meter unavailable" and "Level shows once you go
  live" notes are 11 px monospace.
- **Why it is deferred:** readable and AA in contrast; moving them to the 12 px
  step changes the summary strip's rhythm, which wants a look of its own.
- **Where:** `apps/frontend/src/main/live/LiveSummaryStrip.svelte`,
  `apps/frontend/src/main/live/AudioMixer.svelte`.
- **Exit condition:** the labels use the type scale's smallest step (`text-xs`)
  and the strip is re-checked at 375 px and 1024x600.

### DF-20 — Encoder dialog details in Arabic and at phone width

- **What:** in Arabic the detected-capability chips (`1920×1080 @ 30 H.264`)
  are laid out right to left, which the bidi algorithm does correctly but reads
  reversed at a glance; at 375 px the active source's long name is cut with no
  way to read the rest in the dialog.
- **Why it is deferred:** neither hides a control or a state; the full source
  name is on the Live screen's source tile.
- **Where:** `apps/frontend/src/main/dialogs/EncoderDialog.svelte` (the
  `probed-caps` chips and `encoder-active-source`).
- **Exit condition:** the chips are isolated left to right (`dir="ltr"`, as the
  mixer's dB values are) and the name wraps or carries its full text.

### DF-22 — The preview's own card sits inside the preview disclosure card (resolved)

- **What:** the desk drew `PreviewCanvas`'s card inside `preview-disclosure`'s card
  (the brief's "no card inside a card"). Rendering it `compact` removes the inner
  card, but moves the picture by its padding, and that exposed a latent designer
  defect: the inset's 2 px border at each corner is a move zone, not a resize zone,
  so a press at the exact corner resizes or moves depending on sub-pixel layout
  (`layout-designer.spec.ts`, right-edge drag, failed deterministically).
- **Resolution:** the corner caps cover the inset's 2 px border as well as its
  interior, so a border press resizes consistently. The preview uses its existing
  `compact` variant and the disclosure supplies the card chrome.
- **Where:** `apps/frontend/src/main/live/PreviewDisclosure.svelte`,
  `apps/frontend/src/main/live/LayoutDesigner.svelte` (`CAP_POSITION`).
- **Coverage:** `layout-designer.spec.ts` checks resizing from every corner's
  border and the preview's single card border; its existing phone case checks
  that the smallest inset still moves from its middle.

### DF-21 — "Preview" is said twice in the desk

- **What:** the disclosure's summary and the preview's own heading both read
  "Preview".
- **Why it is deferred:** removing either moves a string out of a place a test or
  a user doc points at; the pass changed no string.
- **Where:** `apps/frontend/src/main/live/PreviewDisclosure.svelte`,
  `apps/frontend/src/lib/components/preview/PreviewCanvas.svelte`.
- **Exit condition:** one of the two is dropped in a change that updates its
  tests and the user docs together.

---

## 6. System Logs critique residuals (device-log-system todo 36)

The P2 and P3 findings of the System Logs critique that were not fixed in that pass.
The full table, evidence and the fixed findings are in
[`apps/frontend/docs/agents/system-logs-critique.md`](../apps/frontend/docs/agents/system-logs-critique.md)
(IDs SL-n).

### DF-23: The helper's file is the last of four equal download rows (SL-3, P2)

- **Where:** `apps/frontend/src/main/system-logs/SystemLogsView.svelte` (Downloads region;
  the Storage tab below 1024 px), `SharingSection.svelte`, `LegacyLogDownloads.svelte`.
- **What:** Support bundle has the weight of the two legacy files and Export, and on phones
  and the kiosk it sits under the Storage tab after limits and cleanup.
- **Owner:** the System Logs product owner, as a layout decision before the view's next
  iteration; the shape approved in todo 6 stays until then.
- **Exit condition:** a decided placement and weight for the bundle, built and captured at
  375, 1024x600 and 1280 px.

### DF-25: Destructive confirmation text is under 4.5:1 (SL-5, P2)

- **Where:** the shared `destructive` button variant as used by
  `lib/components/custom/simple-alert-dialog.svelte`.
- **What:** 3.07:1 dark, 3.84:1 light for the confirm label. App-wide, not System Logs only;
  the frontend rules forbid hand-editing the shadcn primitive.
- **Owner:** the CeraUI design-system owner, with DF-2.
- **Exit condition:** the destructive confirm label measures at least 4.5:1 in both themes.
- **Todo 37 decision:** kept here, owner unchanged. The label colour is the shared variant's
  `text-destructive` on its 10 % (light) or 20 % (dark) wash (`lib/components/ui/button/button.svelte`,
  variant `destructive`), used by every destructive confirmation in CeraUI, so raising it is the
  token decision DF-2 owns, taken once for the app rather than per surface.

### DF-26: Spanish System Logs chrome wraps at 320 and 375 px (SL-6, P2)

- **Where:** `SystemLogsView.svelte` tab triggers, `BootButton.svelte`, `RawLogsFilterBar.svelte`.
- **What:** "Registros sin procesar" wraps to three lines (66 px tab strip, nothing clipped),
  "Todos los arranques" wraps in the header at 320 px, and the search placeholder
  ellipsizes at 375 px.
- **Owner:** device-log-system todo 37 (locales and viewports).
- **Exit condition:** the todo 37 responsive spec covers `es` at 320 and 375 px and the tab
  strip holds at most two lines.
- **Todo 37:** fixed at the measured sizes from 375 px up; re-recorded at 320 px. Two causes were fixed: the
  page kept its stable scrollbar gutter beside the fullscreen view (15 px in a browser with
  classic scrollbars, `app.css` `html:has([data-app-dialog-fullscreen])`), and below 640 px the
  three tabs took equal widths, so "Eventos" held room "Registros sin procesar" needed
  (`SystemLogsView.svelte`, `max-sm:flex-auto` on the tab triggers). At the measured sizes
  from 375 px up (375 px in all ten locales; 768, 1024 and 1280 px in en, ar and de) every
  tab label holds at most two lines, and at 320 and 375 px every label is painted inside its
  control (`apps/frontend/tests/e2e/system-logs-responsive.spec.ts`). At
  320 px Spanish still needs three lines: once "Eventos" (69 px) and "Almacenamiento" (128 px)
  take their own widths the raw tab keeps 78 px, 64 px of text, and "sin procesar" is 83 px;
  nothing is clipped. The boot button wrap and the search placeholder ellipsis stay as
  designed, inside their own controls.
- **Spanish copy (decided):** `systemLogs.tabs.raw` now reads "Logs" and
  `systemLogs.events.viewRaw` "Ver logs" (es-419 keeps the anglicism logs). The narrow audit
  measures the Spanish tab at one line at 320 px (54 px) and 375 px, and every locale at
  most two lines at 320 px, so `system-logs-responsive.spec.ts` now caps tab labels at two
  lines at 320 px too. The boot button wrap and the search placeholder ellipsis are unchanged.

### DF-27: Undersized targets around System Logs (SL-7, P2)

- **Where:** the toast action from `lib/device-logs/view-logs.ts` (Sonner default action),
  the default-pointer notice action, and the shared select item in touch layout.
- **What:** 69x24 px toast action in the system font; 28 px notice action; 28 px retention
  option rows in touch layout.
- **Owner:** device-log-system todo 37 (touch), through the `app.css` touch token layer.
- **Exit condition:** every listed control meets 44 px in touch layout and 24 px elsewhere.
- **Todo 37: closed.** The System Logs select options (retention in `StorageLimits.svelte`,
  source and time in `RawLogsFilterBar.svelte`) carry `min-h-(--touch-target-min)`, which is
  44 px in touch layout and 0 elsewhere (`app.css`), so the shared select item is unchanged.
  Measured by `apps/frontend/tests/e2e/system-logs-responsive.spec.ts`: the notice and toast
  View logs actions are at least 24 x 24 px outside touch layouts and 44 x 44 px in touch
  layout, with their labels painted inside, and every option of the four System Logs selects
  (source 8, time 5, retention 5, size limit 4) at the 1024x600 kiosk in touch layout is at
  least 44 px tall. The toast's system font is not a
  target size and belongs to every toast, so it moved to DF-36.

### DF-28: A refused download keeps its ticket for 60 s (SL-8, P2)

- **Where:** `apps/backend/src/modules/device-logs/export.ts` and `bundle.ts` (ticket
  lifetime), `lib/device-logs/sharing-flow.svelte.ts`.
- **What:** after the browser refuses a download, Retry reads Busy until the ticket expires.
- **Owner:** the CeraUI device-logs backend owner; listed in the CeraUI PR follow-ups.
- **Exit condition:** a retry after a refused download starts a new download.

### DF-29: An approximate jump has no moment marker (SL-9, P2)

- **Where:** `RawLogsTab.svelte` (anchor band), `RawLogList.svelte` (end markers).
- **What:** nothing marks where the message's moment falls; the newer end shows the
  generic end text above the newest rows; the approximate note is muted extra-small text.
- **Owner:** device-log-system todo 38 (polish); a new copy key needs all ten locales.
- **Exit condition:** an approximate jump shows where the moment falls and a newer-end
  text that cannot read as an empty result.
- **Todo 38: closed.** An approximate window shows a separator row, "Selected moment:
  {time}" (`systemLogs.anchor.moment`), above the first entry recorded at or before the
  moment, moving above its date separator when one directly precedes it, or at the end when
  no entry at or before the moment was found (`apps/frontend/src/lib/device-logs/raw-rows.ts:156`,
  `withMoment`). The list places it from the window's older bound
  (`apps/frontend/src/main/system-logs/RawLogList.svelte:38-41`), which the backend sets to
  the moment (`apps/backend/src/modules/device-logs/around.ts:54`). Each side of an
  approximate window reads a bounded time range (`around.ts:53`, `:65-68`).
  When an approximate edge shows an end marker, it uses the corresponding time-window message: "No additional entries match on the newer side of this time window." or "No additional entries match on the older side of this time window."
  (`systemLogs.raw.endNewerWindow`, `systemLogs.raw.endOlderWindow`). A window around an
  exact entry reads on to the ends of the boot's stored logs (`around.ts:50-51`, `:62-63`).
  When an exact edge shows an end marker, it uses the corresponding stored-logs message: "No newer entries match in the stored logs." (`systemLogs.raw.endNewer`) or "No more entries match in the stored logs." (`systemLogs.raw.end`) (`RawLogList.svelte:164-211`).
  At the older edge, the display-limit notice takes precedence.
  The new keys are in all ten locales. The approximate note keeps its colour and size; it now
  keeps a flex basis in a wrapping row, so it takes its own line, with Back to latest entries
  below it, when the two do not fit side by side,
  and adds explicit Chinese word-boundary breaks when segmentation is available. The browser still controls punctuation breaks and supplies the fallback without segmentation.
  (`apps/frontend/src/main/system-logs/RawLogsTab.svelte:104-108`). At 320 px in the
  approximate-jump mock fixture, the previous note wrapped to 10 or 11 lines and painted
  outside its box in German, Spanish and Brazilian Portuguese.

### DF-30: Confirmations do not open on Cancel (SL-11, P3)

- **Where:** `StorageCleanup.svelte` through `simple-alert-dialog.svelte`.
- **What:** focus opens on the dialog; contract section 7 says the focused default is Cancel.
- **Owner:** device-log-system todo 38 (keyboard audit).
- **Exit condition:** opening either clear confirmation focuses Cancel.
- **Todo 38: closed.** Both clear confirmations open with focus on Cancel:
  `apps/frontend/src/main/system-logs/StorageCleanup.svelte:54` (`openOnCancel`) hands an
  `onOpenAutoFocus` to the shared dialog through its existing `contentProps` (`:141`,
  `:160`), so `simple-alert-dialog.svelte` is unchanged. Proved by `StorageSection.test.ts`
  ("opens Clear all logs with focus on Cancel") and `apps/frontend/tests/e2e/system-logs-keyboard.spec.ts`.

### DF-31: System Logs polish residuals (SL-12, P3)

- **What:** two time formats, the Order label's offset, the repeated Storage heading on
  phones, the repeated unit in an expanded raw row, the wrapped "Boot started" prefix in
  side boot rows, an empty usage bar under 1 %, "All sources" in placeholder grey, and the
  recessed checked segment in dark.
- **Owner:** device-log-system todo 38 (polish).
- **Exit condition:** each item fixed or explicitly kept in `system-logs-view.md`.
- **Todo 38 decisions:**
  - The Order label's offset: fixed. The folded filters align on their top edge
    (`apps/frontend/src/main/system-logs/RawLogsFilterBar.svelte:125`, `items-start`).
  - An empty usage bar under 1 %: fixed. A share above zero draws a sliver
    (`apps/frontend/src/main/system-logs/StorageUsage.svelte:37`, `min-w-1`).
  - "All sources" in placeholder grey: fixed. The trigger shows it in the value colour
    (`RawLogsFilterBar.svelte:140`).
  - The recessed checked segment in dark: fixed. In dark it takes the accent surface, lighter
    than its track (`apps/frontend/src/main/system-logs/SegmentedChoice.svelte:66`).
  - The two time formats, the repeated Storage heading on phones, the repeated unit in an
    expanded raw row and the wrapped "Boot started" prefix: kept, each with its reason in
    `apps/frontend/docs/agents/system-logs-view.md` under Open decisions, Polish (todo 38).

### DF-32: Confirmation backdrop and primary lime (SL-13, P3)

- **Where:** `simple-alert-dialog.svelte` overlay; filled default buttons in System Logs.
- **What:** the confirmation's light wash brightens the dark UI unlike the view's dialogs;
  Save and Download are filled lime while Follow avoids lime.
- **Owner:** the CeraUI design-system owner.
- **Exit condition:** one backdrop for nested dialogs and one written rule for lime.

### DF-33: Two live Raw views at once (SL-14, P3)

- **Where:** `lib/device-logs/raw-follow-session.svelte.ts` socket follow ownership.
- **What:** the later Follow would win. No surface mounts two Raw views today.
- **Owner:** whoever adds a second Raw view surface.
- **Exit condition:** follow ownership is per view before a second Raw view ships.

### DF-34: A sequence-gap reload drops Events keyboard focus (SL-16, P2)

- **Where:** `apps/frontend/src/lib/device-logs/events-view.svelte.ts:110-116,248-252`: a reload clears every Events row at once.
- **What:** when the live feed skips a sequence number, the list reloads and its rows are cleared before the first page returns. A row action holding keyboard focus is disconnected even when its event is in the reloaded page, so focus moves to Close at 1280 px and to the boot picker at 375 px. The roving stop returns to that row after the reply; only focus is lost. Reproduced in both themes at both widths by the third-round review of todo 36.
- **Repro:** focus View raw logs on row 2 of Events, deliver an event push that skips a sequence number, and answer `events.list` with the same first page.
- **Severity:** P2.
- **Why deferred:** a rare path (the live feed missed events and the list reloads); the focused row survives and the stop returns to it, only focus is lost. The fix changes the reload path, outside the critique pass.
- **Owner:** device-log-system todo 38 (Polish and audit: accessibility, keyboard), which runs before the final reviews and must fix it.
- **Exit condition:** a sequence-gap reload that keeps the focused event keeps focus on its action, proved by a Chromium spec.
- **Todo 38: closed.** A re-read for a skipped seq keeps the rows shown until its first
  page replaces them (`apps/frontend/src/lib/device-logs/events-view.svelte.ts:214`,
  `#reread`, called at `:260`; the page replaces the rows at `:232`), and Events draws no
  loading rows over kept rows (`apps/frontend/src/main/system-logs/EventsTab.svelte:221`).
  A failed re-read keeps no rows, as a failed reload does (`events-view.svelte.ts:238`).
  Proved in Chromium by `apps/frontend/tests/e2e/view-logs-action.spec.ts` ("a sequence-gap
  reload that keeps the focused event keeps keyboard focus on its action") on the desktop
  and mobile projects.

---

## 6. Found by the System Logs hardening pass (device-log-system todo 37)

### DF-35: The page scrollbar track is a cool blue-black outside the graphite palette (todo 37)

- **Where:** `apps/frontend/src/app.css`, `html` and `html.dark` `scrollbar-color`.
- **What:** the track colours are `hsl(210 20% 98%)` and `hsl(222 30% 6%)`, hue 210 to 222
  rather than the warm graphite hue 150 every surface uses (PRODUCT.md rules out the old cool
  identity). Todo 37 found it as the 15 px strip beside the fullscreen System Logs view; that
  strip is gone, the track still shows on every scrolling page with classic scrollbars.
- **Owner:** the CeraUI design-system owner (app shell tokens).
- **Exit condition:** the scrollbar track and thumb come from the graphite tokens in both
  themes.
- **Todo 38:** System Logs takes the palette for selection and scrollbars inside its dialog
  subtree only (`apps/frontend/src/main/dialogs/LogsDialog.svelte:37-39`). A portalled select
  list, such as Sources (`apps/frontend/src/main/system-logs/RawLogsFilterBar.svelte:143`),
  renders outside that subtree and keeps this page palette until this item's exit condition
  holds.

### DF-36: Toasts are set in a system font stack, not the app typeface (todo 37)

- **Where:** `[data-sonner-toaster]` in svelte-sonner 1.2.3 (`dist/Toaster.svelte`, line 549
  sets `font-family: ui-sans-serif, system-ui, ...`); `app.css` does not override it.
- **What:** every toast in the app, the System Logs View logs toast included, is drawn in the
  platform's system font while the rest of the UI uses the app typeface. Todo 37 measured it on
  the View logs toast; `font-family: inherit` on the toaster fixes it, but that changes every
  toast in the app, so todo 37 left it to this owner.
- **Owner:** the CeraUI design-system owner (shared `Toaster`).
- **Exit condition:** every toast's text computes to the app's font family.

### DF-37: The shared relative-time formatter says "just now" in English in every locale (todo 37)

- **Where:** `packages/i18n/src/formatters.ts:123`, `formatRelativeTime`
  (`if (Math.abs(seconds) < 10) return "just now";`). Its callers outside System Logs:
  `apps/frontend/src/main/HudBar.svelte:189` (`lastSeen()`, shown on the offline last-seen
  line and on the sensor freshness line at `HudBar.svelte:723-724`) and
  `apps/frontend/src/main/dialogs/ModemConfigDialog.svelte:2201` (the observed-at time).
- **What:** for the first 10 s after a timestamp every locale reads the English "just now";
  from the tenth second on, Intl speaks the locale ("hace 10 segundos"). The locale's own
  word is `Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "second")`: en
  "now", es "ahora", de "jetzt", fr "maintenant", pt-BR "agora", ja "今", ko "지금", zh "现在",
  ar "الآن", hi "अब". System Logs Events already shows that word through a local override
  (`apps/frontend/src/lib/device-logs/timeline-copy.ts`, `eventTime`); todo 37 left the
  shared formatter and its other callers unchanged, because changing it changes their copy.
- **Owner:** the CeraUI design-system and i18n owner (`packages/i18n`).
- **Exit condition:** `formatRelativeTime` returns the locale's word for now in its recency
  window, its tests say so, and the override in `eventTime` is removed.

### DF-38: The low-disk View logs action leaves keyboard focus off Storage on the mobile project (todo 37)

- **Where:** `apps/frontend/tests/e2e/view-logs-action.spec.ts:107`, "the low-disk action
  focuses the Storage heading", Playwright mobile project; the low-disk View logs action and
  the Storage heading of System Logs.
- **What:** after Enter on the low-disk action the System Logs dialog opens, but the Storage
  heading (the `h3` with `tabindex="-1"` inside `system-logs-storage`) is not focused:
  `Expected: focused`, `Received: inactive`. The desktop project passes. It fails the same way
  on the unchanged base `8cad9dd0` and with todo 37's changes, so todo 37 did not cause it.
  At todo 37, its @visual tag excluded it from the functional CI set.
- **Owner:** device-log-system todo 38 (keyboard and focus audit).
- **Exit condition:** on the mobile project the low-disk action lands keyboard focus on the
  Storage heading and the test passes.
- **Todo 38: closed.** A Storage request focuses the Storage heading once, in the side
  column or on the Storage tab (`apps/frontend/src/main/system-logs/SystemLogsView.svelte:120-127`);
  coming back to the Storage tab later leaves focus on the tab. "the low-disk action
  focuses the Storage heading" passes on the mobile and desktop projects, and
  `apps/frontend/src/main/dialogs/LogsDialog.context.test.ts` covers both widths. The test
  no longer carries `@visual` and takes no screenshot, so CI's functional job runs it
  (`apps/frontend/tests/e2e/view-logs-action.spec.ts:107`); its Storage capture moved to
  `apps/frontend/tests/e2e/visual/system-logs.visual.spec.ts`.

---

## 7. Left open by the System Logs polish and audit pass (device-log-system todo 38)

### DF-39: Paging can drop keyboard focus when the action changes or disappears (todo 38, P3)

- **Where:** `apps/frontend/src/main/system-logs/RawLogList.svelte` (Load more and Keep
  searching), `apps/frontend/src/main/system-logs/EventsTab.svelte` (Load older events).
- **What:** while its page loads, a pressed paging button keeps focus (`aria-disabled` and
  `aria-busy`, `RawLogList.svelte:172-173`, `:187-188`; `EventsTab.svelte:310-311`). When the page that
  lands turns Load more into Keep searching (`RawLogList.svelte:169-199`), or is the last one
  so the end text replaces the button (`RawLogList.svelte:200`, `EventsTab.svelte:319`), the
  pressed button leaves the page and focus leaves the list. With a mocked budget response,
  focus landed on the dialog's Close control.
- **Owner:** the System Logs product owner, with the end-to-end flows of device-log-system
  todo 39.
- **Exit condition:** Keep focus on the successor paging action, or inside the list when no
  action remains, proved by Chromium tests.
- **Todo 39: closed.** When the page that lands replaces a pressed Load more, Keep searching,
  Load older events or older-page Retry, focus moves to the next paging button at that end;
  when that end shows none, it moves to the list's row stop, then to Reset filters on an empty
  Raw result, then to the Raw list itself
  (`apps/frontend/src/main/system-logs/RawLogList.svelte:93-113`,
  `apps/frontend/src/main/system-logs/EventsTab.svelte:101-118`). An older Events page keeps
  its failure while Retry reads it again, so Retry stays mounted and busy
  (`apps/frontend/src/lib/device-logs/events-view.svelte.ts:222-223`,
  `EventsTab.svelte:171-172`). The six tests under "a paging button that its page replaces
  hands keyboard focus on" in `apps/frontend/tests/e2e/system-logs.spec.ts` pass on the
  desktop and mobile projects; on the desktop project they fail against the unchanged todo 38
  components, as do the component tests whose titles begin "hands focus" in
  `RawLogsTab.test.ts` and `EventsTab.test.ts`.
