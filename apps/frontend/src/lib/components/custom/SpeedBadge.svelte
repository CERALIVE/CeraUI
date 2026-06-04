<script lang="ts">
import { formatThroughput, speedTier } from '$lib/helpers/network-speed';
import { cn } from '$lib/utils.js';

interface Props {
	/** Throughput in kilobits per second. `null` renders a muted placeholder. */
	kbps: number | null;
	/** Dim the badge when the underlying reading is no longer fresh. */
	stale?: boolean;
	class?: string;
}

const { kbps, stale = false, class: className = undefined }: Props = $props();

const tierClass: Record<'weak' | 'fair' | 'good', string> = {
	weak: 'text-signal-weak',
	fair: 'text-signal-fair',
	good: 'text-signal-good',
};

const isEmpty = $derived(kbps === null || !Number.isFinite(kbps));
const label = $derived(formatThroughput(kbps));
const colorClass = $derived(isEmpty ? 'text-muted-foreground' : tierClass[speedTier(kbps)]);
</script>

<span
	data-live-value
	class={cn(
		'inline-flex items-center font-mono text-xs font-bold tabular-nums transition-opacity',
		colorClass,
		stale && 'opacity-50',
		className,
	)}
	aria-label={label}
	title={label}
>
	{label}
</span>
