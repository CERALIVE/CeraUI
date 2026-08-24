<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { NetifMessage, WifiInterface } from '@ceraui/rpc/schemas';
import { Ban, ChevronRight, Globe, Settings2, TriangleAlert, Wifi } from '@lucide/svelte';

import BondToggle from '$lib/components/custom/BondToggle.svelte';
import Badge from '$lib/components/custom/Badge.svelte';
import { LazyDialog, lazyDialog } from '$lib/components/dialogs';
import { Button } from '$lib/components/ui/button';
import {
	getOperationPhase,
	getOperationReason,
	getOperationTarget,
	isOperationPending,
} from '$lib/rpc/async-operation.svelte';
import { hotspotIsActive } from '$lib/rpc/os-toggle-predicates';
import {
	getWifiAdapterModeEntry,
	refreshWifiAdapterModes,
} from '$lib/rpc/wifi-adapter-modes.svelte';
import { cn } from '$lib/utils';

import WifiModeBadge from './WifiModeBadge.svelte';
import WifiModeSelector from './WifiModeSelector.svelte';
import { deriveWifiAdapterModeView, wifiModeTarget } from './wifi-adapter-mode-view';
import {
	blockIsOperatorActionable,
	deriveWifiCapabilityView,
	deriveWifiLinkView,
	wpa3ChipKey,
} from './wifi-capability-view';
import {
	deriveWifiStationLock,
	wifiHotspotOpKey,
	wifiModeOpKey,
} from './wifi-station-lock';

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
// Registry-loaded, like every other config dialog. A static import here also
// defeated NetworkView's OWN lazy registration of the same component — rolldown
// reported `INEFFECTIVE_DYNAMIC_IMPORT` and fused it back into the entry chunk.
const HotspotDialog = lazyDialog(() => import('../dialogs/HotspotDialog.svelte'));

let hotspotDialogOpen = $state(false);
let hotspotDeviceId = $state('');
const hotspotIface = $derived(wifiRadios.find(([id]) => id === hotspotDeviceId)?.[1]);

function openHotspotSetup(id: string) {
	hotspotDeviceId = id;
	hotspotDialogOpen = true;
}

// ── The per-adapter mode offering (station / hotspot / hybrid) ──
// The offering is a PULL, so it is re-read whenever the set of radios changes —
// a newly-plugged adapter has no entry until we ask for one. `refresh` is
// self-serialising, so a re-render cannot stack duplicate reads.
const radioIds = $derived(wifiRadios.map(([id]) => id).join(','));
$effect(() => {
	void radioIds;
	void refreshWifiAdapterModes();
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
				{@const isSwitching = isOperationPending(wifiHotspotOpKey(id))}
				<!-- ONE derivation per adapter. The row's identity line, its selector,
				     HotspotSection's card and HotspotDialog's header all read this same
				     shape, so the mode they display cannot disagree. -->
				{@const modeView = deriveWifiAdapterModeView({
					device: id,
					iface,
					entry: getWifiAdapterModeEntry(id),
					phase: getOperationPhase(wifiModeOpKey(id)),
					target: wifiModeTarget(getOperationTarget(wifiModeOpKey(id))),
					failureReason: getOperationReason(wifiModeOpKey(id)),
				})}
				{@const isHotspot = modeView.displayMode === 'hotspot'}
				<!-- A radio mid-transition holds its own adapter lock, so every station
				     mutation dispatched into that window is refused DEVICE_BUSY. The
				     controls therefore stay put and go disabled-with-reason rather than
				     staying live and failing, and the reason is rendered ON SCREEN — the
				     kiosk touchscreen cannot hover to reveal a `title`. Reads todo 7's
				     `wifi-mode:` key too: it answers `idle` until that control exists, so
				     this is inert today and cannot be forgotten when it lands. -->
				{@const stationLock = deriveWifiStationLock({
					hotspot: getOperationPhase(wifiHotspotOpKey(id)),
					mode: getOperationPhase(wifiModeOpKey(id)),
				})}
				{@const stationLockReason = stationLock.reasonKey
					? resolveMessageKey(stationLock.reasonKey)
					: undefined}
				{@const net = activeWifiNetwork(iface)}
				{@const connected = !isHotspot && Boolean(iface.conn && net)}
				{@const ifaceStale = staleInterfaces.has(iface.ifname) || isFullyStale}
				{@const showStale = ifaceStale && !isHotspot && connected}
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
							isHotspot ? 'bg-status-info' : connected ? 'bg-primary' : 'bg-muted-foreground/40',
						)}
						aria-hidden="true"
					></span>
					<div class="min-w-0 flex-1">
						<p class="truncate text-sm font-medium">
							{#if isHotspot}
								{iface.hotspot?.name || iface.ifname}
							{:else}
								{iface.ifname}
							{/if}
						</p>
						<p
							class={cn(
								'text-muted-foreground truncate text-xs transition-opacity',
								!isHotspot && ifaceStale && 'opacity-50',
							)}
						>
							{#if isHotspot}
								{m["network.view.hotspot"]()} · {iface.ifname}
							{:else if connected && net}
								{m["network.view.connected"]()} · {net.ssid}
							{:else}
								{m["network.view.disconnected"]()}
							{/if}
						</p>
						{#if !isHotspot && link}
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
						<WifiModeBadge device={id} mode={modeView.displayMode} />
						{#if isHotspot}
							<!-- Exclusive AP: the radio carries no station leg, so it cannot bond. -->
							<BondToggle
								name={iface.ifname}
								enabled={false}
								disabledReason={m["network.view.hotspotNoBond"]()}
							/>
						{:else}
							<!-- Station and hybrid both keep a station leg, so both keep the bond
							     toggle and Connect. Connect renders regardless of `hasIp` so a
							     disconnected radio can still open its own selector. -->
							{#if hasIp}
								<BondToggle
									name={iface.ifname}
									enabled={Boolean(entry?.enabled)}
									ip={entry?.ip}
									disabledReason={stationLock.locked ? stationLockReason : undefined}
								/>
							{/if}
							<Button
								class="h-8 min-h-[var(--touch-target-min)] gap-1 px-2.5"
								data-testid="open-wifi-selector-dialog"
								data-device={id}
								data-locked={stationLock.locked ? 'true' : undefined}
								disabled={stationLock.locked}
								size="sm"
								title={stationLockReason}
								variant="ghost"
								onclick={() => onConnect(id)}
							>
								{m["network.view.connect"]()}
								<ChevronRight class="size-3.5 rtl:rotate-180" />
							</Button>
						{/if}
						{#if modeView.displayMode !== 'station'}
							<Button
								class="h-8 min-h-[var(--touch-target-min)] gap-1.5 px-2.5"
								data-testid="open-hotspot-setup"
								data-device={id}
								disabled={isSwitching}
								size="sm"
								variant="ghost"
								onclick={() => openHotspotSetup(id)}
							>
								<Settings2 class="size-3.5" />
								{m["network.view.setup"]()}
							</Button>
						{/if}
					</div>

					<div class="basis-full ps-5">
						<WifiModeSelector
							view={modeView}
							context={{
								stationLinkLive: connected || Boolean(entry?.enabled),
								hotspotLive: hotspotIsActive(iface),
							}}
							lockedReason={isSwitching ? stationLockReason : undefined}
							compact
						/>
					</div>

					{#if stationLock.locked && stationLockReason && !isHotspot}
						<p
							class="text-status-warning basis-full ps-5 text-xs"
							data-device={id}
							data-lock-kind={stationLock.kind}
							data-testid="wifi-station-locked"
							role="status"
						>
							{stationLockReason}
						</p>
					{:else if stationLock.failureKind === 'hotspot' && stationLock.failureTitleKey && stationLock.failureBodyKey}
						<!-- The lock ALWAYS lifts: every phase behind it is terminal, either
						     from the device's own frame or from the store's TTL valve. So the
						     row's job at that point is to say which one happened — a refusal
						     and a result that never arrived are different facts.

						     A MODE failure is deliberately NOT rendered here: the selector
						     below states the same terminal with the device's own typed reason,
						     and one fact announced twice reads as two failures. -->
						<div
							class="border-status-warning/30 bg-status-warning/10 ms-5 flex basis-full items-start gap-2 rounded-lg border px-2.5 py-1.5"
							data-device={id}
							data-failure-kind={stationLock.failureKind}
							data-testid="wifi-station-lock-failed"
							role="status"
						>
							<TriangleAlert aria-hidden="true" class="text-status-warning mt-0.5 size-3.5 shrink-0" />
							<div class="min-w-0">
								<p class="text-status-warning text-xs font-semibold">
									{resolveMessageKey(stationLock.failureTitleKey)}
								</p>
								<p class="text-muted-foreground mt-0.5 text-xs">
									{resolveMessageKey(stationLock.failureBodyKey)}
								</p>
							</div>
						</div>
					{/if}

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
	<LazyDialog
		dialog={HotspotDialog}
		bind:open={hotspotDialogOpen}
		deviceId={hotspotDeviceId}
		iface={hotspotIface}
	/>
{/if}
