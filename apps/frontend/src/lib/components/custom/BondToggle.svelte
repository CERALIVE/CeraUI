<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { toast } from 'svelte-sonner';

import { Switch } from '$lib/components/ui/switch';
import * as Tooltip from '$lib/components/ui/tooltip';
import { markPending, onRpcResolved } from '$lib/rpc/dirty-registry.svelte';
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
	/**
	 * Optional async guard run ONLY before a DISABLE toggle. Resolve `false`
	 * to abort (the switch stays in its current state); resolve `true` to
	 * proceed with `rpc.network.configure`. Used by Ethernet to surface a
	 * management-interruption confirm before pulling a wired link from the bond.
	 */
	onBeforeDisable?: () => boolean | Promise<boolean>;
	class?: string;
};

let { name, enabled, ip, disabledReason, onBeforeDisable, class: className }: Props = $props();

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

	// Guarded disable: run the caller's confirm before mutating. Aborting here
	// leaves `displayed` following the (still-true) `enabled` prop, so the
	// controlled Switch never visually flips on a cancelled disable.
	if (!next && onBeforeDisable) {
		const proceed = await onBeforeDisable();
		if (!proceed) return;
	}

	target = next;
	pending = true;
	// Register this interface's bond-membership edit in the dirty-field registry
	// (per-interface key, so it never collides with another control). Lock BEFORE
	// the RPC, release after it settles (resolve or reject) to avoid a permanent
	// lock. The local `pending`/`target` pair owns the optimistic visual; this
	// registration only records ownership so the ingestion layer knows the field.
	const field = `enabled_${name}`;
	markPending(field, next);
	try {
		await rpc.network.configure({ name, ip, enabled: next });
	} catch (error) {
		console.error(`Failed to toggle bond membership for ${name}:`, error);
		toast.error(errorMessage(error) ?? $LL.network.view.lastActiveError());
	} finally {
		onRpcResolved(field);
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
