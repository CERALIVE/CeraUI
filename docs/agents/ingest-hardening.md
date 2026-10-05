<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## INGEST HARDENING [EXISTS]

Quality improvements to the ingest pipeline landed across Tasks 6, 19, and 23.

### Export-failure handling

`IngestStats.svelte` catches `URL.createObjectURL` / `Blob` failures during JSON/CSV
export and renders a calm amber bordered band (`ingest-export-error`) instead of
silently swallowing the error. The error state is driven by a local `exportError`
slot and clears on the next successful export.

### Sparkline memoization (`lib/components/custom/ingest-link-view.ts`)

The per-link SVG sparkline computation is extracted into a pure rune-free module.
`createLinkViewCache()` keeps a `Map<conn_id, {ref, view}>` and recomputes only when
the samples-buffer reference differs from the last call for that `conn_id`. The ring
effect allocates a fresh array only on append (`[...prev, sample]`), so a stable
reference means unchanged samples and a memo hit; a genuinely new sample swaps the
reference and triggers exactly one recompute. The cache is per-component-instance
(freed on unmount) — no module-global state, no unbounded growth.

`EMPTY_SAMPLES` is a shared stable empty buffer so a link awaiting its first frame
is also a memo hit. `RING_CAPACITY` (60 samples), `SPARK_W`, `SPARK_H`, and the
`Sample` / `LinkViewComputed` types are all exported from this module — never
duplicated in the component.

### Visual/UX polish (Task 23)

`IngestStats.svelte` markup was polished without changing any data logic, thresholds,
or `Props`:

- Header: phosphor-lime icon chip + count/sample pill.
- Per-link table: spectral identity dot (CSS `--link-1..6` ramp) before each iface;
  column headers aligned past the dot.
- Sparkline strip: leading `Trend` micro-label (i18n key `live.ingest.trend`, added
  to all 10 locales), taller `h-6`, neutral baseline `<line>` (NOT a second
  `<polyline>` — keeps `spark.locator("polyline").toHaveCount(1)` valid).
- Health verdict: pill with a leading dot (lime healthy, amber degraded).
- Alert + export-error: calm amber bands with icon.
- Summary: stat tiles with icons; drops value goes amber when `> 0`; per-link uptime
  rows gain a `--primary` progress bar.

### @visual spec (`tests/e2e/visual/ingest-states.visual.spec.ts`)

5 desktop visual tests (tag `@visual`): idle / streaming / summary / health-alert /
export-error. Each captures one PNG to `apps/frontend/test-results/`. The export-error
state is driven by overriding `URL.createObjectURL` via `page.evaluate` at click time.

### Ring-buffer lifecycle

The 60-sample ring is per-component-instance `$state<Record<conn_id, Sample[]>>` —
NOT module-global. Verified: fill → unmount → remount starts at 1 sample, not 61.
Per-`conn_id` rings bound independently: two `conn_id`s fed 99 frames each both cap
at exactly 60.

