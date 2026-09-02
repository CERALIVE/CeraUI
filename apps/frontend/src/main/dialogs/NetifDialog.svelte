<!--
  NetifDialog.svelte — per-interface configuration dialog (Task 24).

  Opened from NetworkView's Ethernet section "Configure" trigger. Lets the
  operator include/exclude a wired interface from the bond, and REPORTS the
  interface's address together with where that address came from.

  THE ADDRESS IS REPORTED, NOT EDITED, and that is a correction rather than a
  reduction. The dialog used to offer a "Static IP address" field; measured on a
  Rock 5B+ (2026-08-16), saving `192.168.0.222` onto a dongle at 192.168.0.169
  toasted "Saved" and changed NOTHING — `ip -br addr` was byte-identical, the
  NetworkManager profile still read `ipv4.method: auto` with an empty
  `ipv4.addresses`, and the journal recorded not one line. The backend has no
  apply path at all: `handleNetif` reads `msg.ip` ONLY as an echo guard
  (`if (int.ip !== msg.ip) return;`) and mutates `enabled` and nothing else. So
  the field could not work on ANY interface, dongle or real NIC.

  Worse, that guard made the dead field destructive: a save that ALSO flipped the
  bond toggle was discarded whole, because the edited IP no longer matched the
  observed one. Board-proven — bonding toggled off + IP edited + "Saved" toast,
  and the row still read "In Bond". Echoing the OBSERVED address keeps the guard's
  concurrency meaning (this client's view of the interface is current) while
  making it impossible for the operator to trip it.

  Dirty-field guard: once the operator edits the bond toggle, incoming server
  pushes for THAT field are ignored until the dialog is reopened, so an
  in-progress edit is never clobbered by live telemetry.

  THE PORT ROLE IS STAGED, AND SAVE IS ITS ONLY DISPATCH SITE. The role control
  used to apply on the radio click itself, which made a change that reconfigures
  the port — and can drop the very LAN path this page is being read over —
  reachable by one stray tap on a touchscreen, with no way back. It is now
  ordinary dialog state alongside `enabled`: `EthernetRoleSelector` writes it
  back through `onSelect` and dispatches nothing, `save()` is the only caller of
  `network.setEthernetRole`, Cancel discards it, and the open edge resets it. A
  staged role that differs from the applied one renders a standing warning band
  in the control, so a pending change never looks like an applied one. The
  BACKEND transaction is untouched — same procedure, same keyed op, same
  device-moves-the-control settlement on the terminal `eth_role` frame.

  A REFUSED SAVE IS RENDERED INLINE, NOT TOASTED. Todo 8 replaced the procedure's
  fabricated `{success:true}` with a typed `{success:false, error}` — the
  `stale_address` concurrency guard being the one that used to report a DISCARDED
  bond toggle as "Saved". Its four reasons name four different operator actions,
  so the dialog keeps a structured refusal out of `osCommand`'s toast path
  (`classify` answers ok) and states the reason in a standing band beside the
  control it refused. Only a THROWN rpc — a transport fault with no typed reason —
  keeps the toast. This is the BluetoothSection rule applied to a wired port.
-->
<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { EthernetRole, NetifConfigError, NetifEntry } from '@ceraui/rpc/schemas';
import { Info, Network, TriangleAlert } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import LabeledSwitch from '$lib/components/custom/LabeledSwitch.svelte';
import { AppDialog } from '$lib/components/dialogs';
import { Label } from '$lib/components/ui/label';
import { isLinkLocalIpv4 } from '$lib/helpers/ip-classification';
import { rpc } from '$lib/rpc';
import {
	getOperationPhase,
	getOperationReason,
	getOperationTarget,
	isOperationPending,
	osCommand,
} from '$lib/rpc/async-operation.svelte';
import { getIsStreaming } from '$lib/rpc/subscriptions.svelte';
import EthernetRoleSelector from '$main/network/EthernetRoleSelector.svelte';
import {
	deriveEthernetRoleView,
	ethernetRoleContext,
	ethernetRoleOpKey,
	ethernetRoleTarget,
} from '$main/network/ethernet-role-view';

interface Props {
	open?: boolean;
	name: string;
	iface: NetifEntry | undefined;
}

let { open = $bindable(false), name, iface }: Props = $props();

// Local, editable copy. Initialised on the open edge so the form always starts
// from the live interface state.
let enabled = $state(false);

// Dirty-field guard: marks the operator-edited field.
let dirtyEnabled = $state(false);
let wasOpen = false;
let saving = $state(false);

// The port role the operator has PICKED but not yet saved. It is dialog state,
// exactly like `enabled`: a role change reconfigures the port and can drop the
// LAN path this page is being read over, so a radio click is not consent to it —
// `save()` is the only thing that calls `network.setEthernetRole`.
let stagedRole = $state<EthernetRole | undefined>(undefined);

// The device's typed refusal for the LAST save, held until the next attempt or
// the next open. `unknown` covers a `{success:false}` carrying no `error`.
let saveError = $state<NetifConfigError | 'unknown' | undefined>(undefined);

const SAVE_ERROR_KEY: Record<NetifConfigError | 'unknown', string> = {
	unknown_interface: 'network.netifSave.error.unknownInterface',
	stale_address: 'network.netifSave.error.staleAddress',
	enable_refused: 'network.netifSave.error.enableRefused',
	disable_all_refused: 'network.netifSave.error.disableAllRefused',
	bond_unmappable: 'network.netifSave.error.generic',
	unknown: 'network.netifSave.error.generic',
};

$effect(() => {
	// Open edge → reset the form from the current interface, clear the dirty flag.
	if (open && !wasOpen) {
		enabled = iface?.enabled ?? false;
		dirtyEnabled = false;
		saveError = undefined;
		stagedRole = undefined;
	}
	wasOpen = open;
});

$effect(() => {
	// Live sync while open — but only while the operator hasn't touched it.
	if (!open) return;
	const serverEnabled = iface?.enabled;
	if (!dirtyEnabled && serverEnabled !== undefined) enabled = serverEnabled;
});

// WHERE the address came from, which is the question the retired input begged.
// Router-cellular is todo 43's classifier verdict, read off the SAME netif field
// the row badge reads — no second classification signal is derived here.
const observedIp = $derived(iface?.ip ?? '');
const isRouterCellular = $derived(iface?.router_cellular != null);
const isLinkLocal = $derived(isLinkLocalIpv4(iface?.ip));
// The dongle case reuses the row's OWN sentence verbatim: same physical fact,
// second surface, so a separate key would be a second vocabulary to drift.
const addressSource = $derived(
	isRouterCellular
		? m["network.routerCellular.addressNote"]()
		: isLinkLocal
			? m["settings.dialogs.addressLinkLocal"]()
			: m["settings.dialogs.addressFromDhcp"](),
);

// SHARED resource key with BondToggle (both mutate `rpc.network.configure` for
// this interface), so a dialog save and a bond toggle on the same iface can never
// race — the osCommand re-entry guard is also the cross-surface race guard.
const netifKey = $derived(`netif:${name}`);

// The role control's own keyed op, read live so a transition dispatched from
// ANOTHER client moves this dialog too.
const roleKey = $derived(ethernetRoleOpKey(name));
const roleView = $derived(
	deriveEthernetRoleView({
		name,
		iface,
		phase: getOperationPhase(roleKey),
		...(ethernetRoleTarget(getOperationTarget(roleKey)) !== undefined
			? { target: ethernetRoleTarget(getOperationTarget(roleKey)) }
			: {}),
		...(getOperationReason(roleKey) !== undefined
			? { failureReason: getOperationReason(roleKey) }
			: {}),
	}),
);
const roleContext = $derived(ethernetRoleContext(iface, getIsStreaming()));

// A staged role EQUAL to the applied one is not a change, so it dispatches
// nothing — Save on an untouched role must be byte-identical to the save that
// shipped before staging existed.
const pendingRoleChange = $derived(
	stagedRole !== undefined && stagedRole !== roleView.displayRole
		? stagedRole
		: undefined,
);

function discardStagedRole() {
	stagedRole = undefined;
}

async function save() {
	if (saving) return;
	// Cross-surface busy guard: a bond toggle (or another save) on THIS iface is
	// in flight — refuse with the standard busy feedback, don't dispatch a second.
	// The role carries its own key, and a transition another client dispatched is
	// the same class of contention.
	if (
		isOperationPending(netifKey) ||
		(pendingRoleChange !== undefined && isOperationPending(roleKey))
	) {
		toast.error(m["network.os.deviceBusy"]());
		return;
	}
	saving = true;
	saveError = undefined;

	// The role leads, because every other field on this dialog is read in its
	// light — a shared-LAN port is excluded from the bond by the device, so the
	// toggle below means nothing until the role has settled. A refused role
	// change therefore stops the save outright: applying half of it would leave
	// the operator reading a bond state that belongs to the role they did NOT get.
	if (pendingRoleChange !== undefined) {
		const roleResult = await osCommand({
			key: roleKey,
			target: pendingRoleChange,
			rpc: () =>
				rpc.network.setEthernetRole({ name, role: pendingRoleChange }),
			// The reason renders inline in the role control's own band; a toast
			// would say the same thing twice and then take it away.
			silent: true,
		});
		if (roleResult?.success !== true) {
			saving = false;
			return;
		}
	}
	// Echo the OBSERVED address so the backend's `int.ip !== msg.ip` guard reads
	// as the concurrency check it is, and can never silently discard the bond
	// change. An address-less interface must OMIT the field (`""` fails the
	// backend regex), which the guard treats as its own no-address case.
	const result = await osCommand({
		key: netifKey,
		target: { name, enabled },
		confirmOnResolve: true,
		rpc: () =>
			rpc.network.configure({
				name,
				ip: observedIp === '' ? undefined : observedIp,
				enabled,
			}),
		// A STRUCTURED refusal stays `ok` here so it never takes osCommand's toast
		// path — it is a device FACT with a typed reason, and it is rendered in the
		// standing band below instead. A thrown rpc still falls through to the
		// toast, because a transport fault names no reason worth standing.
		classify: () => ({ ok: true }),
		busyMessage: () => m["network.os.deviceBusy"](),
		failMessage: () => m["network.os.operationFailed"](),
	});
	saving = false;
	// Only a confirmed success closes the dialog. A refusal keeps it open with the
	// form value preserved AND names what the device refused; a throw keeps it
	// open with osCommand's single toast.
	if (result?.success) {
		toast.success(m["network.os.saved"]());
		open = false;
		return;
	}
	if (result !== undefined) saveError = result.error ?? 'unknown';
}
</script>

<AppDialog
	closeOnPrimary={false}
	description={name}
	icon={Network}
	onPrimary={save}
	onSecondary={discardStagedRole}
	primaryLabel={m["advanced.save"]()}
	primaryLoading={saving}
	title={m["network.view.configure"]()}
	bind:open
>
	<div class="space-y-6">
		<!-- Role leads: it is the coarsest decision on this port, and every control
		     below it is read in its light — a shared-LAN port is excluded from the
		     bond by the device, so the toggle underneath means nothing until the
		     role says uplink. Renders NOTHING for a row the device published no
		     role for (a dongle veth, an older backend).

		     Selection is STAGED: the control writes back through `onSelect` and
		     dispatches nothing, so the role is applied by `save()` alone. -->
		<EthernetRoleSelector
			context={roleContext}
			onSelect={(role) => (stagedRole = role)}
			staged={stagedRole}
			view={roleView}
		/>

		<!-- Enable / disable -->
		<div class="flex items-start justify-between gap-4">
			<div class="min-w-0 space-y-0.5">
				<Label class="text-sm font-medium" for="netif-enabled">
					{m["settings.dialogs.enableInterface"]()}
				</Label>
				<p class="text-muted-foreground text-xs">
					{m["settings.dialogs.enableInterfaceDesc"]()}
				</p>
			</div>
			<LabeledSwitch
				checked={enabled}
				label={m["settings.dialogs.enableInterface"]()}
				onCheckedChange={(v) => {
					enabled = v;
					dirtyEnabled = true;
				}}
			/>
		</div>

		<!-- Address: reported with its provenance, never offered as an edit. It is
		     deliberately UNBOXED — a bordered, filled value on a dialog with a Save
		     button reads as a disabled text field, i.e. as an edit the operator
		     could unlock. Bare label-over-value is a data row and cannot. -->
		<div class="space-y-1">
			<Label class="text-muted-foreground text-xs font-medium" for="netif-address">
				{m["settings.dialogs.address"]()}
			</Label>
			<p id="netif-address" class="font-mono text-base" data-testid="netif-address">
				{#if observedIp}
					{observedIp}
				{:else}
					<span class="text-muted-foreground font-sans text-sm"
						>{m["settings.dialogs.addressNone"]()}</span
					>
				{/if}
			</p>
			<p class="text-muted-foreground text-xs" data-testid="netif-address-source">
				{addressSource}
			</p>
		</div>

		{#if isLinkLocal}
			<!-- Calm, informational: the shown 169.254/16 address is an automatic OS
			     fallback (always kept for local access), never a saved static IP. -->
			<div
				data-testid="netif-link-local-notice"
				role="status"
				class="bg-status-info/10 border-status-info/30 flex items-start gap-3 rounded-lg border p-3"
			>
				<Info class="text-status-info mt-0.5 size-4 shrink-0" aria-hidden="true" />
				<p class="text-muted-foreground text-xs">{m["settings.dialogs.linkLocalNotice"]()}</p>
			</div>
		{/if}

		{#if saveError}
			<!-- Beside the Save it answers, and it STANDS: the shipped kiosk
			     touchscreen cannot hover, and a toast that expires is how a discarded
			     save came to read as a successful one. -->
			<div
				class="border-status-warning/30 bg-status-warning/10 flex items-start gap-3 rounded-lg border p-3"
				data-error={saveError}
				data-testid="netif-save-error"
				role="status"
			>
				<TriangleAlert class="text-status-warning mt-0.5 size-4 shrink-0" aria-hidden="true" />
				<div class="min-w-0">
					<p class="text-status-warning text-xs font-semibold">
						{m["network.netifSave.error.title"]()}
					</p>
					<p class="text-muted-foreground mt-0.5 text-xs">
						{resolveMessageKey(SAVE_ERROR_KEY[saveError])}
					</p>
				</div>
			</div>
		{/if}
	</div>
</AppDialog>
