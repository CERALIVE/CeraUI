<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';

interface Props {
	isStreaming: boolean;
}

const { isStreaming }: Props = $props();
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
			{$LL.live.streamingActive()}
		</span>
	{:else}
		<span
			class="text-muted-foreground flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold tracking-wide uppercase"
		>
			<span class="bg-muted-foreground/50 h-2 w-2 rounded-full"></span>
			{$LL.live.notStreaming()}
		</span>
	{/if}
	<div>
		<h1 class="text-2xl font-bold tracking-tight">{$LL.live.title()}</h1>
		<p class="text-muted-foreground text-sm">{$LL.live.description()}</p>
	</div>
</header>
