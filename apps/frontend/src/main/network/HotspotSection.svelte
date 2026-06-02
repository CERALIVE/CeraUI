<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { WifiInterface } from '@ceraui/rpc/schemas';
import { ChevronRight, Router } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';

interface Props {
	hotspotInterfaces: [string, WifiInterface][];
	hotspotTarget: [string, WifiInterface] | undefined;
	onSetup: () => void;
}

const { hotspotInterfaces, hotspotTarget, onSetup }: Props = $props();
</script>

<!-- ───────────── Hotspot (independent of WiFi: simultaneous state) ───────────── -->
<section class="bg-card rounded-xl border">
	<div class="flex items-center gap-2 border-b px-4 py-3">
		<Router aria-hidden="true" class="text-muted-foreground size-4 shrink-0" />
		<h2 class="text-sm font-semibold tracking-tight">{$LL.network.view.hotspot()}</h2>
		<Button
			class="ms-auto h-8 gap-1 px-2.5"
			size="sm"
			variant="ghost"
			disabled={!hotspotTarget}
			onclick={onSetup}
		>
			{$LL.network.view.setup()}
			<ChevronRight class="size-3.5 rtl:rotate-180" />
		</Button>
	</div>
	<div class="divide-y">
		{#if hotspotInterfaces.length === 0}
			<div class="px-4 py-6 text-center">
				<p class="text-sm font-medium">{$LL.network.view.hotspotOff()}</p>
				<p class="text-muted-foreground mt-0.5 text-xs">{$LL.network.view.hotspotOffHint()}</p>
			</div>
		{:else}
			{#each hotspotInterfaces as [id, iface] (id)}
				<div class="flex items-center gap-3 px-4 py-3">
					<span class="bg-status-info size-2 shrink-0 rounded-full" aria-hidden="true"></span>
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm font-medium">{iface.hotspot?.name || iface.ifname}</p>
						<p class="text-muted-foreground truncate text-xs">
							{$LL.network.view.active()} · {iface.ifname}
						</p>
					</div>
					<span
						class="bg-status-info/10 text-status-info rounded-md px-1.5 py-0.5 text-xs font-medium"
					>
						{$LL.network.view.active()}
					</span>
				</div>
			{/each}
		{/if}
	</div>
</section>
