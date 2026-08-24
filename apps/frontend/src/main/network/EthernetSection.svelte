<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type {
	DongleState,
	NetifEntry,
	RouterCellularMarker,
	UsbModemNetMarker,
} from '@ceraui/rpc/schemas';
import {
	Check,
	ChevronRight,
	CircleAlert,
	Hourglass,
	Network as NetworkIcon,
	RadioTower,
	Share2,
	TriangleAlert,
	Users,
} from '@lucide/svelte';

import * as AlertDialog from '$lib/components/ui/alert-dialog';
import { Button } from '$lib/components/ui/button';
import BondToggle from '$lib/components/custom/BondToggle.svelte';
import Badge from '$lib/components/custom/Badge.svelte';
import { isLinkLocalIpv4 } from '$lib/helpers/ip-classification';
import { cn } from '$lib/utils';

import { type EthernetClientZoneState, deriveSharedLanRow } from './ethernet-role-view';

interface Props {
	wiredEntries: [string, NetifEntry][];
	/** Whole-app staleness latch: the WS has been down past the global threshold. */
	isFullyStale: boolean;
	/** ifnames whose own telemetry aged out while siblings stayed fresh (Task 22). */
	staleInterfaces: Set<string>;
	onConfigure: (name: string) => void;
}

const { wiredEntries, isFullyStale, staleInterfaces, onConfigure }: Props = $props();

// Bandwidth footgun guard: the wired link is usually the fattest member of the
// bond, so excluding it can gut an in-flight stream's throughput — hence the
// confirm on the BondToggle's disable action. It does NOT touch the interface
// itself (the backend `enabled` flag only filters `genSrtlaIpList()`), so
// management / SSH / LAN over eth0 are unaffected and the copy must not claim
// otherwise. One dialog instance serves every row via a pending promise
// resolver — BondToggle awaits `confirmDisable()` before mutating.
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

// ───────────── Isolated-dongle row (Phase B) ─────────────
//
// A `dg<N>h` row is the HOST side of a veth pair into a claimed router-mode USB
// dongle's own network namespace — so the thing an operator sees here is the
// virtual link to the dongle, not the dongle's own `enx…` adapter. The backend
// stamps `dongle: {slot, state}` on such a row (and unions a metadata-only row
// for a dongle whose veth is still gated), so a marked row is authoritative.
//
// Every state carries its own WORD and its own GLYPH; colour only reinforces
// them. All three are static — no animation, so the e-ink freeze has nothing to
// still and the row reads identically on a paper display.
const DONGLE_STATE_VARIANT: Record<DongleState, 'success' | 'warning' | 'error'> = {
	up: 'success',
	acquiring: 'warning',
	down: 'error',
};

const DONGLE_STATE_ICON = {
	up: Check,
	acquiring: Hourglass,
	down: CircleAlert,
} satisfies Record<DongleState, unknown>;

// `size="micro"` cannot deliver its own font size on a COLOURED badge: `Badge`
// composes through `cn()`/tailwind-merge, which does not recognise the custom
// `text-micro` utility and so files it under text-COLOUR — the `text-status-*`
// class that follows it wins, and the badge silently falls back to the inherited
// 16px, larger than the interface name it annotates. Passing the SAME design
// token as a typed arbitrary value puts it in the font-size group, where it
// coexists with the colour. The Badge-level defect is app-wide, not this row's.
const MICRO_TEXT = 'text-(length:--text-micro)';

function dongleStateLabel(state: DongleState): string {
	if (state === 'up') return m["network.dongle.stateUp"]();
	if (state === 'acquiring') return m["network.dongle.stateAcquiring"]();
	return m["network.dongle.stateDown"]();
}

// An `acquiring` / `down` dongle's veth is administratively DOWN and
// address-less by the runtime contract, so it structurally CANNOT carry bonded
// traffic — `genSrtlaIpList()` never sees it. The toggle is therefore rendered
// disabled, and NEVER bare: the reason rides BondToggle's tooltip + aria-label
// AND a visible line under the row, because a touchscreen operator cannot hover
// to discover why a control is dead.
function dongleBondBlockedReason(state: DongleState): string | undefined {
	if (state === 'acquiring') return m["network.dongle.blockedAcquiring"]();
	if (state === 'down') return m["network.dongle.blockedDown"]();
	return undefined;
}

// ───────────── Router-mode cellular dongle (VID:PID/descriptor classified) ─────────────
//
// This marker is INDEPENDENT of the dongle marker above: it comes from the USB
// descriptors the kernel already publishes, so a HiLink/MF79U-class dongle is
// named honestly on an image with no netns isolation deployed — which is every
// shipped image today. The two can coexist on one row (a claimed dongle's veth
// is not itself USB, so in practice they land on different rows).
//
// `vendor` and `model` are the device's OWN string descriptors, and a dongle is
// entitled to publish the same text for both — this bench's Huawei units report
// `HUAWEI_MOBILE` twice. Printing it twice is noise rather than honesty, so an
// exact duplicate collapses to one.
function routerCellularName(marker: RouterCellularMarker): string {
	return marker.vendor === marker.model ? marker.model : `${marker.vendor} ${marker.model}`;
}

// ───────────── An MM-managed modem's own data function ─────────────
//
// Same shape of fact as the marker above, different owner: the classifier found
// a recognized MBIM/QMI/AT control port, so the Cellular section owns this
// device. Its modem row normally claims the interface and this row never
// renders — but `netif` and `modems` are independent broadcasts, so during the
// handover window (and on a modem the roster never registers) the interface is
// still here. Naming it is what stops it reading as a mystery second adapter
// for a device the operator can already see under Cellular.
function modemNetName(marker: UsbModemNetMarker): string {
	return marker.vendor === marker.model ? marker.model : `${marker.vendor} ${marker.model}`;
}

// ───────────── Shared-LAN port (the operator's own declared role) ─────────────
//
// A `shared-lan` port hands itself to NetworkManager's `ipv4.method shared`, so
// the device excludes it from the bond and from the connectivity election. The
// row must therefore never read like an uplink: it says WHAT the port is, WHAT
// its client zone is doing, and WHY it carries no bonded traffic — the same
// identity-badge + state-badge + on-screen-reason vocabulary the isolated-dongle
// row above already uses, not a fourth one.
const ZONE_VARIANT: Record<EthernetClientZoneState, 'success' | 'warning'> = {
	serving: 'success',
	starting: 'warning',
};

const ZONE_ICON = {
	serving: Users,
	starting: Hourglass,
} satisfies Record<EthernetClientZoneState, unknown>;
</script>

<!-- ───────────── Ethernet / interfaces ───────────── -->
<section class="bg-card rounded-xl border">
	<div class="flex items-center gap-2 border-b px-4 py-3">
		<NetworkIcon aria-hidden="true" class="text-muted-foreground size-4 shrink-0" />
		<h2 class="text-sm font-semibold tracking-tight">{m["network.view.ethernet"]()}</h2>
	</div>
	<div class="divide-y">
		{#if wiredEntries.length === 0}
			<p class="text-muted-foreground px-4 py-6 text-center text-sm">
				{m["network.view.noEthernet"]()}
			</p>
		{:else}
			{#each wiredEntries as [name, iface] (name)}
				{@const showStale = iface.enabled && (staleInterfaces.has(name) || isFullyStale)}
				{@const linkLocal = isLinkLocalIpv4(iface.ip)}
				<!-- `null` is the backend RETRACTING the claim; the ingestion merge prunes
				     the row on that frame, so it is normalised away rather than rendered. -->
				{@const dongle = iface.dongle ?? undefined}
				{@const dongleBlocked = dongle ? dongleBondBlockedReason(dongle.state) : undefined}
				<!-- `null` retracts the classification but KEEPS the row (unlike `dongle`),
				     so it is normalised to "unclassified" rather than pruned. -->
				{@const routerCellular = iface.router_cellular ?? undefined}
				<!-- `null` retracts this claim and KEEPS the row too. -->
				{@const modemNet = iface.usb_modem_net ?? undefined}
				<!-- Absent `ethRole` means "not an ethernet port, or an older backend",
				     never `uplink`, so an unclaimed row renders exactly as before. -->
				{@const sharedLan = deriveSharedLanRow(iface)}
				{@const sharedLanReason = sharedLan
					? resolveMessageKey(sharedLan.bondExclusionReasonKey)
					: undefined}
				<!-- Single-line row: identity (dot · name · status) left; bond + configure right. -->
				<div class="flex flex-wrap items-center gap-3 px-4 py-2.5">
					<!-- `self-start` because a classified row is several lines tall: a
					     vertically-centred dot floats away from the name it reports on.
					     Same rule, same reason, as CellularSection's row dot. -->
					<span
						class={cn(
							'mt-1.5 size-2 shrink-0 self-start rounded-full',
							iface.enabled ? 'bg-primary' : 'bg-muted-foreground/40',
						)}
						aria-hidden="true"
					></span>
					<!-- `basis-72` is what makes the row RESPONSIVE rather than merely
					     wrapping: with `flex-1` alone the control cluster never wraps, it
					     just shrinks this column, and below ~500px the prose collapses to
					     one word per line while the IP runs under the toggle. A basis wider
					     than the remaining space forces the cluster onto its own line
					     instead. Desktop is unchanged — `flex-1` still grows past it. -->
					<div class="min-w-0 flex-1 basis-72">
						<p class="truncate text-sm font-medium">{name}</p>
						{#if sharedLan}
							{@const ZoneIcon = ZONE_ICON[sharedLan.zone]}
							<!-- What the port IS, then what its client zone is doing — both in
							     words, with their own glyphs, so colour is only reinforcement. -->
							<div class="mt-0.5 flex flex-wrap items-center gap-1.5">
								<Badge
									variant="info"
									size="micro"
									class={MICRO_TEXT}
									data-testid="netif-eth-role"
									data-eth-role="shared-lan"
									title={m["network.ethRole.badgeHint"]()}
								>
									<Share2 class="size-3" aria-hidden="true" />
									{m["network.ethRole.sharedLan"]()}
								</Badge>
								<Badge
									variant={ZONE_VARIANT[sharedLan.zone]}
									size="micro"
									class={MICRO_TEXT}
									data-testid="netif-eth-role-zone"
									data-zone={sharedLan.zone}
								>
									<ZoneIcon class="size-3" aria-hidden="true" />
									{resolveMessageKey(sharedLan.zoneLabelKey)}
								</Badge>
							</div>
						{/if}
						{#if dongle}
							{@const StateIcon = DONGLE_STATE_ICON[dongle.state]}
							<!-- What it IS, then where it is in its lifecycle — both in words. -->
							<div class="mt-0.5 flex flex-wrap items-center gap-1.5">
								<Badge
									variant="info"
									size="micro"
									class={MICRO_TEXT}
									data-testid="netif-dongle"
									data-dongle-slot={dongle.slot}
									label={m["network.dongle.badge"]()}
									title={m["network.dongle.isolationHint"]()}
								/>
								<Badge
									variant={DONGLE_STATE_VARIANT[dongle.state]}
									size="micro"
									class={MICRO_TEXT}
									data-testid="netif-dongle-state"
									data-dongle-state={dongle.state}
								>
									<StateIcon class="size-3" aria-hidden="true" />
									{dongleStateLabel(dongle.state)}
								</Badge>
							</div>
						{/if}
						{#if modemNet}
							<div class="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
								<Badge
									variant="info"
									size="micro"
									class={MICRO_TEXT}
									data-testid="netif-modem-net"
									data-vid-pid={modemNet.vid_pid}
									title={m["network.modemNet.hint"]()}
								>
									<RadioTower class="size-3" aria-hidden="true" />
									{m["network.modemNet.badge"]()}
								</Badge>
								<span
									class="text-muted-foreground font-mono text-(length:--text-micro)"
									data-testid="netif-modem-net-identity"
								>
									{modemNetName(modemNet)} · {modemNet.vid_pid}
								</span>
							</div>
						{/if}
						{#if routerCellular}
							<!-- Identity rides the SAME line as the badge: the badge says what
							     class of thing it is, the mono text says which unit — one glance,
							     one line, no extra row height per dongle on the kiosk viewport. -->
							<div class="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
								<Badge
									variant="info"
									size="micro"
									class={MICRO_TEXT}
									data-testid="netif-router-cellular"
									data-vid-pid={routerCellular.vid_pid}
									title={m["network.routerCellular.hint"]()}
								>
									<RadioTower class="size-3" aria-hidden="true" />
									{m["network.routerCellular.badge"]()}
								</Badge>
								<span
									class="text-muted-foreground font-mono text-(length:--text-micro)"
									data-testid="netif-router-cellular-identity"
								>
									{routerCellularName(routerCellular)} · {routerCellular.vid_pid}
								</span>
							</div>
						{/if}
						{#if iface.ip || !sharedLan}
							<p class="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
								{#if iface.ip}
									<code class="font-mono">{iface.ip}</code>
									{#if linkLocal}
										<Badge variant="info" size="micro" data-testid="netif-link-local" label={m["network.view.linkLocal"]()} />
									{/if}
									{#if !sharedLan}
										<span aria-hidden="true">·</span>
									{/if}
								{/if}
								<!-- `enabled` is BOND membership, not link state. A shared-LAN port
								     is forced out of the bond by the device while its zone is up and
								     serving, so rendering "Off" here would be the same lie as
								     rendering it "Connected" — its state is the zone badge above. -->
								{#if !sharedLan}
									{iface.enabled ? m["network.view.connected"]() : m["network.view.off"]()}
								{/if}
							</p>
						{/if}
						{#if linkLocal}
							<!-- Calm, informational: 169.254/16 is an automatic OS address, not a stuck static config. -->
							<p class="text-muted-foreground/80 mt-0.5 text-xs" data-testid="netif-link-local-hint">
								{m["network.view.linkLocalHint"]()}
							</p>
						{/if}
						{#if routerCellular}
							<!-- ALWAYS present, because the address is the thing an operator
							     will otherwise try to change and cannot: it is leased by the
							     dongle's own DHCP server. A tooltip alone is unreachable on the
							     kiosk touchscreen this device ships with. -->
							<p
								class="text-muted-foreground/80 mt-0.5 text-xs"
								data-testid="netif-router-cellular-address-note"
							>
								{m["network.routerCellular.addressNote"]()}
							</p>
						{/if}
						{#if routerCellular?.duplicate_model}
							<!-- The collision is MEASURED, not predicted: a second unit of this
							     exact vid:pid is attached right now. Amber, not destructive —
							     nothing is broken, this is a known limitation of factory-fixed
							     LAN addressing, and it is the defect the netns isolation layer
							     exists to remove. -->
							<p
								class="border-status-warning/60 bg-status-warning/10 text-status-warning mt-1 flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs"
								role="status"
								data-testid="netif-router-cellular-collision"
							>
								<TriangleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
								<span>
									<span class="font-medium">
										{m["network.routerCellular.collisionTitle"]({ model: routerCellular.model })}
									</span>
									{' '}
									{m["network.routerCellular.collisionBody"]()}
								</span>
							</p>
						{/if}
						{#if modemNet}
							<!-- On screen, never only in the badge's `title`: the kiosk
							     touchscreen cannot hover, and "this is one device, not two" is
							     the whole reason this row stopped being a mystery. -->
							<p class="text-muted-foreground/80 mt-0.5 text-xs" data-testid="netif-modem-net-note">
								{m["network.modemNet.note"]({ model: modemNetName(modemNet) })}
							</p>
						{/if}
						{#if dongleBlocked}
							<!-- The disabled toggle's reason, ON SCREEN — a tooltip alone is
							     unreachable on the kiosk touchscreen this device ships with. -->
							<p class="text-muted-foreground/80 mt-0.5 text-xs" data-testid="netif-dongle-blocked-hint">
								{dongleBlocked}
							</p>
						{/if}
						{#if sharedLanReason}
							<!-- Same rule, same reason: the bond toggle below is disabled, and
							     the operator has to be able to READ why without hovering. -->
							<p
								class="text-muted-foreground/80 mt-0.5 text-xs"
								data-testid="netif-eth-role-excluded-hint"
							>
								{sharedLanReason}
							</p>
						{/if}
					</div>
					<div class="ms-auto flex shrink-0 items-center gap-2">
						{#if showStale}
							<Badge variant="stale" data-stale-interface={name} />
						{/if}
						<BondToggle
							name={name}
							enabled={iface.enabled}
							ip={iface.ip}
							disabledReason={dongleBlocked ?? sharedLanReason}
							onBeforeDisable={() => confirmDisable(name)}
						/>
						<Button
							class="h-8 min-h-[var(--touch-target-min)] gap-1 px-2.5"
							data-testid="open-netif-dialog"
							size="sm"
							variant="ghost"
							onclick={() => onConfigure(name)}
						>
							{m["network.view.configure"]()}
							<ChevronRight class="size-3.5 rtl:rotate-180" />
						</Button>
					</div>
				</div>
			{/each}
		{/if}
	</div>
</section>

<!-- Bond-exclusion confirm: gates BondToggle disable on wired links. -->
<AlertDialog.Root bind:open={confirmOpen} onOpenChange={(open) => !open && settle(false)}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>{m["network.view.wiredDisableTitle"]()}</AlertDialog.Title>
			<AlertDialog.Description>
				{m["network.view.wiredDisableBody"]()}
				{#if pendingName}
					<span class="text-foreground/80 mt-1 block font-mono text-xs">{pendingName}</span>
				{/if}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel onclick={() => settle(false)}>
				{m["dialog.cancel"]()}
			</AlertDialog.Cancel>
			<AlertDialog.Action
				class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
				onclick={() => settle(true)}
			>
				{m["network.view.disableBond"]()}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
