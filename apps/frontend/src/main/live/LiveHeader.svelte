<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { ChevronRight, Server } from '@lucide/svelte';

interface Props {
	isStreaming: boolean;
	hasServer: boolean;
	serverTarget: string;
	onEditServer: () => void;
}

const { isStreaming, hasServer, serverTarget, onEditServer }: Props = $props();
</script>

<!-- Header: stream status, title, and a quick server reference -->
<header class="flex flex-wrap items-center justify-between gap-4">
	<div class="flex items-center gap-3">
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
	</div>

	{#if hasServer}
		<button
			class="hover:bg-accent focus-visible:ring-ring/50 flex min-h-[44px] max-w-full items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
			onclick={onEditServer}
		>
			<Server aria-hidden={true} class="text-muted-foreground h-4 w-4 shrink-0" />
			<span class="max-w-[12rem] truncate font-mono">{serverTarget}</span>
			<ChevronRight aria-hidden={true} class="text-muted-foreground h-4 w-4 shrink-0 rtl:-scale-x-100" />
		</button>
	{/if}
</header>
