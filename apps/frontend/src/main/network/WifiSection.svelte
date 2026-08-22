<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { NetifMessage, WifiInterface } from '@ceraui/rpc/schemas';
import { Ban, ChevronRight, Globe, Loader2, Router, Settings2, Wifi } from '@lucide/svelte';

import BondToggle from '$lib/components/custom/BondToggle.svelte';
import SimpleAlertDialog from '$lib/components/custom/simple-alert-dialog.svelte';
import Badge from '$lib/components/custom/Badge.svelte';
import { Button } from '$lib/components/ui/button';
import { deriveWifiModeOutcome, isApRadio } from '$lib/helpers/wifi-mode-outcome';
import {
	confirmOperation,
	getOperationPhase,
	isOperationPending,
	osCommand,
} from '$lib/rpc/async-operation.svelte';
import { rpc } from '$lib/rpc/client';
import { cn } from '$lib/utils';

import HotspotDialog from '../dialogs/HotspotDialog.svelte';
import {
	blockIsOperatorActionable,
	deriveWifiCapabilityView,
	deriveWifiLinkView,
	wpa3ChipKey,
} from './wifi-capability-view';

interface Props {
	/** Every WiFi radio (record key → interface) — both station and hotspot mode. */
	wifiRadios: [string, WifiInterface][];
	/** Per-interface telemetry: bond membership (`enabled`), static `ip`. */
	netif: NetifMessage | undefined;
	/** Whole-app staleness latch: the WS has been down past the global threshold. */
	isFullyStale: boolean;
	/** ifnames whose own telemetry aged out while siblings stayed fresh (Task 22). */
	staleInterfaces: Set<string>;
	onConnect: (deviceId: string) => void;
	/**
	 * Open the regulatory-country surface. Required rather than optional: it is
	 * the only thing an operator can do about a 6 GHz band their domain forbids,
	 * and a missing handler would render that reason band with no way out.
	 */
	onOpenCountry: () => void;
}

const { wifiRadios, netif, isFullyStale, staleInterfaces, onConnect, onOpenCountry }: Props =
	$props();

// Chip vocabulary for the per-adapter capability strip. Everything here is a
// §2 tier-5 hardware tag, so it renders BELOW the row's state/action elements,
// one step smaller, and never in the phosphor-lime accent — that colour is
// reserved for the live signal.
const CHIP = 'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs';
const CHIP_NEUTRAL = 'border-border/70 bg-muted/40 text-muted-foreground';
const CHIP_BLOCKED = 'border-status-warning/40 bg-status-warning/10 text-status-warning';

function activeWifiNetwork(iface: WifiInterface) {
	return iface.available?.find((network) => network.active);
}

// ── Per-radio hotspot configurator (one mount, keyed by selected radio) ──
let hotspotDialogOpen = $state(false);
let hotspotDeviceId = $state('');
const hotspotIface = $derived(wifiRadios.find(([id]) => id === hotspotDeviceId)?.[1]);

function openHotspotSetup(id: string) {
	hotspotDeviceId = id;
	hotspotDialogOpen = true;
}

// ── Station ⇆ hotspot mode switching (a radio is ONE mode at a time) ──
// Switching to hotspot is destructive (drops the WiFi link + bond membership)
// so it is gated behind a confirm dialog; switching back to station is not.
//
// The transition is owned by the keyed async-operation store under
// `hotspot:${device}` — the SAME key HotspotDialog uses, so only one hotspot op
// per device is ever in flight (osCommand's re-entry guard enforces it). The
// per-device target is remembered locally so the confirm $effect below can flip
// the op to `confirmed` the moment the authoritative `wifi` snapshot reports the
// target mode, and so the label is held on the CURRENT mode until then — a raw
// `wifi` broadcast must never clobber the label mid-switch.
const switchTargets = $state<Record<string, 'hotspot' | 'station'>>({});

async function switchToHotspot(device: string) {
	switchTargets[device] = 'hotspot';
	await osCommand({
		key: `hotspot:${device}`,
		target: 'hotspot',
		rpc: () => rpc.wifi.hotspotStart({ device }),
		failMessage: () => m["network.os.operationFailed"](),
		busyMessage: () => m["network.os.deviceBusy"](),
	});
}

async function switchToStation(device: string) {
	switchTargets[device] = 'station';
	await osCommand({
		key: `hotspot:${device}`,
		target: 'station',
		rpc: () => rpc.wifi.hotspotStop({ device }),
		failMessage: () => m["network.os.operationFailed"](),
		busyMessage: () => m["network.os.deviceBusy"](),
	});
}

// Confirm a pending mode switch as soon as the authoritative `wifi` snapshot
// reports the target mode. The store's 15 s TTL valve is the backstop if the
// device never reports back (the op then decays to `timed_out`).
$effect(() => {
	for (const [id, iface] of wifiRadios) {
		if (getOperationPhase(`hotspot:${id}`) !== 'pending') continue;
		if (deriveWifiModeOutcome(switchTargets[id], isApRadio(iface)) === 'confirmed') {
			confirmOperation(`hotspot:${id}`);
		}
	}
});
</script>

<!-- ───────────── WiFi ───────────── -->
<section class="bg-card rounded-xl border">
	<div class="flex items-center gap-2 border-b px-4 py-3">
		<Wifi aria-hidden="true" class="text-muted-foreground size-4 shrink-0" />
		<h2 class="text-sm font-semibold tracking-tight">{m["network.view.wifi"]()}</h2>
	</div>
	<div class="divide-y">
		{#if wifiRadios.length === 0}
			<!-- Zero radios is a REAL board state, not a loading gap: some boards ship
			     without one, and on others the radio needs a driver the image does not
			     carry yet (the band above names that second case when it applies). It
			     says so rather than leaving an unexplained blank section. -->
			<div class="px-4 py-6 text-center" data-testid="wifi-no-adapter" role="status">
				<p class="text-sm font-medium">{m["network.view.noWifi"]()}</p>
				<p class="text-muted-foreground mx-auto mt-1 max-w-prose text-sm">
					{m["network.wifiCapability.noAdapterBody"]()}
				</p>
			</div>
		{:else}
			{#each wifiRadios as [id, iface] (id)}
				{@const entry = netif?.[iface.ifname]}
				{@const isHotspot = isApRadio(iface)}
				{@const isSwitching = isOperationPending(`hotspot:${id}`)}
				<!-- Hold the label on the CURRENT mode while a switch is pending: a raw
				     `wifi` broadcast must not flip it before the op is confirmed. -->
				{@const displayIsHotspot = isSwitching ? switchTargets[id] === 'station' : isHotspot}
				{@const net = activeWifiNetwork(iface)}
				{@const connected = !isHotspot && Boolean(iface.conn && net)}
				{@const ifaceStale = staleInterfaces.has(iface.ifname) || isFullyStale}
				{@const showStale = ifaceStale && !displayIsHotspot && connected}
				{@const hasIp = Boolean(entry?.ip)}
				<!-- `undefined` here is the device saying it never computed a capability
				     report (no `iw`, an unresolvable wiphy, a failed parse, or a backend
				     that predates the field). The strip then contributes NOTHING and the
				     row is byte-identical to what it rendered before this existed. -->
				{@const cap = deriveWifiCapabilityView(iface.capabilities)}
				<!-- The radio's CEILING is `cap`; this is what the station leg
				     negotiated. A Wi-Fi 7 adapter on an 802.11ac access point is
				     genuinely running VHT, so the two can differ and must. -->
				{@const link = deriveWifiLinkView(iface.link)}
				{@const blocked = cap?.blockedBands[0]}
				{@const wpa3Key = cap ? wpa3ChipKey(cap.wpa3Sae) : undefined}
				<!-- Single-line row: identity (dot · name · status) left; bond + actions right. -->
				<div class="flex flex-wrap items-center gap-3 px-4 py-2.5">
					<span
						class={cn(
							'size-2 shrink-0 rounded-full',
							displayIsHotspot ? 'bg-status-info' : connected ? 'bg-primary' : 'bg-muted-foreground/40',
						)}
						aria-hidden="true"
					></span>
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm font-medium">
							{#if displayIsHotspot}
								{iface.hotspot?.name || iface.ifname}
							{:else}
								{iface.ifname}
							{/if}
						</p>
						<p
							class={cn(
								'text-muted-foreground truncate text-xs transition-opacity',
								!displayIsHotspot && ifaceStale && 'opacity-50',
							)}
						>
							{#if displayIsHotspot}
								{m["network.view.hotspot"]()} · {iface.ifname}
							{:else if connected && net}
								{m["network.view.connected"]()} · {net.ssid}
							{:else}
								{m["network.view.disconnected"]()}
							{/if}
						</p>
						{#if !displayIsHotspot && link}
							<p
								class={cn(
									'text-muted-foreground mt-0.5 truncate text-xs transition-opacity',
									ifaceStale && 'opacity-50',
								)}
								data-testid="wifi-link-telemetry"
								data-device={id}
								data-generation={link.generation}
								data-width-mhz={link.channelWidthMhz}
							>
								<span class="opacity-70">{m["network.wifiCapability.linkLabel"]()}</span>
								<span class="font-mono" dir="ltr">
									{resolveMessageKey(link.generationLabelKey)}
									{#if link.channelWidthMhz !== undefined}
										&middot; {m["network.wifiCapability.width"]({ mhz: link.channelWidthMhz })}
									{/if}
									&middot; {m["network.wifiCapability.linkRate"]({ mbps: link.bitrateMbps })}
								</span>
							</p>
						{/if}
					</div>
					<div class="ms-auto flex shrink-0 items-center gap-2">
						{#if showStale}
							<Badge variant="stale" data-stale-interface={iface.ifname} />
						{/if}
						{#if displayIsHotspot}
							<!-- Hotspot mode: cannot bond; offer config + revert to station. -->
							<BondToggle
								name={iface.ifname}
								enabled={false}
								disabledReason={m["network.view.hotspotNoBond"]()}
							/>
							<Button
								class="h-8 min-h-[var(--touch-target-min)] gap-1.5 px-2.5"
								disabled={isSwitching}
								size="sm"
								variant="ghost"
								onclick={() => openHotspotSetup(id)}
							>
								<Settings2 class="size-3.5" />
								{m["network.view.setup"]()}
							</Button>
							<Button
								class="h-8 min-h-[var(--touch-target-min)] gap-1.5 px-2.5"
								disabled={isSwitching}
								size="sm"
								variant="secondary"
								onclick={() => switchToStation(id)}
							>
								{#if isSwitching}
									<Loader2 class="size-3.5 animate-spin motion-reduce:animate-none" />
								{:else}
									<Wifi class="size-3.5" />
								{/if}
								{m["network.view.switchToStation"]()}
							</Button>
						{:else}
							<!-- Station mode: bond when it holds an IP; connect to a network;
							     offer switch to hotspot. Connect renders regardless of `hasIp`
							     so a disconnected radio can still open its own selector. -->
							{#if hasIp}
								<BondToggle
									name={iface.ifname}
									enabled={Boolean(entry?.enabled)}
									ip={entry?.ip}
								/>
							{/if}
							<Button
								class="h-8 min-h-[var(--touch-target-min)] gap-1 px-2.5"
								data-testid="open-wifi-selector-dialog"
								data-device={id}
								size="sm"
								variant="ghost"
								onclick={() => onConnect(id)}
							>
								{m["network.view.connect"]()}
								<ChevronRight class="size-3.5 rtl:rotate-180" />
							</Button>
							{#if iface.supports_hotspot}
								{#if isSwitching}
									<!-- Switch confirmed at the click; hold a spinner until the
									     authoritative snapshot flips the label to hotspot. Icon-only
									     to match the row's action-button density (a11y name via
									     aria-label since there is no visible text). -->
									<Button
										class="h-8 w-8 min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)] p-0 shadow-none"
										aria-label={m["network.view.switchToHotspot"]()}
										title={m["network.view.switchToHotspot"]()}
										disabled
										size="sm"
										variant="ghost"
									>
										<Loader2 class="size-3.5 animate-spin motion-reduce:animate-none" />
									</Button>
								{:else}
									<SimpleAlertDialog
										buttonAriaLabel={m["network.view.switchToHotspot"]()}
										confirmButtonText={m["network.view.hotspotSwitchConfirm"]()}
										confirmVariant="destructive"
										extraButtonClasses="h-8 w-8 min-h-[var(--touch-target-min)] min-w-[var(--touch-target-min)] p-0 shadow-none hover:shadow-none bg-transparent text-foreground hover:bg-muted hover:text-foreground dark:hover:bg-muted/50"
										iconPosition="left"
										title={m["network.view.switchToHotspot"]()}
										onconfirm={() => switchToHotspot(id)}
									>
										{#snippet icon()}
											<Router class="size-3.5" />
										{/snippet}
										{#snippet dialogTitle()}
											{m["network.view.hotspotSwitchTitle"]()}
										{/snippet}
										{#snippet description()}
											{m["network.view.hotspotSwitchBody"]()}
										{/snippet}
									</SimpleAlertDialog>
								{/if}
							{/if}
						{/if}
					</div>

					{#if cap}
						<div
							class="basis-full space-y-1.5 ps-5"
							data-testid="wifi-capabilities"
							data-device={id}
							data-generation={cap.generation}
							data-phy={cap.phy}
						>
							<div class="flex flex-wrap items-center gap-1.5">
								<!-- NEVER inferred: the shipped RTL8852BE prints all-zero EHT
								     structures, so anything but the wire's own verdict would
								     stamp Wi-Fi 7 on a Wi-Fi 6 radio. -->
								<span
									class={cn(CHIP, 'border-border bg-muted/60 text-foreground font-semibold')}
									data-testid="wifi-generation-badge"
									data-generation={cap.generation}
								>
									{resolveMessageKey(cap.generationLabelKey)}
								</span>

								{#each cap.bands as band (band.band)}
									<span
										class={cn(CHIP, band.available ? CHIP_NEUTRAL : CHIP_BLOCKED)}
										data-testid="wifi-band-option"
										data-band={band.band}
										data-available={band.available}
										data-blocked-by={band.blockedBy}
										aria-disabled={band.available ? undefined : 'true'}
									>
										{#if !band.available}
											<Ban aria-hidden="true" class="size-3 shrink-0" />
										{/if}
										{resolveMessageKey(band.labelKey)}
										{#if band.maxWidthMhz !== undefined}
											<span class="font-mono opacity-70" dir="ltr"
												>{m["network.wifiCapability.width"]({ mhz: band.maxWidthMhz })}</span
											>
										{/if}
									</span>
								{/each}

								{#if wpa3Key}
									<span
										class={cn(CHIP, CHIP_NEUTRAL)}
										data-testid="wifi-wpa3"
										data-state={cap.wpa3Sae}
									>
										{resolveMessageKey(wpa3Key)}
									</span>
								{/if}
							</div>

							{#if blocked}
								<!-- The band exists on this radio and is unavailable right now, so
								     it stays on screen with its reason. Hiding it would be
								     indistinguishable from a radio that cannot do 6 GHz at all. -->
								{@const actionable = blockIsOperatorActionable(blocked)}
								<div
									class={cn(
										'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-2.5 py-1.5',
										actionable
											? 'border-status-warning/30 bg-status-warning/10'
											: 'border-status-info/30 bg-status-info/10',
									)}
									data-testid="wifi-band-blocked-reason"
									data-band={blocked.band}
									data-blocked-by={blocked.blockedBy}
									role="status"
								>
									<span class="text-xs">
										{#if blocked.blockedBy === 'self-managed'}
											{m["network.wifiCapability.blocked.selfManaged"]()}
										{:else if cap.countryIsWorld}
											{m["network.wifiCapability.blocked.worldDomain"]()}
										{:else}
											{m["network.wifiCapability.blocked.regulatory"]({ country: cap.country })}
										{/if}
									</span>
									{#if actionable}
										<!-- Offered ONLY for a domain block. A self-managed wiphy
										     carries its own regulatory rules, so the country dialog
										     could not move it and the button would be a control that
										     cannot act. -->
										<Button
											class="h-7 min-h-[var(--touch-target-min)] gap-1.5 px-2"
											data-testid="wifi-open-country"
											data-device={id}
											size="sm"
											variant="secondary"
											onclick={onOpenCountry}
										>
											<Globe class="size-3.5" />
											{m["network.wifiCapability.setCountry"]()}
										</Button>
									{/if}
								</div>
							{/if}

							{#if cap.comboNoteKey}
								<p
									class="text-muted-foreground text-xs"
									data-testid="wifi-sta-ap-combo"
									data-same-channel={cap.comboNoteKey.endsWith('sameChannel')}
								>
									{resolveMessageKey(cap.comboNoteKey)}
								</p>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>
</section>

<!-- Per-radio hotspot configurator -->
{#if hotspotIface}
	<HotspotDialog bind:open={hotspotDialogOpen} deviceId={hotspotDeviceId} iface={hotspotIface} />
{/if}
