<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { NetifEntry } from '@ceraui/rpc/schemas';
import { ChevronRight, Network as NetworkIcon } from '@lucide/svelte';

import { Button } from '$lib/components/ui/button';
import { cn } from '$lib/utils';

interface Props {
	wiredEntries: [string, NetifEntry][];
	onConfigure: (name: string) => void;
}

const { wiredEntries, onConfigure }: Props = $props();
</script>

<!-- ───────────── Ethernet / interfaces ───────────── -->
<section class="bg-card rounded-xl border">
	<div class="flex items-center gap-2 border-b px-4 py-3">
		<NetworkIcon aria-hidden="true" class="text-muted-foreground size-4 shrink-0" />
		<h2 class="text-sm font-semibold tracking-tight">{$LL.network.view.ethernet()}</h2>
	</div>
	<div class="divide-y">
		{#if wiredEntries.length === 0}
			<p class="text-muted-foreground px-4 py-6 text-center text-sm">
				{$LL.network.view.noEthernet()}
			</p>
		{:else}
			{#each wiredEntries as [name, iface] (name)}
				<div class="flex items-center gap-3 px-4 py-3">
					<span
						class={cn('size-2 shrink-0 rounded-full', iface.enabled ? 'bg-primary' : 'bg-muted-foreground/40')}
						aria-hidden="true"
					></span>
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm font-medium">{name}</p>
						<p class="text-muted-foreground truncate text-xs">
							{#if iface.ip}
								<code class="font-mono">{iface.ip}</code> ·
							{/if}
							{iface.enabled ? $LL.network.view.connected() : $LL.network.view.off()}
						</p>
					</div>
					<Button
						class="h-8 gap-1 px-2.5"
						size="sm"
						variant="ghost"
						onclick={() => onConfigure(name)}
					>
						{$LL.network.view.configure()}
						<ChevronRight class="size-3.5 rtl:rotate-180" />
					</Button>
				</div>
			{/each}
		{/if}
	</div>
</section>
