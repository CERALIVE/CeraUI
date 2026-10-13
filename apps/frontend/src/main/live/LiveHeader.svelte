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
<header class="flex items-center gap-3">
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
	<div>
		<h1 class="text-2xl font-bold tracking-tight">{m["live.title"]()}</h1>
		<p class="text-muted-foreground text-sm">{m["live.description"]()}</p>
	</div>
</header>
