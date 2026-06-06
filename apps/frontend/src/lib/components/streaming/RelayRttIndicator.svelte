<!--
  RelayRttIndicator.svelte — relay round-trip-time quality badge.

  Renders a colored status dot + "{rtt} ms" for a relay server's measured RTT,
  or a neutral "—" placeholder when the reading is absent (the backend omits the
  raw `rtt` field until a measurement exists — see remote-relays.ts buildRelaysMsg).
  Decision D7: the backend sends a raw number, the frontend owns the thresholds
  and the visual mapping so display is decoupled from the wire format.

  Thresholds are kept local on purpose: they are a presentation concern of this
  indicator, not a shared input-validation bound (those live in ValidationAdapter).
-->
<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';

import { cn } from '$lib/utils';

interface Props {
	/** Measured round-trip time in milliseconds. `undefined` → neutral unknown state. */
	rtt?: number;
	class?: string;
}

const { rtt, class: className = undefined }: Props = $props();

// RTT quality bands (ms). ≤ GOOD → green, ≤ FAIR → yellow, above → red.
const RTT_GOOD_MAX = 80;
const RTT_FAIR_MAX = 150;

type Tier = 'good' | 'fair' | 'weak' | 'unknown';

const tier = $derived.by<Tier>(() => {
	if (rtt === undefined || !Number.isFinite(rtt)) return 'unknown';
	if (rtt <= RTT_GOOD_MAX) return 'good';
	if (rtt <= RTT_FAIR_MAX) return 'fair';
	return 'weak';
});

// Reuse the committed design tokens (app.css). Inline `style:color` mirrors the
// existing status pattern in ServerDialog (var(--status-live)); the muted token
// de-emphasizes the unknown state instead of asserting a quality color.
const TIER_COLOR: Record<Tier, string> = {
	good: 'var(--status-success)',
	fair: 'var(--status-warning)',
	weak: 'var(--status-error)',
	unknown: 'var(--muted-foreground)',
};

const color = $derived(TIER_COLOR[tier]);
// Thresholds run on the raw value; the displayed number is rounded so a noisy
// measurement (e.g. 71.3541…) reads as a clean "71 ms". The `rtt === undefined`
// check narrows the type so no cast is needed in the rounded branch.
const label = $derived(
	rtt === undefined || !Number.isFinite(rtt) ? '\u2014' : `${Math.round(rtt)} ${$LL.units.ms()}`,
);
</script>

<span
	data-rtt-tier={tier}
	class={cn('inline-flex items-center gap-1.5 font-mono text-xs tabular-nums', className)}
	style:color
	aria-label={label}
	title={label}
>
	<span aria-hidden="true" class="h-2 w-2 shrink-0 rounded-full" style:background-color={color}
	></span>
	{label}
</span>
