<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { toast } from 'svelte-sonner';

import { Switch } from '$lib/components/ui/switch';
import * as Tooltip from '$lib/components/ui/tooltip';
import { rpc } from '$lib/rpc/client';
import { cn } from '$lib/utils';

type Props = {
	/** Network interface name (e.g. `wlan0`, `ww0`, `eth0`). */
	name: string;
	/** Authoritative server-side bond membership for this interface. */
	enabled: boolean;
	/** Static IP to preserve across the toggle; omit for DHCP. */
	ip?: string;
	/**
	 * When set, the control is rendered disabled and this (already-resolved)
	 * text is surfaced as the accessible reason via tooltip + aria-label.
	 */
	disabledReason?: string;
	class?: string;
};

let { name, enabled, ip, disabledReason, class: className }: Props = $props();

// `enabled` is the server's authoritative value. While a request is in flight
// we optimistically show the requested `target`, then snap back to the prop
// once it resolves. This reverts correctly whether the backend rejects the
// RPC OR silently blocks the change: the last-active / errored-interface
// guards push a fresh netif state without rejecting, so the prop reconciles
// the visual state on the next subscription update.
// `target` is only read while `pending`, and is always assigned before
// `pending` flips true, so its initial value is never observed.
let pending = $state(false);
let target = $state(false);

const displayed = $derived(pending ? target : enabled);
const isDisabled = $derived(pending || disabledReason !== undefined);

const actionLabel = $derived(
	displayed ? $LL.network.view.disableBond() : $LL.network.view.enableBond(),
);
const stateLabel = $derived(
	displayed ? $LL.network.view.inBond() : $LL.network.view.excluded(),
);
const tooltipText = $derived(disabledReason ?? actionLabel);

function errorMessage(error: unknown): string | undefined {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === 'string' && error) return error;
	return undefined;
}

async function toggle(next: boolean) {
	// Serialize concurrent toggles: ignore input while a request is in flight
	// or the control is disabled.
	if (pending || disabledReason !== undefined) return;

	target = next;
	pending = true;
	try {
		await rpc.network.configure({ name, ip, enabled: next });
	} catch (error) {
		console.error(`Failed to toggle bond membership for ${name}:`, error);
		toast.error(errorMessage(error) ?? $LL.network.view.lastActiveError());
	} finally {
		// Release the in-flight lock; `displayed` now follows the authoritative
		// `enabled` prop, which the netif subscription reconciles (confirm on
		// success, revert on a blocked or failed change).
		pending = false;
	}
}
</script>

<Tooltip.Provider>
	<div class={cn('flex items-center gap-2', pending && 'animate-pulse', className)}>
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<Switch
						{...props}
						aria-busy={pending}
						aria-label={tooltipText}
						checked={displayed}
						disabled={isDisabled}
						onCheckedChange={toggle}
					/>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>
				<p class="text-xs">{tooltipText}</p>
			</Tooltip.Content>
		</Tooltip.Root>
		<span class="text-muted-foreground font-mono text-xs">{stateLabel}</span>
	</div>
</Tooltip.Provider>
