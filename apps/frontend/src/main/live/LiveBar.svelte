<script lang="ts">
/**
 * LiveBar — the Live screen's one action, fixed to the bottom of the viewport
 * (Live screen contract, "The Live bar").
 *
 * Idle it carries the readiness line (the first blocking reason from
 * `deriveGoLiveReadiness`, or the ready text) and Start; live, the bitrate
 * control and Stop; in the post-stream summary window, Done. The host passes the
 * action in as children and the line as `status` — this bar derives nothing.
 *
 * It stays where the order puts it in the DOM (focus and reading order follow
 * the contract) and is lifted out of the flow with `position: fixed`: at the
 * viewport bottom under desktop chrome, directly above the fixed mobile dock
 * otherwise. While mounted it publishes its own height as `--live-bar-height` on
 * the document root, so the cockpit's bottom padding and the toast stack clear
 * it at whatever height its content wraps to.
 */
import type { Snippet } from 'svelte';

import { publishHeight } from '$lib/layout';

interface Props {
	/** The idle readiness line: a blocking reason, or the ready text. */
	status?: string;
	/** Whether `status` is a blocking reason. */
	blocked?: boolean;
	children: Snippet;
}

const { status, blocked = false, children }: Props = $props();

const HEIGHT_PROPERTY = '--live-bar-height';

let bar: HTMLDivElement | undefined = $state();

// Every consumer reads an unpublished height as 0px.
$effect(() => (bar ? publishHeight(bar, HEIGHT_PROPERTY) : undefined));
</script>

<div
	bind:this={bar}
	class="live-bar bg-background fixed inset-x-0 z-30 border-t"
	data-state={status === undefined ? undefined : blocked ? 'blocked' : 'ready'}
	data-testid="live-bar" data-touch-region
>
	<!-- Below 640 px the line takes the full width above the action: a blocking
	     reason runs to 84 characters (fr), more than two lines beside the button. -->
	<div
		class="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-6 lg:max-w-6xl"
	>
		{#if status !== undefined}
			<!-- Two lines are always reserved, so a reason that wraps never moves the bar. -->
			<p class="flex min-h-10 min-w-0 items-start gap-2 text-sm sm:flex-1" aria-live="polite">
				<span
					class="mt-1.5 size-2 shrink-0 rounded-full"
					style="background: {blocked ? 'var(--destructive)' : 'var(--status-success)'};"
					aria-hidden={true}
				></span>
				<span class="line-clamp-2 min-w-0">{status}</span>
			</p>
		{/if}
		{@render children()}
	</div>
</div>

<style>
	/* KEEP IN SYNC with DESKTOP_CHROME_QUERY ($lib/layout): below it MainView
	   mounts the fixed mobile dock, whose height `--mobile-dock-height` carries. */
	.live-bar {
		bottom: calc(var(--mobile-dock-height) + env(safe-area-inset-bottom, 0px));
	}

	/* While the bar is on screen, a control reached with Tab or scrolled into view
	   stops above it instead of under it (WCAG 2.4.11): the document's scroll
	   padding covers everything fixed below the content. */
	:global(html:has(.live-bar)) {
		scroll-padding-bottom: calc(
			var(--live-bar-height, 0px) + var(--mobile-dock-height) + env(safe-area-inset-bottom, 0px)
		);
	}

	@media (min-width: 1024px), (min-width: 768px) and (max-height: 600px) {
		.live-bar {
			bottom: 0;
			padding-bottom: env(safe-area-inset-bottom, 0px);
		}

		:global(html:has(.live-bar)) {
			scroll-padding-bottom: var(--live-bar-height, 0px);
		}
	}
</style>
