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

## Producer schema drift — publish before consume

CeraUI consumes four npm producers whose wire data is Zod-validated —
`@ceralive/cerastream`, `@ceralive/srtla-send`, `@ceralive/control-protocol`,
`@ceralive/modem-control`. Each is a **registry** dependency pinned to an exact
version, and that pin is a version boundary as well as a path boundary.

### Why this needs a rule at all

`z.object()` **silently strips** unrecognized keys on `.parse()`. A consumer
pinned to an older binding whose schema does not know a newer producer field
therefore drops that field before any business logic sees it — no error, no
warning, and a green `tsc` whenever the consumer declared its own local type for
the same wire data. It is runtime-only, and it only reproduces on a device.

That is not hypothetical: cerastream PR #126 added `device_address` to
`captureDeviceSchema`, CeraUI PR #303 merged the same day reading
`node.device_address` against a pin whose gitHead predates PR #126, and three
CeraUI modules each carried a local `device_address?: string` — so the field was
stripped on every real board and nothing said so.

### The gate

[`apps/backend/src/tests/producer-schema-drift.test.ts`](../apps/backend/src/tests/producer-schema-drift.test.ts)
holds one manifest of the producer wire-field paths CeraUI reads and asserts, on
the schemas **actually installed in `node_modules`**, that every one of them
resolves. Run it with the rest of the backend suite (`bun test` in
`apps/backend`, and in CI's `test` job).

It names no producer version, deliberately — it must pass against any pin that
carries the manifest's fields. That is what keeps an additive bump a no-op and a
field-retiring bump a loud failure.

### The three rules

1. **Publish before consume.** A producer PR that adds or changes a field in a
   published Zod schema must have its bindings **published** (tag pushed) before
   any CeraUI PR reading that field may merge.
2. **No shadow wire-types.** Import producer-owned wire shapes from the published
   package's own exported types. Never redeclare a local interface for the same
   data — a shadow type is precisely what hides a stale pin from `tsc`.
3. **When you add a read, add the field to the manifest.** The manifest is an
   inventory of real read sites, so a new consumed field belongs there in the same
   change. Do not add a field with no consumer: that turns an unused producer
   field into a merge blocker for a producer that legitimately retires it.

### Verifying against an UNRELEASED producer — the `bun link` workflow

`bun link` is the sanctioned way to try a producer change locally before it is
published. It is **dev-time only**, and the link must never reach a commit.

```bash
# 1. In the producer's own checkout (e.g. ../../cerastream/bindings):
bun link

# 2. In CeraUI's backend workspace:
cd apps/backend && bun link @ceralive/cerastream

# 3. Verify — the drift gate now probes YOUR working tree, which is the point:
bun test src/tests/producer-schema-drift.test.ts
bun test                      # the rest of the backend suite

# 4. UNDO IT before you commit. This is not optional.
bun unlink @ceralive/cerastream
cd ../.. && bun install       # restores the registry-resolved lockfile
```

**Pre-commit check — must be `0`:**

```bash
grep -c 'link:' bun.lock
```

A committed link is how a local verification silently becomes the fleet's
reality: the drift gate would then be probing a developer's working tree instead
of the artifact devices install, and every guarantee above evaporates. A `link:`
in a producer dep is also a Rule-D path reference wearing a registry dep's
clothes — it resolves by filesystem proximity, so CI (which has no sibling
checkout) installs something different from what was tested.

This check is enforced by the same test file rather than by a git hook: the
repo's `pre-commit` hook is best-effort lint only, and CI is the blocking gate.

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
> (only the formatter keeps running, with no parse error). Since Biome 2.5.8 the
> failure mode has changed but is no friendlier: the file stops parsing at all, so
> `"root": false` is lost and the run dies with a misleading *"Found a nested root
> configuration"* error that names neither the comment nor the line. Document rule
> rationale here, not inline in the config.

---

## Svelte lint overrides — why exactly two rules stay off (re-verified 2026-08-21, Biome 2.5.9)

`apps/frontend/biome.json` disables **two** lint rules for `**/*.svelte`, and only two:

| Rule | Status | Why |
|------|--------|-----|
| `correctness/noUnusedVariables` | **off** | Biome does not count template references. |
| `correctness/noUnusedImports` | **off** | Same; Paraglide `m["<key>"]()` imports used only in markup are still missed. |

Biome 2.5.3 (PR #10534) fixed `$store`/`$bindable` false positives **for
`noUnusedVariables` only**, and 2.5.7 (PR #11198, issue #11171) fixed `{@attach}`
for both unused-symbol rules. Both fixes shipped before 2.5.9 — and both are still
too narrow to retire the overrides. Measured on this tree with Biome 2.5.9:

| `biome check .` | Total | `noUnusedVariables` | `noUnusedImports` |
|---|---|---|---|
| overrides IN PLACE (baseline) | 33 warnings + 3 infos | 0 | 2 (both in `.ts`, unaffected by the Svelte override) |
| overrides REMOVED (probe) | 1,933 warnings + 3 infos | **1,142** | **760** |

That is **1,900 new Svelte-only findings**, and they are the same two shapes as
before: Paraglide imports used only in markup (for example
`BufferingIndicator.svelte`'s `m["hud.*"]()` calls) and cascading markup-only
references. The general gap is still open upstream:
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
  Both rules are inert on `.svelte` in Biome 2.5.8/2.5.9: a file carrying textbook
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
delete the two entries from `apps/frontend/biome.json`, run `bunx biome check .`
from the workspace root, and compare against the baseline row in the table above.
Anything in the thousands means the template gap is still open. Restore the file
afterwards; the probe is read-only by intent.
