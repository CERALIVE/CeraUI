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
