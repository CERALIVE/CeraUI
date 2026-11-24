# CeraUI DESIGN.md — implementation design gate

> Scope: the **modem / cellular / network surfaces** touched by the
> `unified-modem-control-quality` effort. Nothing here replaces the visual world,
> migrates a styling framework, or redesigns the app shell.
>
> Derivation: this document is derived from [`.impeccable.md`](.impeccable.md)
> ("Ground Control — Calibrated. Live. Controlled."). `.impeccable.md` stays the
> aesthetic authority (color, type, tone, anti-references). DESIGN.md is the
> **implementation gate**: it turns those principles into rules a test or a
> reviewer can mark pass/fail. Where the two touch, `.impeccable.md` wins on
> look; this file wins on truthfulness and structure. Neither may contradict the
> other — §10 records the cross-check.
>
> Policy anchor: [`../docs/STANDARDS-CHARTER.md`](../docs/STANDARDS-CHARTER.md)
> — **the gate IS the deliverable**. A rule below without a named, runnable check
> does not count as enforced. Every §9 pass therefore stops on a checkable
> condition, never on "it looks done".

---

## 1. The capability-truth matrix

Traces to `.impeccable.md` Principle 1 (*Instrument Clarity* — every surface is a
display) and the emotional goal *"the interface never surprises them at a critical
moment"*. An instrument that shows a control it cannot honour is a lying
instrument.

The wire vocabulary already exists and this document does not invent a second
one: the five-state support ladder (`unavailable | implemented | enabled |
capable | certified`) and the three-value probe evidence (`present | absent |
unknown`) live in
[`packages/rpc/src/schemas/capability-modules.schema.ts`](packages/rpc/src/schemas/capability-modules.schema.ts),
resolved by
[`packages/rpc/src/capabilities/capability-matrix.ts`](packages/rpc/src/capabilities/capability-matrix.ts).
The matrix below is the **render contract** over those values.

| Operation state | Evidence | Render | Reason text | Never |
|---|---|---|---|---|
| **Positively unsupported** | probe `absent`, or claim `unavailable` because the modem lacks it | **Not rendered at all** — no row, no ghost, no tooltip | none (nothing is shown) | never a disabled control, never a greyed placeholder |
| **Supported but temporarily blocked** | claim ≥ `capable`, current availability refused (streaming active, lease held, transition in progress, gate held, lockout) | **Visible + `disabled`/`aria-disabled` + an on-screen reason**, adjacent to the control | required, keyed i18n copy naming the refusal AND what the operator can do | never a bare disabled control with no reason; never a toast-only reason |
| **Unknown** | probe `unknown`, claim `enabled`, provider unreachable, read failed | **Visibly distinct pending/diagnostic state** — a `role="status"` "Checking…" / "Not reported" affordance | reads as *not determined*, e.g. "Not reported by this modem" | **never rendered as unsupported**, never hidden, never silently defaulted to off/false |
| **Not shipped in this build** | claim `unavailable` because the module is absent from the build | Not rendered | none | never a coming-soon pill invented for it (a `ComingSoon` pill needs an `open` register entry, per `docs/TECHNICAL_DEBT.md`) |

Hard rules, each individually checkable:

- **CT-1** — a positively-unsupported operation contributes **zero** DOM nodes.
  Check: query the control's `data-testid`; expect count `0`.
- **CT-2** — a temporarily-blocked control is present, is disabled, and has a
  reason element whose text is non-empty and resolves through i18n (no raw token,
  no `undefined`). Check: element present + `disabled`/`aria-disabled="true"` +
  sibling `[data-testid$="-reason"]` with non-empty text.
- **CT-3** — an unknown state renders a node that is **distinguishable from both**
  the supported and the unsupported renderings, e.g. a distinct
  `data-state="unknown"` attribute. Check: DOM assertion that the unknown
  rendering's marker attribute differs from the disabled-supported one.
- **CT-4** — **no fake control.** A disabled control may exist only when the
  claim is ≥ `capable`. Check: for each fixture where the claim is `unavailable`,
  assert no disabled control for that module exists.
- **CT-5** — unknown never degrades on retry. Re-rendering with the same unknown
  evidence must not flip to the unsupported (hidden) rendering. Check: two
  renders, same DOM shape.

Gate host: extend the existing capability-truthfulness regression gate
[`apps/frontend/tests/e2e/truthfulness.spec.ts`](apps/frontend/tests/e2e/truthfulness.spec.ts)
— **extend it, do not fork it** (repo house rule).

---

## 2. Information hierarchy

Traces to `.impeccable.md` Principle 1 (*status is primary; configuration is
contextual*) and Principle 4 (*Live-Data Discipline*).

Visual priority, highest first, within any modem / cellular / router-dongle row
or dialog:

1. **State** — connected / registered / no SIM / locked / blocked / recovering.
2. **Signal** — bars/percent + carrier + registration quality, with its
   provenance and freshness.
3. **Action** — the affordances the operator can take right now (connect, retry,
   configure, unlock, acknowledge).
4. **Identity** — the operator-meaningful device name.
5. **Hardware tags** — model, firmware revision, IMEI, USB composition, band
   labels, `ID_PATH`, interface name.

Rules:

- **IH-1** — no hardware tag may appear above the first state/signal/action
  element in DOM order within a row. Check: DOM-order assertion per row fixture.
- **IH-2** — hardware tags render at a demoted weight: smaller size, muted
  foreground, never the row's largest text and never in the phosphor-lime accent
  (the accent is reserved for the *live* signal per `.impeccable.md`).
- **IH-3** — a row must be readable at a glance without expanding anything: state
  and signal are always visible; hardware tags may collapse behind a disclosure.
- **IH-4** — staleness beats freshness theatre: a stale reading renders as stale
  (dimmed/marked), never as a fresh-looking number (`.impeccable.md` Principle 4).
- **IH-5** — Fill with lime (the primary color) only the single primary action of a
  surface; other actions on that surface use outline or ghost. This holds on every
  surface, not only modem rows; a destructive confirmation keeps its `destructive`
  button. In System Logs, Storage Save and the logs toolbar's Export logs are
  filled and every other action, Support bundle included, is outline or ghost;
  Follow stays outline, because a filled lime button reads as going live (DF-32).
- **IH-6** — every link row on the Network destination (Wi-Fi, Cellular, Ethernet,
  an active hotspot, a Bluetooth device) is ONE component,
  `apps/frontend/src/main/network/NetworkRow.svelte`, so its order is the rule
  above made structural: title line (dot or device glyph · name · identity pill ·
  signal), status line (glyph + state word · facts, then the bond switch at its
  trailing edge, so every section's switches form one column), hardware tags,
  reason lines, actions. The dot is anchored to the title's first line, and from
  36rem of row width the actions move to the title line, in the DOM as well, so
  the focus order is the reading order at every width. Pills remain only for an
  exception that must stand out (No SIM, roaming, stale, Shared LAN, an unclaimed
  cellular device's class); reason lines and hardware tags use full
  `text-muted-foreground` (≥ 4.5:1), never a fainter alpha.

---

## 3. Operator label rules

Traces to `.impeccable.md` *"every indicator reads at a glance, every action is
unambiguous"*, and to the established repo rule that engine/machine tokens are
never rendered raw (config-change reasons are keyed copy, not raw tokens).

- **OL-1** — **no raw USB-mode tokens** in operator-facing text. Values like
  `hilink`, `rndis`, `ecm`, `mbim`, `qmi`, `ppp`, `0x1506`, or a raw composition
  id must not appear in a label, heading, badge, summary, or error string.
  Operator copy names the *behaviour*: "Router mode" / "Modem mode" / "Switching
  connection mode…".
- **OL-2** — **no raw band tokens** in operator-facing text. `eutran-3`,
  `B20`, `n78`, `LTE_BAND_7`, and equivalents are diagnostics. Operator copy uses
  the generation and, when useful, a human band name resolved through i18n.
- **OL-3** — raw values are **not deleted, they are relocated**. Every suppressed
  raw token must remain readable in a diagnostics panel/block (the router-dongle
  details block, the modem diagnostics disclosure, or the downloadable log), so
  a field engineer loses nothing.
- **OL-4** — a diagnostics block is explicitly marked as such (a heading or
  `data-testid` containing `diagnostic`) and is collapsed by default.
- **OL-5** — an unmapped token is never printed raw as a fallback. The fallback
  is honest generic copy plus a pointer to the diagnostics block — mirroring the
  existing `configChangeReport` rule (unmapped reason → keyed copy → log pointer,
  never the engine's raw string).

Check: a grep/DOM gate over operator-facing strings and rendered labels for the
banned token shapes, with the diagnostics subtree excluded by selector.

---

## 4. Breakpoints

Traces to `.impeccable.md` *Responsive* ("genuinely adapted layouts per context",
mobile field / tablet event / desktop studio, 1024×600 kiosk a real target).

Three mandatory verification widths:

| Width | Context | Requirement |
|---|---|---|
| **375 px** | phone, field use | single column; no horizontal scroll; no truncated state or signal; actions reachable one-handed |
| **768 px** | tablet, event management | two-column where it earns it; dialogs are sheets or centred per the existing `AppDialog` rule; touch sizing holds |
| **1280 px** | desktop, studio | full density; no stretched single-column artefacts; no orphaned whitespace column |

- **BP-1** — at **each** of the three widths, zero horizontal overflow on the
  modem/cellular/network surfaces.
- **BP-2** — no state, signal, or action element is clipped or `text-overflow`-
  truncated to unreadability at any of the three widths. Hardware tags MAY
  truncate (they are the demoted tier, §2) provided the full value stays
  available in diagnostics (§3 OL-3). On the Network destination (IH-6 rows and
  Bonded Links alike), names and identity facts WRAP and never truncate; only a
  mono machine identifier that repeats a value shown in full may keep one line,
  with its full value in the row's accessible name.
- **BP-3** — the 1024×600 kiosk viewport is verified as an additional case
  because `.impeccable.md` names it a real target; it does not replace any of the
  three above.

---

## 5. Locales, RTL, CJK

CeraUI ships **10 locales** — the catalogs in
[`packages/i18n/messages/`](packages/i18n/messages/):

| Code | Language | Notes |
|---|---|---|
| `en` | English | base |
| `es` | Spanish | |
| `de` | German | longest compounds — worst case for label overflow |
| `fr` | French | |
| `pt-BR` | Portuguese (Brazil) | |
| `ar` | Arabic | **RTL** |
| `hi` | Hindi | tall glyphs / matra clipping |
| `ja` | Japanese | CJK |
| `ko` | Korean | CJK |
| `zh` | Chinese | CJK |

- **LO-1** — every new or changed operator-facing string exists in **all 10**
  catalogs. A missing key is a failing gate, not a fallback.
- **LO-2** — **no string concatenation** to build a sentence. Interpolation via
  the message catalog only, so RTL and CJK word order stay translatable.
- **LO-3** — **RTL (`ar`)**: layout mirrors correctly — no hardcoded `left`/
  `right` where `start`/`end` is meant, no icons that imply direction rendering
  unmirrored, no numeric/unit pair (e.g. signal %, Mbps) that reorders into
  nonsense, and no checked switch thumb outside its track. Verify at 375 and 1280.
- **LO-4** — **CJK (`ja`/`ko`/`zh`)**: no clipped glyphs, no forced mid-word
  breaks that split a token, adequate line-height. `.impeccable.md` states Space
  Grotesk lacks CJK glyphs and system fallbacks are used — verify the fallback
  actually renders (no tofu) in the modem surfaces.
- **LO-5** — **long-string handling**: `de` and `hi` are the overflow probes. A
  long label wraps or truncates *by design* with the full value available
  (tooltip or diagnostics), never overlapping a neighbour and never pushing a
  row into horizontal overflow.
- **LO-6** — a **reason string** (§1 CT-2) is subject to all of the above: a
  blocked control in `ar` at 375 px must still show a readable reason.

---

## 6. Touch / kiosk target sizes

Traces to `.impeccable.md` Principle 5 (*Touch-Inclusive by Default*, 44 px
minimum) and the existing `[data-layout-mode='touch']` token layer in
`apps/frontend/src/app.css` (`--touch-target-min: 44px`).

- **TT-1** — in touch/kiosk layout mode every interactive element on the
  modem/cellular/network surfaces has a hit area of **≥ 44 × 44 px**. This
  includes small controls: signal-detail toggles, diagnostics disclosures,
  acknowledge buttons, per-band chips.
- **TT-2** — adjacent interactive elements have **≥ 8 px** of separation so a
  fingertip cannot straddle two destructive-adjacent actions.
- **TT-3** — the existing token layer is the mechanism. Do **not** hardcode
  `44px` in a component; route through `--touch-target-min` / the touch-mode
  selectors already in `app.css`.
- **TT-4** — a **disabled** control (§1) still occupies its full target size —
  it must not shrink, because a shrinking control is a layout jump when the
  block clears.
- **TT-5** — verified at the 1024×600 kiosk viewport in touch mode, not only in
  default mode.
- **TT-6** — every Network row (IH-6) is a `data-touch-region`, so on a phone
  (below 40rem) the same token layer lifts its buttons to 44 px and grows its
  switch's hit area, in the default layout mode as well as in touch mode.

---

## 7. Reduced motion

Traces to `.impeccable.md`'s instrument register: motion is a signal, not
decoration, and the interface must "never surprise them at a critical moment".

- **RM-1** — every animation, transition, pulse, spinner, and sparkline
  animation on these surfaces respects `prefers-reduced-motion: reduce`.
- **RM-2** — under reduced motion, **no information is lost**. A pulsing "live"
  or "checking" indicator degrades to a static, still-distinguishable state
  (colour/shape/text), never to nothing. This is the reduced-motion form of the
  §1 unknown-state rule: the pending state must remain visibly distinct.
- **RM-3** — no auto-scrolling, no attention-grabbing looping motion on a
  blocked/refused control; the reason text carries the message.
- **RM-4** — reduced motion is verified as a **rendered state**, not asserted
  from CSS source: run the surfaces with the media feature emulated and confirm
  the states remain distinguishable.

---

## 8. Live regions (ARIA)

Traces to `.impeccable.md`'s "the operator feels the stream is in good hands" —
an outcome the operator cannot see is an outcome that did not happen.

Three outcome classes on these surfaces need announcement: **GPS** (enable /
fix acquired / no fix / expiry / disable), **FCC** auto-unlock, and
**router-write** results (net-mode write, subnet hygiene rewrite, rollback).

- **LR-1** — one dedicated live region per surface, mounted **before** any
  outcome can fire. A region created at announcement time announces nothing.
- **LR-2** — politeness: routine progress and success use
  `role="status"` / `aria-live="polite"`. Failures, refusals, and rollback
  outcomes use `role="alert"` / `aria-live="assertive"`. Nothing on these
  surfaces uses `assertive` for a success.
- **LR-3** — every terminal outcome announces **exactly once**. No repeat on
  re-render, no silent swallow when the client attached mid-operation (the
  established "event fired before anyone was listening" defect class — adopt the
  outcome, don't drop it).
- **LR-4** — announcement text is keyed i18n copy and obeys §3: no raw USB-mode
  token, no raw band token, no engine/provider raw string.
- **LR-5** — an in-flight operation announces its start (polite) *and* its
  terminal outcome. A bounded operation that times out announces the timeout —
  silence is never the terminal state.
- **LR-6** — a **write** outcome (router write, band write, GPS enable) states
  whether the device state actually changed: applied / refused / reverted. A
  refusal that never began must not be announced as a failure that changed
  something (mirrors the `change_rejected` ≠ `rollback_failed` rule).

---

## 9. The four bounded UI passes

**Bounded** is the operative word. Each pass has a fixed scope and a stop
condition that a reviewer or a test run can mark pass/fail. A pass that has met
its stop condition is **done** — further polishing inside that pass is out of
scope and belongs to a later pass or a new todo. This is the
`STANDARDS-CHARTER.md` "gate is the deliverable" model applied to UI work.

Passes run in order. A later pass never re-opens an earlier pass's decisions
unless it produces a concrete defect; in that case the defect is fixed in place,
not by re-running the earlier pass.

### Pass 1 — shape / hierarchy

**Scope.** Row and dialog structure for modem, cellular, router-dongle, and the
network sections that host them: what is rendered, in what order, at what
visual weight, and with what operator label. No new capability, no new RPC, no
visual-world change.

**Does.** Applies §1 (matrix), §2 (hierarchy), §3 (labels).

**STOP when ALL of:**
1. Every operation state in the §1 matrix has a DOM-truthfulness assertion in
   the truthfulness gate, and all of them pass (CT-1 … CT-5).
2. Zero raw USB-mode tokens and zero raw band tokens appear in any
   operator-facing string or rendered label outside a marked diagnostics block
   (grep + DOM gate, §3).
3. Every row satisfies IH-1 (no hardware tag before the first state/signal/action
   element in DOM order) under the fixture set.
4. `bun run --filter frontend test` and `bun run lint` are green.

### Pass 2 — implementation critique

**Scope.** Review-only over what Pass 1 produced. Reads the code and the rendered
result against this document. Produces a written finding list; fixes only
findings it raises.

**Does.** Verifies Pass 1's rules were implemented as rules (shared helpers, no
per-surface re-derivation), that no capability decision is duplicated outside
`capability-matrix.ts`, and that no reason string bypasses i18n.

**STOP when ALL of:**
1. A written finding list exists, and every finding is either **fixed** or
   **explicitly deferred with a named owner todo** — zero findings left in an
   undecided state.
2. Zero duplicated capability-decision logic: the render surfaces call the shared
   resolver; a grep for a second local re-derivation of the support ladder or the
   render predicate returns nothing.
3. Every §1 reason string and every §8 announcement string resolves through the
   i18n catalog (no literal user-facing string in a component).
4. Pass 1's stop-condition checks still pass after the fixes.

**Where a deferred finding is recorded.** Condition 1's "explicitly deferred with a
named owner todo" is satisfied by an entry in
[`docs/DESIGN-FOLLOWUPS.md`](docs/DESIGN-FOLLOWUPS.md). That file — not
`docs/TECHNICAL_DEBT.md` — is the register for design findings, because the
technical-debt ledger is marker-bound and requires a non-prose `exit_criteria`
(see [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) → Technical-Debt Register). A
design finding that ships no `data-debt-id` belongs here.

### Pass 3 — harden / adapt

**Scope.** Responsive, locale, touch/kiosk, reduced-motion, and live-region
behaviour. No structural redesign — Pass 1 owns shape.

**Does.** Applies §4 (breakpoints), §5 (locales/RTL/CJK), §6 (touch/kiosk),
§7 (reduced motion), §8 (live regions).

**STOP when ALL of:**
1. Zero horizontal overflow and zero unreadable clipping of state/signal/action
   at **375, 768, and 1280 px**, plus the 1024×600 kiosk viewport (BP-1…BP-3).
2. Every new/changed key exists in **all 10** catalogs (`en, es, de, fr, pt-BR,
   ar, hi, ja, ko, zh`); the `ar` RTL pass shows no mirroring defect and the
   `ja`/`ko`/`zh` pass shows no tofu and no clipped glyph; `de`/`hi` long strings
   neither overlap nor overflow (LO-1…LO-6).
3. In touch layout mode every interactive element on these surfaces measures
   ≥ 44 × 44 px with ≥ 8 px separation, disabled controls included (TT-1…TT-5).
4. With `prefers-reduced-motion: reduce` emulated, every state that motion
   previously distinguished remains distinguishable statically (RM-1…RM-4).
5. GPS, FCC, and router-write outcomes each announce exactly once with the
   correct politeness, verified against a mounted live region (LR-1…LR-6).
6. The frontend a11y checks in the existing suite are green.

### Pass 4 — visual QA confirmation

**Scope.** Confirmation only. **No new features, no new rules, no redesign.**
Captures evidence that Passes 1–3 hold in a real rendered browser, fixes only
defects the capture reveals.

**Does.** Batched capture — desktop and mobile together, all three breakpoints,
LTR and RTL, default and touch mode — one inspection round, one batched fix
round, at most one confirming round. Then stop.

**STOP when ALL of:**
1. Screenshots exist for the modem/cellular surfaces at **375 / 768 / 1280** in
   `en` and `ar`, plus one CJK locale, plus the 1024×600 kiosk touch view, all
   written to a repo-local gitignored `test-results/` path (Rule D — never a path
   above the repo root).
2. Every defect found in the first inspection round is fixed, and the single
   confirming round shows **zero remaining** capability-truth, hierarchy, label,
   overflow, or clipping defects.
3. The full affected gate is green: `bun run lint`, the frontend typecheck,
   `bun run --filter frontend test`, the backend tests, `check:tech-debt`, and
   the truthfulness e2e spec.
4. Evidence is recorded. **No third inspection round** — if round two still shows
   defects, they are written up as a follow-up todo rather than absorbed into an
   open-ended polish loop.

---

## 10. Cross-check against `.impeccable.md`

Read after writing this document; every claim traced.

| `.impeccable.md` statement | DESIGN.md treatment | Verdict |
|---|---|---|
| Brand "Ground Control", graphite + phosphor lime, OKLCH tokens | Not restated, not altered. §2 IH-2 only *reserves* the lime accent for the live signal, which is what `.impeccable.md` already calls "the live signal color" | consistent |
| Space Grotesk + JetBrains Mono, system fallbacks for CJK/Arabic | §5 LO-4 verifies that stated fallback renders; it does not change the font stack | consistent |
| Anti-references (glassmorphism, gradient text, side-stripe accents, generic SaaS patterns) | Not contradicted — this document adds no decorative surface | consistent |
| Principle 1 Instrument Clarity — status primary, config contextual | §2 hierarchy puts state/signal/action above hardware tags; §1 forbids controls that misreport | derives |
| Principle 2 Dark-First Hero | Untouched; §4/§5 verification applies to both themes without changing which is hero | consistent |
| Principle 3 Dialog-Driven Configuration | §4 keeps dialogs on the existing `AppDialog` pattern; no inline mega-form is introduced | consistent |
| Principle 4 Live-Data Discipline — never show misleading fresh-looking data | §2 IH-4 (stale reads stale) and §1 (unknown never renders as unsupported) are the same rule applied to capability state | derives |
| Principle 5 Touch-Inclusive, 44 px minimum | §6 adopts 44 px verbatim and routes through the existing `--touch-target-min` token | consistent |
| Responsive: mobile/tablet/desktop, 1024×600 kiosk a real target, "not shrink the desktop" | §4 fixes 375/768/1280 as the verification widths and keeps kiosk as an additional named case | derives |
| Emotional goal: "the interface never surprises them at a critical moment" | §1 (no fake controls), §8 (every outcome announced) are the enforcement of it | derives |

**Contradictions found: zero.** Every rule above either restates an
`.impeccable.md` principle in checkable form or adds a truthfulness/structure
rule `.impeccable.md` does not speak to. No rule in this document loosens,
overrides, or reverses anything in `.impeccable.md`.

---

## 11. What this document does NOT do

- Does not replace or extend the visual world (colour, type, motion vocabulary) —
  that is `.impeccable.md`'s.
- Does not migrate a CSS framework or redesign the app shell, HUD, or the three
  destinations.
- Does not define a second capability vocabulary. The ladder and the evidence
  enum live in `packages/rpc` and this document only says how to *render* them.
- Does not authorise a fifth pass. If work remains after Pass 4's confirming
  round, it becomes a new todo.

## 12. Media telemetry extension

The media-load hint and detail dialog extend Ground Control without new tokens.
They reuse `AppDialog`, the ghost `Button`, Space Grotesk labels, JetBrains Mono
measurements, `text-xs`/`text-sm`/`text-base`, the existing spacing ramp and semantic
foreground/muted/primary colors. Positive load may use primary; unknown values
are proportional text, never bars or zeros. MPP percentages remain unbounded.

The hint is a compact set of per-group tables, with aligned numeric columns and
data-derived counts. Session ownership and complete identifiers live in the
explicitly opened detail surface. It has one body scroll owner (AppDialog), a
pinned close button, inherited keyboard/focus behavior, and no mutation controls.
On narrow screens each core's session list wraps below its two metrics; at wider
sizes it shares their row. Accounting and ownership caveats precede the rows.

Device Health widens only on a non-empty block snapshot to fit the data-derived
groups at kiosk width; absent blocks keep the established legacy geometry. No new
animation is added. Existing reduced-motion and e-ink chrome rules apply.
Acceptance requires desktop/mobile rendered evidence; both-board visual acceptance
is a separate, outstanding hardware gate, not a property of the mock fixture.

## 13. Live session source switching

The live selector reuses the existing Card, Button, kind badge and Active affirmation;
no new tokens or motion. Only engine-reported session legs enter the new target set.
An absent roster retains legacy capture admission and states that targets are not
reported; an explicit empty roster states that no session switches are available and
offers no action. Both notices use muted, wrapping `text-sm` with `role="status"`.
Synthetic legs are labeled with the translated Test Pattern name and their session
identifier in both the selector and live summary. Labels never authorize a switch.
The existing two-source threshold remains; the active row is an affirmation, not a
button. Browser acceptance covers 375/768/1280 px and both switch directions;
hardware/color qualification remains separate and unclaimed.

## 14. Update credentials row

The Updates dialog's credentials row adds no tokens, motion or primitive. It is
one bordered `rounded-lg` row with the Connection section's finding-row anatomy
(`px-4 py-3`, a `text-sm` semibold label beside a status `Badge`, then a muted
`text-xs` detail line with the `·` separator). The badge word carries the
state; the `success`/`warning`/`error`/`neutral` pill tint and a Lucide shield
glyph (check, alert, x, question) in that tone only reinforce it, and "unknown"
is neutral, never an alarm. The badge word itself uses `text-foreground`: the
shared status-pill text tones measured below WCAG AA 4.5:1 for `error` (light
and dark, until `app.css` mixed that tone toward the foreground) and `neutral`
(dark), and axe fails them on this surface; the glyph
needs only the 3:1 non-text ratio. Other Badge call sites are unchanged. The
remaining-days phrase is the only foreground text in the detail line. The row
is a labelled `role="group"`, wraps instead of overflowing in every locale,
and is absent rather than empty for an older backend. Acceptance: 390/1280 px,
light and dark, plus Arabic RTL, in `apps/frontend/tests/e2e/visual/update-system.visual.spec.ts`; a
real device certificate is not part of that evidence.

## 15. Kernel update section

The Kernel section extends the existing System image section without new tokens,
primitives or motion. It uses the shared Button and Progress, `text-sm` labels,
`text-xs` monospaced versions, semantic foreground/muted colors, `rounded-lg`
definition rows and the existing spacing ramp. Status precedes running/update
versions and the actions. Long translated state/reason text wraps; phone actions
stack with the existing touch-size token layer. State is conveyed by words, not
color alone. Routine changes use a persistent polite status region.

Layout: a stacked definition list and action row inside AppDialog's existing
body scroller, matching SystemSection; no new scroll owner, fixed panel or
activation control. Desktop uses the existing centered dialog and mobile the
existing sheet, with the close control pinned by AppDialog.

The primary action installs the offered kernel; Check is secondary. No kernel
capability means no section. Unknown state remains unknown, active/staged work
disables conflicting actions, and rollback shows its reason beside the versions.
Acceptance is the 1280x800/390x844, light/dark, English/es-419 state matrix in
`apps/frontend/tests/e2e/visual/kernel-updates.visual.spec.ts`, with actions and the entire section
required to be in frame for staged and rolled-back captures. Device producer
integration and hardware rollback are separate qualification.

## 16. Colors

A record of the shipped code for agents building new screens, not a second
authority: `.impeccable.md` still owns the look, sections 1 to 15 still own the
rules, and a value that differs here is stale. Dark is the hero, light is
first-class. Values are copied from @ceralive/design-tokens 2026.6.1 (the
version pinned in `bun.lock`), file `tokens.css`, which
`apps/frontend/src/app.css` imports into its base layer.
`apps/frontend/tailwind.config.ts` exposes them as utilities (`bg-card`,
`text-muted-foreground`). Use the token, never a copied value. A palette swap
redefines the variable, so a literal would not follow it.

### Surfaces and text

`secondary`, `muted` and `accent` are neutral graphite steps, not brand colors.

Source: `tokens.css` in the package above.

| Token | Light | Dark |
|---|---|---|
| `--background` | `oklch(0.98 0.004 150)` | `oklch(0.15 0.012 150)` |
| `--foreground` | `oklch(0.15 0.015 150)` | `oklch(0.95 0.008 150)` |
| `--card` | `oklch(0.96 0.004 150)` | `oklch(0.18 0.01 150)` |
| `--card-foreground` | `oklch(0.15 0.015 150)` | `oklch(0.95 0.008 150)` |
| `--popover` | `oklch(0.98 0.003 150)` | `oklch(0.2 0.01 150)` |
| `--popover-foreground` | `oklch(0.15 0.015 150)` | `oklch(0.95 0.008 150)` |
| `--secondary` | `oklch(0.93 0.005 150)` | `oklch(0.24 0.012 150)` |
| `--secondary-foreground` | `oklch(0.22 0.014 150)` | `oklch(0.9 0.008 150)` |
| `--muted` | `oklch(0.92 0.005 150)` | `oklch(0.22 0.01 150)` |
| `--muted-foreground` | `oklch(0.42 0.018 150)` | `oklch(0.62 0.015 150)` |
| `--accent` | `oklch(0.9 0.006 150)` | `oklch(0.26 0.012 150)` |
| `--accent-foreground` | `oklch(0.18 0.016 150)` | `oklch(0.92 0.008 150)` |

### Primary and destructive

Lime is `primary`; IH-5 decides which button may be filled with it, and IH-2 keeps it off hardware tags.

Source: `tokens.css` in the package above.

| Token | Light | Dark |
|---|---|---|
| `--primary` | `oklch(0.4 0.18 128)` | `oklch(0.86 0.2 128)` |
| `--primary-foreground` | `oklch(0.98 0.003 0)` | `oklch(0.1 0.02 150)` |
| `--ring` | `oklch(0.4 0.18 128)` | `oklch(0.86 0.2 128)` |
| `--destructive` | `oklch(0.55 0.22 25)` | `oklch(0.56 0.22 25)` |
| `--destructive-foreground` | `oklch(0.98 0.004 0)` | `oklch(0.98 0.004 0)` |

### Borders and control state

Source: `tokens.css` in the package above.

| Token | Light | Dark |
|---|---|---|
| `--border` | `oklch(0.88 0.006 150)` | `oklch(0.28 0.012 150)` |
| `--input` | `oklch(0.9 0.005 150)` | `oklch(0.24 0.01 150)` |
| `--switch-off` | `oklch(0.66 0.022 150)` | `oklch(0.52 0.028 150)` |
| `--switch-off-foreground` | `oklch(0.99 0.004 150)` | `oklch(0.96 0.008 150)` |

### Status

Source: `tokens.css` in the package above.

| Token | Light | Dark |
|---|---|---|
| `--status-success` | `oklch(0.5 0.15 150)` | `oklch(0.8 0.18 145)` |
| `--status-success-foreground` | `oklch(0.99 0.003 0)` | `oklch(0.15 0.02 150)` |
| `--status-info` | `oklch(0.5 0.16 245)` | `oklch(0.74 0.13 230)` |
| `--status-info-foreground` | `oklch(0.99 0.003 0)` | `oklch(0.15 0.02 230)` |
| `--status-warning` | `oklch(0.52 0.13 65)` | `oklch(0.8 0.16 75)` |
| `--status-warning-foreground` | `oklch(0.99 0.003 0)` | `oklch(0.2 0.04 75)` |
| `--status-error` | `oklch(0.55 0.22 25)` | `oklch(0.64 0.2 25)` |
| `--status-error-foreground` | `oklch(0.99 0.004 0)` | `oklch(0.99 0.004 25)` |
| `--status-neutral` | `oklch(0.45 0.018 150)` | `oklch(0.62 0.015 150)` |
| `--status-neutral-foreground` | `oklch(0.99 0.003 0)` | `oklch(0.12 0.02 150)` |
| `--status-live` | `oklch(0.45 0.16 128)` | `oklch(0.86 0.2 128)` |
| `--status-standby` | `oklch(0.55 0.14 70)` | `oklch(0.8 0.16 75)` |
| `--status-idle` | `oklch(0.55 0.01 150)` | `oklch(0.45 0.01 150)` |

### Signal quality

Source: `tokens.css` in the package above.

| Token | Light | Dark |
|---|---|---|
| `--signal-excellent` | `oklch(0.5 0.16 145)` | `oklch(0.82 0.2 128)` |
| `--signal-good` | `oklch(0.52 0.15 110)` | `oklch(0.78 0.18 100)` |
| `--signal-fair` | `oklch(0.55 0.14 75)` | `oklch(0.76 0.16 75)` |
| `--signal-weak` | `oklch(0.52 0.18 30)` | `oklch(0.6 0.16 35)` |

### Link identity

These are read as CSS variables; `apps/frontend/tailwind.config.ts` maps no utility for them.

Source: `tokens.css` in the package above.

| Token | Light | Dark |
|---|---|---|
| `--link-1` | `oklch(0.55 0.17 128)` | `oklch(0.84 0.2 128)` |
| `--link-2` | `oklch(0.55 0.15 200)` | `oklch(0.76 0.18 188)` |
| `--link-3` | `oklch(0.52 0.16 252)` | `oklch(0.72 0.16 252)` |
| `--link-4` | `oklch(0.5 0.18 292)` | `oklch(0.74 0.18 292)` |
| `--link-5` | `oklch(0.58 0.16 65)` | `oklch(0.78 0.18 65)` |
| `--link-6` | `oklch(0.55 0.2 20)` | `oklch(0.7 0.18 15)` |
| `--link-bar-empty` | `color-mix(in oklab, var(--muted-foreground) 55%, transparent)` | `color-mix(in oklab, var(--muted-foreground) 55%, transparent)` |

### Sidebar

Source: `tokens.css` in the package above.

| Token | Light | Dark |
|---|---|---|
| `--sidebar-background` | `oklch(0.94 0.005 150)` | `oklch(0.13 0.01 150)` |
| `--sidebar-foreground` | `oklch(0.22 0.014 150)` | `oklch(0.88 0.008 150)` |
| `--sidebar-primary` | `oklch(0.4 0.18 128)` | `oklch(0.86 0.2 128)` |
| `--sidebar-primary-foreground` | `oklch(0.98 0.003 0)` | `oklch(0.1 0.02 150)` |
| `--sidebar-accent` | `oklch(0.9 0.006 150)` | `oklch(0.22 0.01 150)` |
| `--sidebar-accent-foreground` | `oklch(0.22 0.014 150)` | `oklch(0.88 0.008 150)` |
| `--sidebar-border` | `oklch(0.86 0.006 150)` | `oklch(0.26 0.01 150)` |
| `--sidebar-ring` | `oklch(0.4 0.18 128)` | `oklch(0.86 0.2 128)` |

### Elevation and gradient endpoints

Source: `tokens.css` in the package above.

| Token | Light | Dark |
|---|---|---|
| `--shadow-sm` | `0 1px 2px 0 oklch(0.15 0.015 150 / 0.08)` | `0 1px 2px 0 oklch(0 0 0 / 0.4)` |
| `--shadow-md` | `0 4px 12px -2px oklch(0.15 0.015 150 / 0.1)` | `0 4px 8px -2px oklch(0 0 0 / 0.45)` |
| `--shadow-lg` | `0 12px 28px -6px oklch(0.15 0.015 150 / 0.14)` | `0 12px 28px -6px oklch(0 0 0 / 0.55)` |
| `--gradient-primary-to` | `oklch(0.45 0.15 150)` | `oklch(0.72 0.16 150)` |
| `--gradient-success-to` | `oklch(0.45 0.14 165)` | `oklch(0.68 0.15 165)` |
| `--gradient-info-to` | `oklch(0.45 0.16 255)` | `oklch(0.6 0.15 255)` |
| `--gradient-destructive-to` | `oklch(0.48 0.2 15)` | `oklch(0.5 0.18 15)` |
| `--gradient-warning-to` | `oklch(0.5 0.13 60)` | `oklch(0.7 0.15 55)` |

### App-level color overrides

Each row is a rule in `apps/frontend/src/app.css`, which overrides the utility or token it names.

| Case | Value |
|---|---|
| Red text, `.text-destructive` | `color-mix(in oklab, var(--destructive) 74%, var(--foreground))` |
| Red status text, `.text-status-error` | `color-mix(in oklab, var(--status-error) 84%, var(--foreground))` |
| Red status inside a tooltip | `color-mix(in oklab, var(--status-error) 44%, var(--background))` |
| Destructive button label | `color-mix(in oklab, var(--destructive) 60%, var(--foreground))` |
| E-ink and mono, `html[data-theme='eink']` | a chroma 0 set that redefines the tokens, defined in that block |
| High contrast, `@media (prefers-contrast: more)` | `--border: var(--foreground)`, `--muted-foreground: var(--foreground)` |

- **Not defined in code:** a secondary brand hue, and any Svelte call site for the
  `gradient-primary`, `gradient-success`, `gradient-info`,
  `gradient-destructive` and `gradient-warning` utilities in
  `apps/frontend/src/app.css`. Don't read the endpoints as an invitation to add one.

## 17. Typography

Families come from `apps/frontend/tailwind.config.ts`; `apps/frontend/src/main.ts`
imports both font packages, so they're served locally. Sizes, line heights and
weights are Tailwind CSS 4.3.5 defaults (the version pinned in `bun.lock`, file
`theme.css`), which CeraUI doesn't override.

### Families

| Role | Stack | Source |
|---|---|---|
| Sans, the page default | `Space Grotesk Variable`, `Space Grotesk`, then `Noto Sans CJK SC`, `Microsoft YaHei`, `Hiragino Sans`, `Noto Sans JP`, `Noto Sans KR`, `Noto Sans Arabic`, `Tahoma`, `system-ui`, `sans-serif` | `apps/frontend/tailwind.config.ts` |
| Mono, telemetry and machine values | `JetBrains Mono Variable`, then the Tailwind mono stack (`...fontFamily.mono`) | `apps/frontend/tailwind.config.ts` |

`apps/frontend/src/app.css` sets `font-synthesis-weight: none` on the body, so a
missing weight is never faked.

### Sizes

| Utility | Size | Line height | Source |
|---|---|---|---|
| `text-micro` | `calc(var(--text-xs, 0.75rem) - 0.125rem)` | `1rem` | `apps/frontend/src/app.css` |
| `text-xs` | `0.75rem` | `calc(1 / 0.75)` | `theme.css` |
| `text-sm` | `0.875rem` | `calc(1.25 / 0.875)` | `theme.css` |
| `text-base` | `1rem` | `calc(1.5 / 1)` | `theme.css` |
| `text-lg` | `1.125rem` | `calc(1.75 / 1.125)` | `theme.css` |
| `text-xl` | `1.25rem` | `calc(1.75 / 1.25)` | `theme.css` |
| `text-2xl` | `1.5rem` | `calc(2 / 1.5)` | `theme.css` |
| `text-3xl` | `1.875rem` | `calc(2.25 / 1.875)` | `theme.css` |
| `text-4xl` | `2.25rem` | `calc(2.5 / 2.25)` | `theme.css` |

### Weights

| Utility | Weight | Source |
|---|---|---|
| `font-normal` | `400` | `theme.css` |
| `font-medium` | `500` | `theme.css` |
| `font-semibold` | `600` | `theme.css` |
| `font-bold` | `700` | `theme.css` |

### Observed use

- Dialog title: `text-base leading-tight font-semibold`; its description: `text-muted-foreground text-sm leading-relaxed`. Source: `apps/frontend/src/lib/components/dialogs/AppDialog.svelte`
- Card title: `text-base leading-snug font-medium`. Source: `apps/frontend/src/lib/components/ui/card/card-title.svelte`
- Field label: `text-sm leading-none font-medium`. Source: `apps/frontend/src/lib/components/ui/label/label.svelte`
- Throughput value: `font-mono text-xs font-bold tabular-nums`. Source: `apps/frontend/src/lib/components/custom/Badge.svelte`
- Network row name: `text-sm font-medium`; its status line: `text-muted-foreground` and `text-xs`. Source: `apps/frontend/src/main/network/NetworkRow.svelte`
- **Not defined in code:** a named role scale (display, headline, title, body, label). Pick the utility the nearest existing component uses.

## 18. Components

Shared primitives live in `apps/frontend/src/lib/components/ui/`, composed ones in
`apps/frontend/src/lib/components/custom/` and
`apps/frontend/src/lib/components/dialogs/`. Reuse them before adding one. Corner
steps derive from `--radius` (`0.5rem` in `tokens.css`): `rounded-lg` is
`var(--radius)`, `rounded-md` is `calc(var(--radius) - 2px)` and `rounded-xl` is
`calc(var(--radius) + 4px)`, set in `apps/frontend/tailwind.config.ts`.

The `default` Button variant is the filled lime one. IH-5 governs it: one per
surface, for its single primary action. Other actions are outline or ghost, and a
destructive confirmation keeps its `destructive` button.

| Component | Binds to | Source |
|---|---|---|
| Button, shape and focus | `rounded-lg` `text-sm` `font-medium`; focus `focus-visible:border-ring` `focus-visible:ring-ring` at 50% `focus-visible:ring-3`; disabled `disabled:opacity-50` | `apps/frontend/src/lib/components/ui/button/button.svelte` |
| Button `default` | `bg-primary` `text-primary-foreground` | `apps/frontend/src/lib/components/ui/button/button.svelte` |
| Button `outline` | `border-border` `bg-background` `hover:bg-muted` `dark:bg-input` at 30% | `apps/frontend/src/lib/components/ui/button/button.svelte` |
| Button `secondary` | `bg-secondary` `text-secondary-foreground` `hover:bg-secondary` at 80% | `apps/frontend/src/lib/components/ui/button/button.svelte` |
| Button `ghost` | `hover:bg-muted` `hover:text-foreground` | `apps/frontend/src/lib/components/ui/button/button.svelte` |
| Button `destructive` | `bg-destructive` at 10% `hover:bg-destructive` at 20% `dark:bg-destructive` at 20%, with the label override in section 16 | `apps/frontend/src/lib/components/ui/button/button.svelte` |
| Button `link` | `text-primary` `underline-offset-4` `hover:underline` | `apps/frontend/src/lib/components/ui/button/button.svelte` |
| Button sizes | `xs` `h-6`, `sm` `h-7`, `default` `h-8`, `lg` `h-9`, `icon` `size-8`; touch targets follow section 6 | `apps/frontend/src/lib/components/ui/button/button.svelte` |
| Card | `bg-card` `text-card-foreground` `ring-foreground` at 10% `ring-1` `rounded-xl` `py-4` `gap-4` | `apps/frontend/src/lib/components/ui/card/card.svelte` |
| Card content | `px-4` | `apps/frontend/src/lib/components/ui/card/card-content.svelte` |
| Card footer | `bg-muted` at 50% `border-t` `p-4` | `apps/frontend/src/lib/components/ui/card/card-footer.svelte` |
| Input | `border-input` `bg-transparent` `dark:bg-input` at 30% `rounded-lg` `h-8` `px-2.5` `text-base` `md:text-sm`; placeholder `placeholder:text-muted-foreground`; error `aria-invalid:border-destructive` | `apps/frontend/src/lib/components/ui/input/input.svelte` |
| Textarea | `border-input` `rounded-lg` `min-h-16` `px-2.5` `py-2` | `apps/frontend/src/lib/components/ui/textarea/textarea.svelte` |
| Select trigger | `border-input` `bg-transparent` `rounded-lg` `text-sm` `data-[size=default]:h-8` | `apps/frontend/src/lib/components/ui/select/select-trigger.svelte` |
| Select popup | `bg-popover` `text-popover-foreground` `ring-foreground` at 10% `rounded-lg` `shadow-md` | `apps/frontend/src/lib/components/ui/select/select-content.svelte` |
| Select option | `data-highlighted:bg-accent` `data-highlighted:text-accent-foreground` `rounded-md` `text-sm` | `apps/frontend/src/lib/components/ui/select/select-item.svelte` |
| Switch, off | `background-color: var(--switch-off)`; thumb `background-color: var(--switch-off-foreground)` | `apps/frontend/src/app.css` |
| Switch, on | `background-color: var(--primary)`; thumb `background-color: var(--primary-foreground)` | `apps/frontend/src/app.css` |
| Checkbox, checked | `background-color: var(--primary)` `color: var(--primary-foreground)` | `apps/frontend/src/app.css` |
| Toggle, pressed | `background-color: var(--foreground)` `color: var(--background)` | `apps/frontend/src/app.css` |
| Labeled slider | track `bg-muted`, range `bg-primary`, thumb `border-ring` `bg-white` `size-3` | `apps/frontend/src/lib/components/custom/LabeledSlider.svelte` |
| Progress | track `bg-muted` `h-1`, fill `bg-primary` | `apps/frontend/src/lib/components/ui/progress/progress.svelte` |
| Dialog surface | `bg-popover` `text-popover-foreground` `ring-foreground` at 10% `rounded-xl` `ring-1` | `apps/frontend/src/lib/components/ui/dialog/dialog-content.svelte` |
| AppDialog | header `bg-card` `px-5` `py-4`, footer `bg-muted` at 40%, desktop `sm:max-w-lg`, phone sheet `rounded-t-2xl`, height `max-h-[85svh]` | `apps/frontend/src/lib/components/dialogs/AppDialog.svelte` |
| Popover | `bg-popover` `ring-foreground` at 10% `w-72` `rounded-lg` `p-2.5` `shadow-md` | `apps/frontend/src/lib/components/ui/popover/popover-content.svelte` |
| Tooltip | `bg-foreground` `text-background` `rounded-md` `px-3` `py-1.5` `text-xs` | `apps/frontend/src/lib/components/ui/tooltip/tooltip-content.svelte` |
| Tabs | list `bg-muted` `rounded-lg` `p-[3px]` | `apps/frontend/src/lib/components/ui/tabs/tabs-list.svelte` |
| Status badge | `rounded-md` `px-2` `py-0.5` `text-xs` with `bg-status-success` at 10% `text-status-success`, and the same pair for `warning`, `error`, `info` and `neutral` | `apps/frontend/src/lib/components/custom/Badge.svelte` |
| Skeleton | `bg-muted` `animate-pulse` `rounded-md` | `apps/frontend/src/lib/components/ui/skeleton/skeleton.svelte` |
| Toast | `background: var(--popover)` `border-color: var(--border)` `box-shadow: var(--shadow-lg)` `border-radius: 0.625rem` | `apps/frontend/src/app.css` |
| Link badge | `var(--link-${link.linkIndex + 1})`; row ordinal `text-xs font-bold tabular-nums` | `apps/frontend/src/lib/components/custom/LinkBadge.svelte` |
| Network row | `px-4` `py-2`; IH-6 governs its order | `apps/frontend/src/main/network/NetworkRow.svelte` |
