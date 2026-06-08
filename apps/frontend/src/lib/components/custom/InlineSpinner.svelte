<!--
  InlineSpinner.svelte — the one in-flight indicator for the app.

  A single, consistent spinner so no action ever looks frozen: every section's
  loading / refreshing / connecting state renders the same glyph + optional
  label, announced to assistive tech via role="status" + aria-live="polite".
  `animate-spin motion-reduce:animate-none` honours reduced-motion; under the
  e-ink display profile the global `animation:none` rule freezes it to a static
  glyph (no smearing), which is why no JS-driven animation is used here.
-->
<script lang="ts">
import { Loader2 } from '@lucide/svelte';

import { cn } from '$lib/utils';

interface Props {
	/** Visible + accessible label describing the in-flight action. */
	label: string;
	/** Hide the label visually but keep it for screen readers. */
	labelHidden?: boolean;
	size?: 'sm' | 'md';
	class?: string;
	'data-testid'?: string;
}

const {
	label,
	labelHidden = false,
	size = 'sm',
	class: className = undefined,
	'data-testid': testid = undefined,
}: Props = $props();

const glyph = $derived(size === 'md' ? 'size-4' : 'size-3.5');
</script>

<span
	class={cn('text-status-info inline-flex items-center gap-1.5 text-xs font-medium', className)}
	data-testid={testid}
	role="status"
	aria-live="polite"
>
	<Loader2 class={cn(glyph, 'shrink-0 animate-spin motion-reduce:animate-none')} aria-hidden="true" />
	<span class={labelHidden ? 'sr-only' : undefined}>{label}</span>
</span>
