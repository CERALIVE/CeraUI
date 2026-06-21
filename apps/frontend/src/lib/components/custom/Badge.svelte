<!--
  Badge.svelte — unified, variant-driven badge for the former three badge components.

  Replaces SpeedBadge / StaleBadge / StatusBadge. The `variant` prop selects one of
  three families, each reproducing the EXACT markup of the component it replaces
  (no visual change):

    • speed                                      → throughput value (former SpeedBadge):
        font-mono tier-coloured number that dims when `stale`.
    • stale                                      → per-interface staleness marker
        (former StaleBadge): warning pill + Clock glyph + i18n copy.
    • success | warning | error | info | neutral → semantic status pill
        (former StatusBadge): variant-coloured pill with optional icon/label/children.
        An unrecognized value renders as `neutral`.

  Every family is static (no animation), so all three are safe under the e-ink
  freeze. Extra attributes (`data-testid`, aria-*, …) pass through to the status
  family via `...rest`, preserving the existing per-call-site test hooks.
-->
<script lang="ts" module>
export type StatusVariant = 'success' | 'warning' | 'error' | 'info' | 'neutral';
export type BadgeVariant = 'speed' | 'stale' | StatusVariant;
</script>

<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Clock } from '@lucide/svelte';
import type { Snippet } from 'svelte';

import { formatThroughput, speedTier } from '$lib/helpers/network-speed';
import { cn } from '$lib/utils';

interface Props {
	/** Badge family; for the status family it is also the semantic colour. */
	variant?: BadgeVariant | (string & {});
	/** speed: throughput in kilobits per second. `null` renders a muted placeholder. */
	kbps?: number | null;
	/** speed: dim the badge when the underlying reading is no longer fresh. */
	stale?: boolean;
	/** stale: the interface whose telemetry aged past the staleness threshold. */
	'data-stale-interface'?: string;
	/** status: text label; ignored when a `children` snippet is supplied. */
	label?: string;
	/** status: optional leading glyph (e.g. a Lucide icon). */
	icon?: Snippet;
	/** status: badge body; overrides `label` when present. */
	children?: Snippet;
	/** status: `micro` uses the 0.625rem telemetry size; `sm` (default) uses text-xs. */
	size?: 'sm' | 'micro';
	class?: string;
	[key: string]: unknown;
}

const STATUS_CLASS: Record<StatusVariant, string> = {
	success: 'bg-status-success/10 text-status-success',
	warning: 'bg-status-warning/10 text-status-warning',
	error: 'bg-status-error/10 text-status-error',
	info: 'bg-status-info/10 text-status-info',
	neutral: 'bg-status-neutral/10 text-status-neutral',
};

const SPEED_TIER_CLASS: Record<'weak' | 'fair' | 'good', string> = {
	weak: 'text-signal-weak',
	fair: 'text-signal-fair',
	good: 'text-signal-good',
};

let {
	variant = 'neutral',
	kbps = null,
	stale = false,
	'data-stale-interface': staleInterface = undefined,
	label,
	icon,
	children,
	size = 'sm',
	class: className = undefined,
	...rest
}: Props = $props();

// speed family
const speedEmpty = $derived(kbps === null || !Number.isFinite(kbps));
const speedLabel = $derived(formatThroughput(kbps));
const speedColor = $derived(
	speedEmpty ? 'text-muted-foreground' : SPEED_TIER_CLASS[speedTier(kbps)],
);

// status family — an unrecognized variant falls back to `neutral`
const resolvedStatus = $derived<StatusVariant>(
	typeof variant === 'string' && variant in STATUS_CLASS
		? (variant as StatusVariant)
		: 'neutral',
);
</script>

{#if variant === 'speed'}
	<span
		data-live-value
		class={cn(
			'inline-flex items-center font-mono text-xs font-bold tabular-nums transition-opacity',
			speedColor,
			stale && 'opacity-50',
			className,
		)}
		aria-label={speedLabel}
		title={speedLabel}
	>
		{speedLabel}
	</span>
{:else if variant === 'stale'}
	<span
		class={cn(
			'bg-status-warning/10 text-status-warning inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium',
			className,
		)}
		data-stale-interface={staleInterface}
		title={$LL.network.view.staleHint()}
	>
		<Clock class="size-3" aria-hidden="true" />
		{$LL.network.view.stale()}
	</span>
{:else}
	<span
		{...rest}
		data-status-badge={resolvedStatus}
		class={cn(
			'inline-flex w-fit items-center gap-1 rounded-md font-medium',
			size === 'micro' ? 'text-micro px-1.5 py-0.5' : 'px-2 py-0.5 text-xs',
			STATUS_CLASS[resolvedStatus],
			className,
		)}
	>
		{#if icon}{@render icon()}{/if}
		{#if children}{@render children()}{:else if label}{label}{/if}
	</span>
{/if}
