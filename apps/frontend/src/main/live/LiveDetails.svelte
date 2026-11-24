<script lang="ts">
/**
 * LiveDetails — the engineering half of the live telemetry, folded on phones.
 *
 * Below 1024 px the encoder load, the per-link round-trip times, retransmits,
 * weights and trend lines sit behind one "Details" disclosure, closed by
 * default; the streamer's choice is kept on this device
 * (`ceraui.live.detailsOpen`). From 1024 px it is always open and its summary
 * is not shown, so the desktop screen is unchanged. The breakpoint is the
 * width-only one LiveGlance uses, so the two always agree (an 800x480 kiosk is
 * below it). In the post-stream summary window it is forced open and its toggle
 * is hidden, because the summary is the only thing on screen; the stored choice
 * applies again afterwards.
 *
 * The content stays mounted while folded: `IngestStats` keeps its session
 * rollup across the streaming→stopped flip only if it is never remounted.
 */
import { m } from '@ceraui/i18n/svelte';
import { ChevronDown } from '@lucide/svelte';
import type { Snippet } from 'svelte';

import { WIDE_DESKTOP_QUERY } from '$lib/layout';

interface Props {
	/** Keep it open whatever the stored choice (the post-stream summary). */
	forceOpen?: boolean;
	children: Snippet;
}

const { forceOpen = false, children }: Props = $props();

const DETAILS_OPEN_KEY = 'ceraui.live.detailsOpen';

function readStored(): boolean | undefined {
	try {
		const value = localStorage.getItem(DETAILS_OPEN_KEY);
		return value === 'true' ? true : value === 'false' ? false : undefined;
	} catch {
		return undefined;
	}
}

function store(open: boolean) {
	try {
		localStorage.setItem(DETAILS_OPEN_KEY, open ? 'true' : 'false');
	} catch {
		/* private mode: the choice lasts for this visit only */
	}
}

const query = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(WIDE_DESKTOP_QUERY) : undefined;
let wide = $state(query?.matches ?? false);
let stored = $state(readStored());

$effect(() => {
	if (!query) return;
	const onChange = () => (wide = query.matches);
	query.addEventListener('change', onChange);
	return () => query.removeEventListener('change', onChange);
});

const open = $derived(forceOpen || wide || stored === true);

function chooseDetails(event: MouseEvent) {
	event.preventDefault();
	if (wide || forceOpen) return;
	const summary = event.currentTarget;
	const disclosure = summary instanceof HTMLElement && summary.parentElement;
	if (!(disclosure instanceof HTMLDetailsElement)) return;

	// Use the visible state: a browser reveal can change it without saving.
	const nextOpen = !disclosure.open;
	// Apply even when nextOpen equals the preference and Svelte won't rerender.
	disclosure.open = nextOpen;
	stored = nextOpen;
	store(nextOpen);
}

function handleToggle(event: Event) {
	const el = event.currentTarget;
	// Undo external closes during the post-stream summary without saving them.
	if (forceOpen && el instanceof HTMLDetailsElement && !el.open) el.open = true;
}
</script>

<details class="group" data-live-details {open} ontoggle={handleToggle}>
	<summary
		class="hover:bg-muted/40 flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-1 py-2 lg:hidden [&::-webkit-details-marker]:hidden"
		class:hidden={wide || forceOpen}
		hidden={wide || forceOpen}
		{@attach (summary) => {
			summary.addEventListener('click', chooseDetails);
			return () => summary.removeEventListener('click', chooseDetails);
		}}
	>
		<span class="min-w-0">
			<span class="block text-sm font-medium">{m["live.glance.details"]()}</span>
			<span class="text-muted-foreground block text-xs">{m["live.glance.detailsHint"]()}</span>
		</span>
		<ChevronDown aria-hidden={true} class="size-4 shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
	</summary>
	<div class="flex flex-col gap-3 pt-2 lg:pt-0">
		{@render children()}
	</div>
</details>
