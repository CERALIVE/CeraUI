<!--
  CollapsibleSection.svelte — reusable titled disclosure with a smooth open/close.

  A header button toggles a `bind:open` body. The reveal is a pure CSS
  grid-template-rows 0fr→1fr transition (no fixed height, no JS measuring), so
  arbitrary content animates and the reduced-motion + e-ink CSS in app.css still
  it automatically — never JS-drive this. The body stays in the DOM while
  collapsed (clipped via overflow), so headless renderers and hidden tabs show
  the real content the instant it opens.
-->
<script lang="ts">
import { ChevronDown } from '@lucide/svelte';
import type { Snippet } from 'svelte';

import { cn } from '$lib/utils';

interface Props {
	title: string;
	open?: boolean;
	/** Optional leading glyph before the title. */
	icon?: Snippet;
	/** Optional trailing content in the header (e.g. a status badge). */
	headerAdornment?: Snippet;
	children: Snippet;
	class?: string;
}

let {
	open = $bindable(false),
	title,
	icon,
	headerAdornment,
	children,
	class: className,
}: Props = $props();
</script>

<section class={cn('bg-card/40 overflow-hidden rounded-lg border', className)} data-collapsible-section>
	<button
		type="button"
		aria-expanded={open}
		class="flex min-h-[44px] w-full items-center justify-between gap-2 px-4 py-3 text-start text-sm font-medium"
		data-collapsible-trigger
		onclick={() => (open = !open)}
	>
		<span class="flex min-w-0 items-center gap-2">
			{#if icon}{@render icon()}{/if}
			<span class="truncate">{title}</span>
		</span>
		<span class="flex shrink-0 items-center gap-2">
			{#if headerAdornment}{@render headerAdornment()}{/if}
			<ChevronDown
				aria-hidden={true}
				class={cn(
					'text-muted-foreground size-4 shrink-0 transition-transform',
					open && 'rotate-180',
				)}
			/>
		</span>
	</button>

	<div
		class="grid transition-[grid-template-rows] duration-200 ease-out"
		data-collapsible-body
		data-open={open}
		style:grid-template-rows={open ? '1fr' : '0fr'}
	>
		<div class="min-h-0 overflow-hidden">
			<div class="border-t px-4 py-4">
				{@render children()}
			</div>
		</div>
	</div>
</section>
