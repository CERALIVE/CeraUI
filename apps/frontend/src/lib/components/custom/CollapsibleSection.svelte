<!--
  CollapsibleSection.svelte — reusable titled disclosure with a smooth open/close.

  A header button toggles a `bind:open` body. The reveal is a pure CSS
  grid-template-rows 0fr→1fr transition (no fixed height, no JS measuring), so
  arbitrary content animates and the reduced-motion + e-ink CSS in app.css still
  it automatically — never JS-drive this. The body stays in the DOM while
  collapsed (clipped via overflow), so headless renderers and hidden tabs show
  the real content the instant it opens.

  THE BODY IS `inert` WHILE COLLAPSED, and that is what makes "in the DOM but
  clipped" honest rather than a keyboard trap. `overflow: hidden` removes the
  content visually and from the scroll order, but a focusable control inside a
  zero-height grid track is still tabbable — so a keyboard operator would fall
  into a panel they cannot see. `inert` withdraws the whole subtree from focus
  AND from the accessibility tree, which is exactly the semantics a closed
  native `<details>` has. Do NOT swap it for `aria-hidden`: that hides the
  subtree from AT while leaving it focusable, which is the axe `aria-hidden-focus`
  violation rather than a fix for it.

  …AND IT IS `visibility: hidden` TOO, WHICH IS A DIFFERENT PROBLEM. `inert`
  governs focus and the accessibility tree; NEITHER it nor `overflow: hidden`
  withdraws a layout box from HIT TESTING. A collapsed body's controls keep
  full-size rects at their uncollapsed coordinates, so a pointer-driven caller
  is told they are visible and then hit-tests onto whatever is really painted
  there. See the note on the body below for the board measurement, and the
  Cellular row (`main/network/CellularSection.svelte`), which carries the same
  guard on its own copy of this shape.
-->
<script lang="ts">
import { ChevronDown } from '@lucide/svelte';
import type { Snippet } from 'svelte';

import { cn } from '$lib/utils';

interface Props {
	title: string;
	open?: boolean;
	/** Optional secondary line under the title, naming what is inside. */
	description?: string;
	/** Optional leading glyph before the title. */
	icon?: Snippet;
	/** Optional trailing content in the header (e.g. a status badge). */
	headerAdornment?: Snippet;
	children: Snippet;
	class?: string;
	/**
	 * DOM id of the body, wired to the trigger's `aria-controls`. Required for
	 * the disclosure to announce what it expands; omit only for a decorative use.
	 */
	bodyId?: string;
	/** `data-testid` on the section, the trigger and the body respectively. */
	testid?: string;
	toggleTestid?: string;
	bodyTestid?: string;
}

let {
	open = $bindable(false),
	title,
	description,
	icon,
	headerAdornment,
	children,
	class: className,
	bodyId,
	testid,
	toggleTestid,
	bodyTestid,
}: Props = $props();
</script>

<section
	class={cn('bg-card/40 overflow-hidden rounded-lg border', className)}
	data-collapsible-section
	data-testid={testid}
>
	<button
		type="button"
		aria-controls={bodyId}
		aria-expanded={open}
		class="flex min-h-[44px] w-full items-center justify-between gap-2 px-4 py-3 text-start text-sm font-medium"
		data-collapsible-trigger
		data-testid={toggleTestid}
		onclick={() => (open = !open)}
	>
		<span class="flex min-w-0 items-center gap-2">
			{#if icon}{@render icon()}{/if}
			<span class="min-w-0">
				<span class="block truncate">{title}</span>
				{#if description}
					<span class="text-muted-foreground block text-xs font-normal">
						{description}
					</span>
				{/if}
			</span>
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
		data-testid={bodyTestid}
		id={bodyId}
		inert={!open}
		style:grid-template-rows={open ? '1fr' : '0fr'}
	>
		<!-- `overflow: hidden` clips PAINTING, not layout: every control in here
		     keeps a full-size box at its uncollapsed position, so a collapsed
		     body's buttons report a non-empty rect from inside a zero-height
		     grid track. Measured on the board through the Cellular row's own
		     copy of this shape, `open-router-admin` read 173x32 at y=1433 while
		     its clipping ancestor was 0px tall — which is why Playwright called
		     it "visible, enabled and stable" and then hit-tested onto whatever
		     is genuinely painted at those coordinates, retrying "intercepts
		     pointer events" forever rather than failing. `visibility` is
		     inherited and removes the subtree from hit testing, and it
		     TRANSITIONS: an endpoint of `visible` holds for the whole duration,
		     so the close still animates alongside the row collapse and the open
		     is instant. Being pure CSS, both motion freezes still cover it.
		     `inert` is NOT redundant with it — that governs focus and the
		     accessibility tree, this governs painting and hit testing. -->
		<div
			class="min-h-0 overflow-hidden transition-[visibility] duration-200"
			style:visibility={open ? 'visible' : 'hidden'}
		>
			<div class="border-t px-4 py-4">
				{@render children()}
			</div>
		</div>
	</div>
</section>
