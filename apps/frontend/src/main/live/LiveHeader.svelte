<script lang="ts">
import { m } from '@ceraui/i18n/svelte';

interface Props {
	isStreaming: boolean;
	/**
	 * The device cannot confirm whether a stream is running (an unconfirmed
	 * lifecycle with `is_streaming` false). The "Not streaming" chip would claim
	 * the opposite of the band below it, so it is withheld; the band is the
	 * role=status statement of what the device knows.
	 */
	unconfirmed?: boolean;
}

const { isStreaming, unconfirmed = false }: Props = $props();
</script>

<!-- Header: stream status + title only (T12 demotion). The server destination now
     lives in the GoLiveCard traffic-light row (T10), so the header no longer hosts
     a server-edit chip — it is title + live-state chip only. -->
<header class="flex items-center gap-3" class:short-live={isStreaming && !unconfirmed}>
	{#if isStreaming}
		<span
			class="flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold tracking-wide uppercase"
			style="color: var(--status-live); border-color: color-mix(in oklab, var(--status-live) 40%, transparent); background-color: color-mix(in oklab, var(--status-live) 12%, transparent);"
		>
			<span
				class="h-2 w-2 rounded-full motion-safe:animate-pulse"
				style="background-color: var(--status-live);"
			></span>
			{m["live.streamingActive"]()}
		</span>
	{:else if !unconfirmed}
		<span
			class="text-muted-foreground flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold tracking-wide uppercase"
		>
			<span class="bg-muted-foreground/50 h-2 w-2 rounded-full"></span>
			{m["live.notStreaming"]()}
		</span>
	{/if}
	<!-- On a phone the bottom nav already says Live and the subtitle carries no
	     state, so below 640 px the header is the state chip alone; the title stays
	     in the page for screen readers and the heading outline. -->
	<div class="min-w-0">
		<h1 tabindex="-1" class={['text-2xl font-bold tracking-tight', isStreaming && !unconfirmed && 'max-sm:not-focus:sr-only']}>{m["live.title"]()}</h1>
		<p class={['text-muted-foreground text-sm', isStreaming && !unconfirmed && 'max-sm:sr-only']}>{m["live.description"]()}</p>
	</div>
</header>

<style>
	@media (orientation: landscape) and (max-height: 420px) and (width < 1024px) {
		.short-live > div:not(:focus-within) {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}
	}

	h1 {
		scroll-margin-block-start: calc(var(--app-header-height, 57px) + var(--offline-bar-height) + var(--top-bands-height) + 0.5rem);
	}
</style>
