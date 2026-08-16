# CeraUI Conventions

**Status:** `[EXISTS]`

CeraUI-local conventions. This file does **not** restate the workspace-wide
documentation contract — for the `[EXISTS]` / `[PARTIAL]` / `[GREENFIELD]` status
labels, line budgets, and naming rules, see the root
[`docs/CONVENTIONS.md`](../../docs/CONVENTIONS.md). Everything below is specific to
the CeraUI repo.

---

## Technical-Debt Register

CeraUI tracks the technical debt that the source-experience overhaul **introduces
or touches** in a single machine-checkable ledger,
[`docs/TECHNICAL_DEBT.md`](TECHNICAL_DEBT.md), enforced in CI by
[`scripts/check-tech-debt.mjs`](../scripts/check-tech-debt.mjs) (the
`check:tech-debt` package script, run in the `test` job of `build-check.yml`). The
gate is **blocking, never advisory** — a malformed entry or an unregistered debt
marker fails the build.

This register **extends**, rather than duplicates, two existing systems:

- It mirrors the deferred-work ledger pattern from
  [`image-building-pipeline/v2/docs/DEFERRED.md`](../../image-building-pipeline/v2/docs/DEFERRED.md)
  (what / why / where / unblock).
- It is **not** the status-label system. Pre-existing `[PARTIAL]` claims in prose
  docs stay governed by the root status-label convention; this register covers only
  overhaul-introduced debt, so it is **not a historical audit**.

### When to add an entry

Add a `` ```debt `` entry whenever the overhaul ships a debt marker that points at
unfinished work:

- a UI element tagged `data-debt-id="TD-NNN"`,
- a `coming-soon` affordance, or
- an in-source `[PARTIAL]` marker (under `apps/*/src` or `packages/*/src`).

Every such marker MUST reference an `open` entry by id; a `coming-soon` / `[PARTIAL]`
marker must sit on a line that also carries a `data-debt-id="TD-NNN"`. An orphan
marker (no matching `open` entry) fails CI.

### Entry contract

Each entry is a fenced `` ```debt `` block with exactly nine fields — `id`, `title`,
`track`, `status`, `exit_criteria`, `owner`, `registered_at`, `resolved_at`,
`unblock`. The full field contract (allowed values, the `exit_criteria` must be an
executable command or `capability:` / `PR #` reference — never prose, and the
`resolved` ⇒ non-null `resolved_at` rule) lives at the top of
[`docs/TECHNICAL_DEBT.md`](TECHNICAL_DEBT.md). Do not invent a parallel ledger;
add to that file.

### Resolving debt

Resolving a debt item means **removing every source marker** that referenced it,
then flipping its entry to `status: resolved` with a real `resolved_at` date. The
gate then confirms there are no orphan markers left pointing at it.

---

## Biome reliability rules (S4)

CeraUI layers three reliability rules on top of the shared `@ceralive/biome-config`
(`extends`). They are enforced by `bunx biome check .`, wired into the `test` job of
`build-check.yml`. The shared config is **never** edited for these — they live only
in CeraUI's local configs.

| Rule | Level | Notes |
|------|-------|-------|
| `suspicious/noEmptyBlockStatements` | **error** | No silent catches. Mark an intentional empty block with an inline comment inside it (Biome's prescribed form). |
| `suspicious/noConsole` | **error** | `console.warn` / `console.error` allowed; `console.log`/`debug`/`info` rejected. |
| `nursery/noFloatingPromises` | **warn** | Staged / report-only — see rationale below. |

**These rules live in all FOUR local configs**, not just the root `biome.json`. A
nested config (`apps/backend`, `apps/frontend`, `packages/i18n`) has `"root": false`
and **no** `"extends"`, so it inherits only Biome `recommended` — NOT the root's
custom rules. Putting these rules only in the root would leave the device control
plane ungated. Test files (`**/*.test.ts`, `**/*.spec.ts`) relax the two error rules
via an `overrides` entry (empty mock stubs and test console output are legitimate).

**`noFloatingPromises` is staged at `warn`, not `error`, on purpose.** With the rule
actually applied the report-only count is **55 (> the ~50 promotion threshold)**, and
the signal itself is unreliable: Biome's cross-module type inference cannot see that an
imported `async` function returns a Promise, so it under-reports (the T1 audit measured
0). The codebase already carries 462 `void ` suppressions guarding this class.
Promotion to `error` is deferred until Biome resolves imported-async returns or a typed
`tsc` pass is wired.

> **Never put `//` or `/* */` comments in any CeraUI `biome.json`.** Biome 2.5.0
> silently drops the entire `linter.rules` block when the config contains a comment
> (only the formatter keeps running, with no parse error). Under Biome 2.5.8 the
> failure mode has changed but is no friendlier: the file stops parsing at all, so
> `"root": false` is lost and the run dies with a misleading *"Found a nested root
> configuration"* error that names neither the comment nor the line. Document rule
> rationale here, not inline in the config.

---

## Svelte lint overrides — why exactly two rules stay off (2026-08-14)

`apps/frontend/biome.json` disables **two** lint rules for `**/*.svelte`, and only two:

| Rule | Status | Why |
|------|--------|-----|
| `correctness/noUnusedVariables` | **off** | Biome does not count template references. |
| `correctness/noUnusedImports` | **off** | Same; Paraglide `m["<key>"]()` imports used only in markup are still missed. |

Biome 2.5.3 (PR #10534) fixed `$store`/`$bindable` false positives **for
`noUnusedVariables` only**, and 2.5.7 (PR #11198, issue #11171) fixed `{@attach}`
for both unused-symbol rules. Both fixes are in 2.5.8 — and both are too narrow to
retire the overrides. Re-enabling the pair on this tree currently produces **1,739
errors and 13 warnings** in `apps/frontend`; the errors include Paraglide imports
used only in markup (for example `BufferingIndicator.svelte`'s `m["hud.*"]()` calls)
and cascading markup-only references. The general gap is still open upstream:
[biomejs/biome#8590](https://github.com/biomejs/biome/issues/8590) ("Support for
cross language lint rules"), with
[#9193](https://github.com/biomejs/biome/issues/9193) (namespace import used as
`<Tabs.Root />`), [#10081](https://github.com/biomejs/biome/issues/10081) (symbol used
only inside an attribute string) and
[#11215](https://github.com/biomejs/biome/issues/11215) (`class:` / `style:`
shorthand) as open instances.

Two false-positive shapes dominate, and both must be gone before this is revisited:

1. **Markup-only references.** Anything a component declares in `<script>` and uses
   only in markup is reported unused — that is most of a Svelte component.
   Paraglide imports such as `import { m } from '@ceraui/i18n/svelte'` are reported
    unused when their `m["<key>"]()` calls appear only in markup; for example,
    `BufferingIndicator.svelte` uses `m["hud.buffering"]()` and related keys in its
    template. This is the current Paraglide-specific reproduction of the historical
    typesafe-i18n store-import false positive.
2. **Cascading false positives.** A symbol referenced *only* from inside another
   symbol that is itself markup-only is flagged too. `SettingsView.svelte`'s icon
   imports (`Cloud`, `Radio`, …) are used at `icon: Cloud` inside the `groups`
   array — but `groups` is consumed by an `{#each}`, so Biome calls `groups` unused
   and then every icon it names unused as well.

**The other three rules from the historical override list are gone for two different
reasons, both verified by probe rather than assumed:**

- `correctness/noUnusedFunctionParameters` — **genuinely re-enabled.** It runs on
  `.svelte`, and re-enabling it found exactly one real finding (a vestigial
  `filename` parameter in `dev-tools/screenshot-utility.svelte`), now fixed.
- `style/useImportType` and `style/useConst` — **the overrides were dead config.**
  Both rules are inert on `.svelte` in Biome 2.5.8: a file carrying textbook
  violations of each reports nothing even when the rules are set to `"error"`
  directly in `apps/frontend/biome.json`, while the identical violations fire at
  `error` in a `.ts` file. This is rule-specific, not a blanket "no `style` rules on
  Svelte" — `style/noNonNullAssertion` does fire on `.svelte`. Disabling a rule that
  never ran bought nothing, so the entries were removed rather than carried forward.

**The formatter override on the same block is unrelated and stays.** Biome's
experimental HTML formatter rewrites the `<script>` block to double quotes and cannot
parse Svelte control flow, so `.svelte` markup is still formatted by the Svelte VS
Code extension. Nothing above changes that.

**Before re-attempting this:** re-read #8590 first. The check is a single command —
delete the two entries, run `bunx biome check .`, and compare the count against the
37-warning baseline. Anything in the thousands means the template gap is still open.
