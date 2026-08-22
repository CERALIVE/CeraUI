<!--
  DiagnosticsBlock.svelte — the ONE place a raw device token may reach an
  operator surface.

  Every value here is the device's own, verbatim and in its own spelling. A
  diagnostics value that has been tidied is no longer the thing a field engineer
  compares against a vendor table, so nothing in this block reformats, rounds,
  translates or re-cases what it was handed. The labels are translated; the
  values never are.

  ── IT IS WHY EVERY OTHER BLOCK CAN STAY CLEAN ──────────────────────────────

  Raw tokens are RELOCATED here, never deleted. That is the whole bargain: an
  operator reads behaviour everywhere else precisely because the identifiers are
  still on screen, one block away, in full.

  ── A FIELD THE DEVICE DID NOT STATE PRODUCES NO ROW ────────────────────────

  Not a dash, not an empty value. A dash reads as "the device reported nothing
  for this", which is a different claim from "this device has no such field",
  and this block is entitled to neither. When the device stated nothing at all,
  the block says THAT in a sentence rather than rendering an empty frame — an
  empty framed list reads as a failed read.

  Values render `dir="ltr"` in the data face so an RTL locale cannot reorder the
  runs of an identifier, and `break-all` so a long opaque key wraps instead of
  widening the card past its container.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';

import type { DiagnosticsModel, ResolvedDiagnosticRow } from './types';

interface Props {
	diagnostics: DiagnosticsModel;
	/**
	 * Rows a caller resolved itself, appended after the derived ones.
	 *
	 * The seam exists because a caller's own label table may already return
	 * operator strings rather than keys; folding that table in here would make
	 * `derive.ts` locale-aware for no gain.
	 */
	extra?: readonly ResolvedDiagnosticRow[];
	/** Test-id stem. */
	name?: string;
	/** Heading, already localized. Omit for a block whose host already titled it. */
	title?: string;
}

let { diagnostics, extra = [], name = 'modem-diagnostics', title }: Props = $props();

const rows = $derived([
	...diagnostics.rows.map((row) => ({
		id: row.id,
		label: resolveMessageKey(row.labelKey),
		value: row.value,
		note: undefined as string | undefined,
	})),
	...extra.map((row) => ({
		id: row.id,
		label: row.label,
		value: row.value,
		note: row.note,
	})),
]);
</script>

<section class="space-y-1.5" data-testid={name}>
	{#if title}
		<p class="text-muted-foreground text-xs">{title}</p>
	{/if}

	{#if rows.length === 0}
		<p class="text-muted-foreground text-xs" data-testid={`${name}-empty`} role="status">
			{m['network.modem.sections.diagnostics.empty']()}
		</p>
	{:else}
		<dl class="grid gap-1 text-xs">
			{#each rows as row (row.id)}
				<div class="flex flex-wrap items-baseline gap-x-2" data-testid={`${name}-${row.id}`}>
					<dt class="text-muted-foreground shrink-0">{row.label}</dt>
					<dd class="min-w-0 font-mono break-all tabular-nums" dir="ltr">
						{row.value}
						{#if row.note}
							<span class="text-muted-foreground block font-sans break-normal">{row.note}</span>
						{/if}
					</dd>
				</div>
			{/each}
		</dl>
	{/if}
</section>
