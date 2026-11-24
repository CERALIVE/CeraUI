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
import Badge from '$lib/components/custom/Badge.svelte';
import BondToggle from '$lib/components/custom/BondToggle.svelte';
import InfoPopover from '$lib/components/custom/InfoPopover.svelte';
import * as AlertDialog from '$lib/components/ui/alert-dialog';
import { Button } from '$lib/components/ui/button';
import { isLinkLocalIpv4 } from '$lib/helpers/ip-classification';
import { interfaceLabel } from '$lib/helpers/link-names';

import { deriveSharedLanRow, type EthernetClientZoneState } from './ethernet-role-view';
import NetworkRow from './NetworkRow.svelte';

interface Props {
	/** NetworkView applies the marker + modem-claim handover in section-assignment.ts. */
	wiredEntries: [string, NetifEntry][];
	linkName?: (ifname: string) => string;
	/** Whole-app staleness latch: the WS has been down past the global threshold. */
	isFullyStale: boolean;
	/** ifnames whose own telemetry aged out while siblings stayed fresh (Task 22). */
	staleInterfaces: Set<string>;
	onConfigure: (name: string) => void;
}

const { wiredEntries, linkName = interfaceLabel, isFullyStale, staleInterfaces, onConfigure }: Props = $props();

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
// its client zone is doing, and WHY it carries no bonded traffic.
//
// All three still render — but as ONE pill plus one explainer, not three stacked
// blocks. The role and the zone are the same fact read at two grains ("this port
// serves clients" / "the zone is up"), so splitting them across two pills bought
// a second line and no information, and the WHY was a standing paragraph of prose
// under a row whose own state is four words. The pill therefore takes the ZONE's
// colour (the half that changes) and the exclusion reason moves into the "?"
// explainer beside it. Nothing is lost: the reason is ALSO the disabled bond
// toggle's accessible name, and the toggle still prints `Excluded` on screen.
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
	<div class="flex items-center gap-2 border-b px-4 py-2">
		<NetworkIcon aria-hidden="true" class="text-muted-foreground size-4 shrink-0" />
		<h2 class="text-sm font-semibold tracking-tight">{m["network.view.ethernet"]()}</h2>
	</div>
	<div class="divide-y">
		{#if wiredEntries.length === 0}
			<p class="text-muted-foreground px-4 py-4 text-center text-sm">
				{m["network.view.noEthernet"]()}
			</p>
		{:else}
			{#each wiredEntries as [name, iface] (name)}
				{const showStale = $derived(iface.enabled && (staleInterfaces.has(name) || isFullyStale))}
				{const linkLocal = $derived(isLinkLocalIpv4(iface.ip))}
				<!-- `null` is the backend RETRACTING the claim; the ingestion merge prunes
				     the row on that frame, so it is normalised away rather than rendered. -->
				{const dongle = $derived(iface.dongle ?? undefined)}
				{const dongleBlocked = $derived(dongle ? dongleBondBlockedReason(dongle.state) : undefined)}
				<!-- `null` retracts the classification but KEEPS the row (unlike `dongle`),
				     so it is normalised to "unclassified" rather than pruned. -->
				{const routerCellular = $derived(iface.router_cellular ?? undefined)}
				<!-- `null` retracts this claim and KEEPS the row too. -->
				{const modemNet = $derived(iface.usb_modem_net ?? undefined)}
				<!-- Absent `ethRole` means "not an ethernet port, or an older backend",
				     never `uplink`, so an unclaimed row renders exactly as before. -->
				{const sharedLan = $derived(deriveSharedLanRow(iface))}
				{const sharedLanReason = $derived(sharedLan
					? resolveMessageKey(sharedLan.bondExclusionReasonKey)
					: undefined)}
				<NetworkRow
					data-testid="netif-row"
					data-ifname={name}
					dotClass={iface.enabled ? 'bg-primary' : 'bg-muted-foreground/40'}
				>
					{#snippet heading()}{linkName(name)}{/snippet}
					<!-- A `shared-lan` port's ONE pill — what the port IS · what its zone is
					     doing — rides the name's line; the "?" beside it carries the concept
					     AND the bond-exclusion reason. -->
					{#snippet identity()}
						{#if sharedLan}
							{const ZoneIcon = $derived(ZONE_ICON[sharedLan.zone])}
							<Badge
								variant={ZONE_VARIANT[sharedLan.zone]}
								size="micro"
								class={MICRO_TEXT}
								data-testid="netif-eth-role"
								data-eth-role="shared-lan"
								title={m["network.ethRole.badgeHint"]()}
							>
								<Share2 class="size-3" aria-hidden="true" />
								{m["network.ethRole.sharedLan"]()}
								<span aria-hidden="true">·</span>
								<span
									class="inline-flex items-center gap-1"
									data-testid="netif-eth-role-zone"
									data-zone={sharedLan.zone}
								>
									<ZoneIcon class="size-3" aria-hidden="true" />
									{resolveMessageKey(sharedLan.zoneLabelKey)}
								</span>
							</Badge>
							<InfoPopover
								ariaLabel={m["network.ethRole.open"]()}
								body={m["network.ethRole.badgeHint"]()}
								reason={sharedLanReason}
								reasonTestId="netif-eth-role-excluded-hint"
								testId="netif-eth-role-info"
								title={m["network.ethRole.sharedLan"]()}
							/>
						{/if}
					{/snippet}
					<!-- THE ADDRESS, AND NOTHING ABOUT THE BOND: the toggle states membership
					     once. Then the class of an unclaimed cellular device, in words. -->
					{#snippet status()}
						{#if iface.ip}
							<code class="font-mono">{iface.ip}</code>
							{#if linkLocal}
								<!-- Calm, informational: 169.254/16 is an automatic OS address, not a
								     stuck static config. It rides the address's own line — a wrapped
								     clause reads as part of the reading it explains, a stacked
								     paragraph reads as a second finding. -->
								<Badge variant="info" size="micro" data-testid="netif-link-local" label={m["network.view.linkLocal"]()} />
								<span data-testid="netif-link-local-hint">
									{m["network.view.linkLocalHint"]()}
								</span>
							{/if}
						{/if}
						{#if dongle}
							{const StateIcon = $derived(DONGLE_STATE_ICON[dongle.state])}
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
						{/if}
						{#if modemNet}
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
						{/if}
						{#if routerCellular}
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
						{/if}
						{#if showStale}
							<Badge variant="stale" data-stale-interface={name} />
						{/if}
					{/snippet}
					{#snippet bond()}
						<BondToggle
							name={name}
							enabled={iface.enabled}
							ip={iface.ip}
							disabledReason={dongleBlocked ?? sharedLanReason}
							onBeforeDisable={() => confirmDisable(name)}
						/>
					{/snippet}
					<!-- Which unit: the descriptor identity, demoted by size, never by contrast. -->
					{#snippet meta()}
						{#if modemNet}
							<p
								class="text-muted-foreground font-mono text-(length:--text-micro) wrap-anywhere"
								data-testid="netif-modem-net-identity"
							>
								{modemNetName(modemNet)} · {modemNet.vid_pid}
							</p>
						{/if}
						{#if routerCellular}
							<p
								class="text-muted-foreground font-mono text-(length:--text-micro) wrap-anywhere"
								data-testid="netif-router-cellular-identity"
							>
								{routerCellularName(routerCellular)} · {routerCellular.vid_pid}
							</p>
						{/if}
					{/snippet}
					{#snippet reasons()}
						{#if routerCellular}
							<!-- ALWAYS present, because the address is the thing an operator
							     will otherwise try to change and cannot: it is leased by the
							     dongle's own DHCP server. A tooltip alone is unreachable on the
							     kiosk touchscreen this device ships with. -->
							<p
								class="text-muted-foreground text-xs"
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
							<p class="text-muted-foreground text-xs" data-testid="netif-modem-net-note">
								{m["network.modemNet.note"]({ model: modemNetName(modemNet) })}
							</p>
						{/if}
						{#if dongleBlocked}
							<!-- The disabled toggle's reason, ON SCREEN — a tooltip alone is
							     unreachable on the kiosk touchscreen this device ships with. -->
							<p class="text-muted-foreground text-xs" data-testid="netif-dongle-blocked-hint">
								{dongleBlocked}
							</p>
						{/if}
					{/snippet}
					{#snippet actions()}
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
					{/snippet}
				</NetworkRow>
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
