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
  available in diagnostics (§3 OL-3).
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
  nonsense. Verify at 375 and 1280.
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
