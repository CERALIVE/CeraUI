<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { ReceiverKind } from '@ceraui/rpc/schemas';
import { ChevronRight, Server } from '@lucide/svelte';

import type { Destination } from '$lib/streaming/receiver-experience';
import { kindBadgeLabelKey } from '$lib/streaming/receiver-experience';

interface Props {
	isStreaming: boolean;
	hasServer: boolean;
	/** Destination of the configured receiver — undefined when none is set. */
	destination: Destination | undefined;
	/** Receiver kind (transport × destination) — undefined when none is set. */
	kind: ReceiverKind | undefined;
	/** Resolved managed-provider label (e.g. "CeraLive Cloud"); managed only. */
	providerName: string | undefined;
	/** Custom endpoint "addr:port"; custom destination only. */
	endpoint: string | undefined;
	onEditServer: () => void;
}

const { isStreaming, hasServer, destination, kind, providerName, endpoint, onEditServer }: Props =
	$props();

// i18n key resolver (mirrors LiveView) — dot-path through the typed $LL proxy
// with safe key-passthrough on a miss, so kindBadgeLabelKey() results render.
const t = (key: string): string => {
	const parts = key.split('.');
	let result: unknown = $LL;
	for (const part of parts) {
		if (result && typeof result === 'object' && part in result) {
			result = (result as Record<string, unknown>)[part];
		} else {
			return key;
		}
	}
	return typeof result === 'function' ? (result as () => string)() : key;
};

// Friendlier, kind-aware chip: managed shows the provider; custom shows the
// endpoint; both append the transport-kind badge. Nothing configured → a calm
// "Not configured" so the edit affordance is always reachable.
const kindBadge = $derived(kind ? t(kindBadgeLabelKey(kind)) : '');
const chip = $derived.by(() => {
	if (!hasServer || !kind) return $LL.general.notConfigured();
	if (destination === 'managed') {
		return providerName ? `${providerName} · ${kindBadge}` : kindBadge;
	}
	return endpoint ? `${endpoint} · ${kindBadge}` : kindBadge;
});
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

	<button
		class="hover:bg-accent focus-visible:ring-ring/50 flex min-h-[44px] max-w-full items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
		data-testid="live-server-chip"
		data-destination={hasServer ? destination : 'none'}
		onclick={onEditServer}
	>
		<Server aria-hidden={true} class="text-muted-foreground h-4 w-4 shrink-0" />
		<span class="max-w-[16rem] truncate" data-testid="live-server-chip-text">{chip}</span>
		<ChevronRight aria-hidden={true} class="text-muted-foreground h-4 w-4 shrink-0 rtl:-scale-x-100" />
	</button>
</header>
