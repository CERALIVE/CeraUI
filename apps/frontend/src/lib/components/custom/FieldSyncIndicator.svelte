<!--
  FieldSyncIndicator.svelte — per-field sync-state affordance (Task 5).

  Renders the lifecycle of one config field's optimistic write, read from the
  per-field sync-state machine (`$lib/rpc/field-sync-state`):

    applying → InlineSpinner   (the one in-flight glyph, role="status")
    applied  → static check    (brief confirmation; decays with the FSM phase)
    failed   → static alert     (calm error affordance)
    pending / idle → nothing    (no chrome until the RPC is actually dispatched)

  Like InlineSpinner and the stale Badge, every visual here is CSS/animation-driven
  (the spinner) or fully static (the check / alert) — NEVER JS-driven — so the
  e-ink display freeze (`app.css` [data-display='eink'] { animation: none }) stills
  the spinner to a static glyph instead of smearing, with no extra handling.

  Labels are passed in (consumer supplies `$LL.*`) so this shared primitive stays
  i18n-agnostic, exactly as InlineSpinner takes its `label`.
-->
<script lang="ts">
import { Check, CircleAlert } from '@lucide/svelte';

import InlineSpinner from '$lib/components/custom/InlineSpinner.svelte';
import { getFieldState } from '$lib/rpc/field-sync-state.svelte';
import { cn } from '$lib/utils';

interface Props {
	/** Field key whose lifecycle phase this indicator reflects. */
	field: string;
	/** Visible + accessible label for the in-flight (`applying`) phase. */
	applyingLabel: string;
	/** Optional confirmation label for the `applied` phase. Omit to show no confirm. */
	appliedLabel?: string;
	/** Optional error label for the `failed` phase. Omit to show no error chrome. */
	failedLabel?: string;
	/** Hide labels visually but keep them for screen readers. */
	labelHidden?: boolean;
	size?: 'sm' | 'md';
	class?: string;
	'data-testid'?: string;
}

const {
	field,
	applyingLabel,
	appliedLabel = undefined,
	failedLabel = undefined,
	labelHidden = false,
	size = 'sm',
	class: className = undefined,
	'data-testid': testid = undefined,
}: Props = $props();

const state = $derived(getFieldState(field));
const glyph = $derived(size === 'md' ? 'size-4' : 'size-3.5');
</script>

{#if state === 'applying'}
	<InlineSpinner
		label={applyingLabel}
		{labelHidden}
		{size}
		class={className}
		data-testid={testid}
	/>
{:else if state === 'applied' && appliedLabel !== undefined}
	<span
		class={cn(
			'text-status-success inline-flex items-center gap-1.5 text-xs font-medium',
			className,
		)}
		data-testid={testid}
		role="status"
		aria-live="polite"
	>
		<Check class={cn(glyph, 'shrink-0')} aria-hidden="true" />
		<span class={labelHidden ? 'sr-only' : undefined}>{appliedLabel}</span>
	</span>
{:else if state === 'failed' && failedLabel !== undefined}
	<span
		class={cn(
			'text-status-warning inline-flex items-center gap-1.5 text-xs font-medium',
			className,
		)}
		data-testid={testid}
		role="status"
		aria-live="polite"
	>
		<CircleAlert class={cn(glyph, 'shrink-0')} aria-hidden="true" />
		<span class={labelHidden ? 'sr-only' : undefined}>{failedLabel}</span>
	</span>
{/if}
