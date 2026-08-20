<script lang="ts">
import { m } from '@ceraui/i18n/svelte';

import { Switch } from '$lib/components/ui/switch';
import * as Tooltip from '$lib/components/ui/tooltip';
import { isOperationPending, osCommand } from '$lib/rpc/async-operation.svelte';
import {
	isPending,
	markPending,
	onRpcAppliedReactive,
	onRpcResolved,
} from '$lib/rpc/dirty-registry.svelte';
import { rpc } from '$lib/rpc/client';
import { shouldReconcileOnReconnect } from '$lib/rpc/reconcile-inflight';
import { getConnectionState } from '$lib/rpc/subscriptions.svelte';
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
	 * bandwidth-loss confirm before pulling a wired link from the bond. The
	 * toggle only changes BOND MEMBERSHIP — the interface itself stays up.
	 */
	onBeforeDisable?: () => boolean | Promise<boolean>;
	class?: string;
};

let { name, enabled, ip, disabledReason, onBeforeDisable, class: className }: Props = $props();

// `enabled` is the server's authoritative value. We optimistically show the
// requested `target` for as long as the per-interface field-lock is held —
// NOT just while `pending`. The lock outlives `pending`: it is taken before the
// RPC, the RPC's `finally` clears `pending` the instant it resolves, but the
// lock stays until the confirming netif echo arrives (or the TTL fires). Tying
// `displayed` to `pending || isPending(field)` (not `pending` alone) closes the
// flash-back window where `pending` had cleared but `enabled` was still stale.
// `target` is only read while the lock is held, and is always assigned before
// `pending` flips true, so its initial value is never observed.
//
// PESSIMISTIC CONTROL (Task 26): the Switch is driven by a function binding
// `bind:checked={() => displayed, toggle}` rather than a one-way `checked` +
// `onCheckedChange`. `displayed` is the single read source, so `aria-checked`
// can never diverge from it. bits-ui's internal `checked = !checked` write on
// click is routed straight into `toggle(next)`; it cannot mutate the rendered
// state itself. This is what holds the switch visually ON across the awaited
// `onBeforeDisable` confirm — the flip only lands once `toggle` advances
// `target`/`pending`, i.e. AFTER the user confirms.
let pending = $state(false);
let target = $state(false);

// SHARED resource key with NetifDialog (both mutate `rpc.network.configure` for
// this interface), so a bond toggle and a dialog save on the same iface can never
// race — the osCommand re-entry guard is also the cross-surface race guard.
const netifKey = $derived(`netif:${name}`);

const displayed = $derived(
	pending || isPending(`enabled_${name}`) ? target : enabled,
);
const isDisabled = $derived(
	pending || isOperationPending(netifKey) || disabledReason !== undefined,
);

const actionLabel = $derived(
	displayed ? m["network.view.disableBond"]() : m["network.view.enableBond"](),
);
const stateLabel = $derived(
	displayed ? m["network.view.inBond"]() : m["network.view.excluded"](),
);
// The word this control is NOT currently showing. It is rendered in the same
// grid cell, `invisible`, purely so the slot measures the WIDER of the two in
// whatever locale is active — see the reserve note on the markup below.
const reservedLabel = $derived(
	displayed ? m["network.view.excluded"]() : m["network.view.inBond"](),
);
const tooltipText = $derived(disabledReason ?? actionLabel);

async function toggle(next: boolean) {
	// Serialize concurrent toggles AND cross-surface saves: ignore input while a
	// request is in flight (local or a NetifDialog save on this shared key) or the
	// control is disabled.
	if (pending || isOperationPending(netifKey) || disabledReason !== undefined) return;

	// Guarded disable: run the caller's confirm before mutating. Aborting here
	// leaves `displayed` following the (still-true) `enabled` prop, so the
	// controlled Switch never visually flips on a cancelled disable.
	if (!next && onBeforeDisable) {
		const proceed = await onBeforeDisable();
		if (!proceed) return;
	}

	target = next;
	pending = true;
	// Two composed layers: the dirty-registry field-lock owns the STALE-ECHO guard
	// (keeps `displayed` on `target` until the confirming netif echo lands), while
	// osCommand owns the IN-FLIGHT/FAILURE lifecycle (re-entry guard + single
	// failure toast). They compose — no overlapping responsibilities.
	const field = `enabled_${name}`;
	markPending(field, next);
	const result = await osCommand({
		key: netifKey,
		target: next,
		confirmOnResolve: true,
		rpc: () => rpc.network.configure({ name, ip, enabled: next }),
	});
	if (result?.success && result.applied?.enabled !== undefined) {
		// Adopt the server-applied value; the lock is HELD until the matching netif
		// echo lands, so `displayed` keeps following `target` (no flash-back).
		onRpcAppliedReactive(field, result.applied.enabled);
	} else {
		// Failure/busy/throw: osCommand already surfaced the single failure toast, so
		// do NOT toast again. No confirming echo is coming — release the field-lock to
		// the authoritative prior `enabled` so `displayed` reverts immediately.
		onRpcResolved(field);
		onRpcAppliedReactive(field, enabled);
	}
	onRpcResolved(field);
	// A confirmed reply already resolved the async-op immediately (confirmOnResolve),
	// so the re-entry guard never lingers to TTL. `displayed` now follows the lock.
	pending = false;
}

// Reconnect-aware reconciliation (Task 29): if the WS drops mid-toggle, the
// `rpc.network.configure` promise can be orphaned (socket replaced on
// reconnect) and never run its `finally`, leaving `pending` stuck. Watch the
// authoritative connection state and, on the reconnect edge (→ connected),
// clear a stuck `pending` so `displayed` snaps back to the freshly-hydrated
// `enabled` prop instead of a stale optimistic `target`.
let prevConnection = $state(getConnectionState());
$effect(() => {
	const next = getConnectionState();
	if (shouldReconcileOnReconnect(prevConnection, next, pending)) {
		const field = `enabled_${name}`;
		onRpcResolved(field);
		// Release the field-lock to the authoritative `enabled` prop. Since
		// `displayed` now follows `isPending(field)` (not just `pending`), clearing
		// `pending` alone leaves the lock held and `displayed` stuck on `target`.
		// On reconnect no confirming echo is owed for the orphaned RPC, so release
		// to the freshly-hydrated prop instead of waiting for an echo/TTL.
		onRpcAppliedReactive(field, enabled);
		pending = false;
	}
	prevConnection = next;
});
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
						bind:checked={() => displayed, (next) => void toggle(next)}
						data-testid={`bond-toggle-${name}`}
						disabled={isDisabled}
					/>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content>
				<p class="text-xs">{tooltipText}</p>
			</Tooltip.Content>
		</Tooltip.Root>
		<!-- THE STATE WORD OCCUPIES A RESERVED SLOT, and that is layout, not decoration.
		     This control sits inside a `shrink-0` instrument cluster whose SIGNAL glyph
		     is laid out from the row's right edge, so every pixel of width variance here
		     displaces that glyph. Measured on the bench board: "In Bond" and "Excluded"
		     differ by 7px, which shifted four of seven Cellular rows' signal indicators
		     relative to the other three — the "some moved left, some right" report.
		     Both words are rendered into ONE grid cell, the inactive one `invisible`, so
		     the slot measures max(both) in ANY locale with no magic number and no
		     per-locale table. `invisible` is `visibility: hidden`, which still occupies
		     layout — that is exactly the property being used. Do NOT swap it for
		     `hidden`/`display:none` (reserves nothing) and do NOT replace it with a
		     `min-w-[Npx]` (correct in `en`, wrong in the other nine). -->
		<span
			class="text-muted-foreground grid font-mono text-xs"
			data-testid={`bond-state-${name}`}
		>
			<span class="col-start-1 row-start-1">{stateLabel}</span>
			<span aria-hidden="true" class="invisible col-start-1 row-start-1">{reservedLabel}</span>
		</span>
	</div>
</Tooltip.Provider>
