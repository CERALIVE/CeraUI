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
> (only the formatter keeps running, with no parse error). Document rule rationale
> here, not inline in the config.
