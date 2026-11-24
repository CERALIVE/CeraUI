<!--
  NetworkRow — the one row anatomy every row on the Network destination uses
  (Wi-Fi, Cellular, Ethernet, an active hotspot, a Bluetooth device). The
  sections pass content; the row owns the layout:

    ● Title  [identity]                               [signal]
      ✓ State word · facts ………………………………………… [bond switch]
      hardware / link facts (demoted by size, never by contrast)
      reason lines (every disabled control's why, on screen)
      Action ›  Action
    (details body)

  1. The dot is anchored to the title's FIRST line (`0.5lh`), so it cannot
     strand on a line of its own at any width or in any locale.
  2. The title wraps and never truncates; the identity pill drops below it.
  3. The switch trails the status line, so the switches of every section form
     one column beside the state they govern. When status and switch do not
     fit, the switch drops below the status, still trailing — never over text.
  4. The actions own the last line; from 36rem of row width they move to the
     title line's trailing edge. That is a DOM move, not a visual one, so Tab
     reads the row in the order the eye does at every width.
  5. `data-touch-region`: below 40rem every row control takes the 44px target.
-->
<script lang="ts">
import { flushSync, type Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

import { cn } from '$lib/utils';

interface Props extends HTMLAttributes<HTMLDivElement> {
	heading: Snippet;
	/** The status dot's tone (`bg-*`). */
	dotClass?: string;
	/** A glyph in the dot's place (a Bluetooth device type); it is 1rem wide. */
	lead?: Snippet;
	/** A device this stack cannot control: its title steps down to muted. */
	dimmed?: boolean;
	identity?: Snippet;
	indicator?: Snippet;
	status?: Snippet;
	bond?: Snippet;
	meta?: Snippet;
	reasons?: Snippet;
	actions?: Snippet;
	details?: Snippet;
}

const {
	heading,
	dotClass,
	lead,
	dimmed = false,
	identity,
	indicator,
	status,
	bond,
	meta,
	reasons,
	actions,
	details,
	class: className,
	...rest
}: Props = $props();

// The 36rem container query decides; the sentinel only takes width when it matches,
// so the actions can follow it in the DOM. Absent ResizeObserver (jsdom) keeps the phone order.
let sentinel = $state<HTMLElement | null>(null);
let wide = $state(false);
let actionLineEl: HTMLElement | null = null;
const actionControls = (): HTMLElement[] => [
	...(actionLineEl?.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])') ?? []),
];
$effect(() => {
	if (sentinel === null || typeof ResizeObserver === 'undefined') return;
	const observer = new ResizeObserver((entries) => {
		const next = entries.some((entry) => entry.contentRect.width > 0);
		if (next === wide) return;
		// The move remounts the actions: a focused one keeps focus in its new place.
		const focused = actionControls().indexOf(document.activeElement as HTMLElement);
		flushSync(() => {
			wide = next;
		});
		if (focused >= 0) actionControls()[focused]?.focus();
	});
	observer.observe(sentinel);
	return () => observer.disconnect();
});
</script>

{#snippet actionLine(placement: string)}
	<div
		bind:this={actionLineEl}
		class={cn('flex min-w-0 flex-wrap items-center gap-1 empty:hidden', placement)}
		data-net-row-actions
	>
		{@render actions?.()}
	</div>
{/snippet}

<div class={cn('@container/net-row px-4 py-2', className)} data-net-row data-touch-region {...rest}>
	<div
		class={cn(
			'grid items-center gap-x-3 gap-y-1',
			wide ? 'grid-cols-[auto_minmax(0,1fr)_auto]' : 'grid-cols-[auto_minmax(0,1fr)]',
		)}
	>
		<span class={lead ? 'w-4' : 'w-2'} aria-hidden="true"></span>
		<div class="flex min-w-0 items-start gap-3">
			<div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
				<p
					class={cn('relative min-w-0 text-sm font-medium wrap-anywhere', dimmed && 'text-muted-foreground')}
					data-net-row-title
				>
					<span
						class="absolute end-[calc(100%+0.75rem)] top-[0.5lh] flex -translate-y-1/2"
						aria-hidden="true"
						data-net-row-dot
					>
						{#if lead}
							{@render lead()}
						{:else}
							<span class={cn('size-2 rounded-full', dotClass)}></span>
						{/if}
					</span>
					{@render heading()}
				</p>
				{@render identity?.()}
			</div>
			{#if indicator}
				<span class="flex h-5 shrink-0 items-center">{@render indicator()}</span>
			{/if}
		</div>
		{#if actions && wide}
			{@render actionLine('justify-end')}
		{/if}
		{#if status || bond}
			<div class="col-[2/-1] flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
				<div
					class="text-muted-foreground flex min-w-0 flex-[1_1_auto] flex-wrap items-center gap-x-1.5 gap-y-1 text-xs"
					data-net-row-status
				>
					{@render status?.()}
				</div>
				{#if bond}
					<div class="ms-auto" data-net-row-bond>{@render bond()}</div>
				{/if}
			</div>
		{/if}
		{#if meta || reasons}
			<div class="col-[2/-1] min-w-0 space-y-0.5 empty:hidden" data-net-row-body>
				{@render meta?.()}
				{@render reasons?.()}
			</div>
		{/if}
		{#if actions && !wide}
			{@render actionLine('col-start-2 -ms-2.5')}
		{/if}
	</div>
	{@render details?.()}
	<span bind:this={sentinel} class="hidden h-0 @min-[36rem]/net-row:block" aria-hidden="true" data-net-row-wide></span>
</div>
