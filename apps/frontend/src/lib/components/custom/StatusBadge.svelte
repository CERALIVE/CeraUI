<!--
  StatusBadge.svelte — one badge for every semantic status pill.

  Consolidates the scattered hand-rolled `bg-status-X/10 text-status-X` pills
  (codec acceleration, link health, saved-network, export errors) into a single
  variant-driven component so the status palette reads consistently everywhere.
  An unknown `variant` falls back to `neutral` rather than rendering an unstyled
  (or crashing) badge — callers can pass a runtime string safely.

  Static (no animation), so it is safe under the e-ink freeze. Extra attributes
  (`data-testid`, `title`, aria-*) pass straight through to the span via `...rest`,
  preserving existing per-call-site test hooks.
-->
<script lang="ts" module>
export type StatusVariant = 'success' | 'warning' | 'error' | 'info' | 'neutral';
</script>

<script lang="ts">
import type { Snippet } from 'svelte';

import { cn } from '$lib/utils';

interface Props {
	/** Semantic state. An unrecognized value renders as `neutral`. */
	variant?: StatusVariant | (string & {});
	/** Text label; ignored when a `children` snippet is supplied. */
	label?: string;
	/** Optional leading glyph (e.g. a Lucide icon). */
	icon?: Snippet;
	/** Badge body; overrides `label` when present. */
	children?: Snippet;
	/** `micro` uses the 0.625rem telemetry size; `sm` (default) uses text-xs. */
	size?: 'sm' | 'micro';
	class?: string;
	[key: string]: unknown;
}

const VARIANT_CLASS: Record<StatusVariant, string> = {
	success: 'bg-status-success/10 text-status-success',
	warning: 'bg-status-warning/10 text-status-warning',
	error: 'bg-status-error/10 text-status-error',
	info: 'bg-status-info/10 text-status-info',
	neutral: 'bg-status-neutral/10 text-status-neutral',
};

let {
	variant = 'neutral',
	label,
	icon,
	children,
	size = 'sm',
	class: className,
	...rest
}: Props = $props();

const resolved = $derived<StatusVariant>(
	typeof variant === 'string' && variant in VARIANT_CLASS
		? (variant as StatusVariant)
		: 'neutral',
);
</script>

<span
	{...rest}
	data-status-badge={resolved}
	class={cn(
		'inline-flex w-fit items-center gap-1 rounded-md font-medium',
		size === 'micro' ? 'text-micro px-1.5 py-0.5' : 'px-2 py-0.5 text-xs',
		VARIANT_CLASS[resolved],
		className,
	)}
>
	{#if icon}{@render icon()}{/if}
	{#if children}{@render children()}{:else if label}{label}{/if}
</span>
