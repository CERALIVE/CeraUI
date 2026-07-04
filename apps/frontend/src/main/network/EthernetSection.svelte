<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import type { NetifEntry } from '@ceraui/rpc/schemas';
import { ChevronRight, Network as NetworkIcon } from '@lucide/svelte';

import * as AlertDialog from '$lib/components/ui/alert-dialog';
import { Button } from '$lib/components/ui/button';
import BondToggle from '$lib/components/custom/BondToggle.svelte';
import Badge from '$lib/components/custom/Badge.svelte';
import { cn } from '$lib/utils';

interface Props {
	wiredEntries: [string, NetifEntry][];
	/** Whole-app staleness latch: the WS has been down past the global threshold. */
	isFullyStale: boolean;
	/** ifnames whose own telemetry aged out while siblings stayed fresh (Task 22). */
	staleInterfaces: Set<string>;
	onConfigure: (name: string) => void;
}

const { wiredEntries, isFullyStale, staleInterfaces, onConfigure }: Props = $props();

// Ethernet footgun guard: disabling a wired link can drop the operator's
// management / SSH / LAN path, so the BondToggle's disable action is gated
// behind a confirm. One dialog instance serves every row via a pending
// promise resolver — BondToggle awaits `confirmDisable()` before mutating.
let confirmOpen = $state(false);
let pendingName = $state('');
let resolveConfirm: ((proceed: boolean) => void) | null = null;

function confirmDisable(name: string): Promise<boolean> {
	return new Promise((resolve) => {
		resolveConfirm = resolve;
		pendingName = name;
		confirmOpen = true;
	});
}

// Idempotent settle: the first caller wins; closing the dialog by any path
// (Action, Cancel, Escape, overlay) routes through `onOpenChange` and is a
// no-op once the resolver has fired.
function settle(proceed: boolean) {
	resolveConfirm?.(proceed);
	resolveConfirm = null;
	confirmOpen = false;
}
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
				{@const showStale = iface.enabled && (staleInterfaces.has(name) || isFullyStale)}
				<!-- Single-line row: identity (dot · name · status) left; bond + configure right. -->
				<div class="flex flex-wrap items-center gap-3 px-4 py-2.5">
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
					<div class="ms-auto flex shrink-0 items-center gap-2">
						{#if showStale}
							<Badge variant="stale" data-stale-interface={name} />
						{/if}
						<BondToggle
							name={name}
							enabled={iface.enabled}
							ip={iface.ip}
							onBeforeDisable={() => confirmDisable(name)}
						/>
						<Button
							class="h-8 min-h-[var(--touch-target-min)] gap-1 px-2.5"
							data-testid="open-netif-dialog"
							size="sm"
							variant="ghost"
							onclick={() => onConfigure(name)}
						>
							{$LL.network.view.configure()}
							<ChevronRight class="size-3.5 rtl:rotate-180" />
						</Button>
					</div>
				</div>
			{/each}
		{/if}
	</div>
</section>

<!-- Management-interruption confirm: gates BondToggle disable on wired links. -->
<AlertDialog.Root bind:open={confirmOpen} onOpenChange={(open) => !open && settle(false)}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{$LL.network.view.wiredDisableTitle()}</AlertDialog.Title>
			<AlertDialog.Description>
				{$LL.network.view.wiredDisableBody()}
				{#if pendingName}
					<span class="text-foreground/80 mt-1 block font-mono text-xs">{pendingName}</span>
				{/if}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel onclick={() => settle(false)}>
				{$LL.dialog.cancel()}
			</AlertDialog.Cancel>
			<AlertDialog.Action
				class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
				onclick={() => settle(true)}
			>
				{$LL.network.view.disableBond()}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
