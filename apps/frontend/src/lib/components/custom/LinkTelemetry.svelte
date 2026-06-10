<!--
  LinkTelemetry.svelte — per-link srtla_send telemetry (RTT / NAK / weight).

  Renders the three values for one bonded link, sourced from the backend's
  `status.linkTelemetry` feed (see link-telemetry.ts). Three states:
    • live   — fresh values, a brief phosphor-lime pulse on each change
    • stale  — dimmed values + a StaleBadge marker
    • nodata — `entry` is null/absent: every value reads "--", same row height

  The three cells are ALWAYS rendered (placeholder "--" when no data) so the
  card height never shifts between the empty and populated states.
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { LinkTelemetryEntry } from '@ceraui/rpc/schemas';

import StaleBadge from '$lib/components/custom/StaleBadge.svelte';
import { cn } from '$lib/utils';

interface Props {
	entry: LinkTelemetryEntry | undefined;
	class?: string;
}

const { entry, class: className = undefined }: Props = $props();

const PLACEHOLDER = '--';

const hasData = $derived(entry != null);
const stale = $derived(entry?.stale === true);

// rtt_ms=0 and weight_percent=100 are valid sender constants — render as-is.
const rtt = $derived(hasData ? `${entry?.rtt_ms} ${$LL.units.ms()}` : PLACEHOLDER);
const nak = $derived(hasData ? String(entry?.nak_count) : PLACEHOLDER);
const weight = $derived(hasData ? `${entry?.weight_percent}%` : PLACEHOLDER);
</script>

<dl
	data-testid="link-telemetry"
	data-stale={stale ? 'true' : 'false'}
	class={cn(
		'grid grid-cols-3 gap-x-3 gap-y-0.5 transition-opacity',
		stale && 'opacity-50',
		className,
	)}
	aria-label={$LL.network.view.telemetry()}
>
	<div class="flex min-w-0 flex-col">
		<dt class="text-muted-foreground text-[10px] uppercase tracking-wide">
			{$LL.network.view.rtt()}
		</dt>
		{#key rtt}
			<dd
				data-testid="link-rtt"
				class={cn('value font-mono text-xs tabular-nums', hasData ? 'text-foreground' : 'text-muted-foreground')}
			>
				{rtt}
			</dd>
		{/key}
	</div>

	<div class="flex min-w-0 flex-col">
		<dt class="text-muted-foreground text-[10px] uppercase tracking-wide">
			{$LL.network.view.nak()}
		</dt>
		{#key nak}
			<dd
				data-testid="link-nak"
				class={cn('value font-mono text-xs tabular-nums', hasData ? 'text-foreground' : 'text-muted-foreground')}
			>
				{nak}
			</dd>
		{/key}
	</div>

	<div class="flex min-w-0 flex-col">
		<dt class="text-muted-foreground text-[10px] uppercase tracking-wide">
			{$LL.network.view.weight()}
		</dt>
		{#key weight}
			<dd
				data-testid="link-weight"
				class={cn('value font-mono text-xs tabular-nums', hasData ? 'text-foreground' : 'text-muted-foreground')}
			>
				{weight}
			</dd>
		{/key}
	</div>

	{#if stale}
		<div class="col-span-3 mt-0.5">
			<StaleBadge data-stale-interface={entry?.iface} />
		</div>
	{/if}
</dl>

<style>
	/* Subtle phosphor-lime flash when a value re-renders (keyed remount). Pure
	   CSS so the e-ink display freeze ([data-display='eink']) stills it. */
	.value {
		animation: telemetry-pulse 0.6s ease-out;
	}

	@keyframes telemetry-pulse {
		from {
			color: var(--primary);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.value {
			animation: none;
		}
	}
</style>
