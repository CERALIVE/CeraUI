<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { NetifMessage, WifiInterface } from '@ceraui/rpc/schemas';
import {
	Ban,
	Check,
	ChevronRight,
	CircleOff,
	Globe,
	Router,
	Settings2,
	SlidersHorizontal,
	TriangleAlert,
	Wifi,
} from '@lucide/svelte';
import Badge from '$lib/components/custom/Badge.svelte';
import BondToggle from '$lib/components/custom/BondToggle.svelte';
import { LazyDialog, lazyDialog } from '$lib/components/dialogs';
import { Button } from '$lib/components/ui/button';
import * as Popover from '$lib/components/ui/popover';
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

import NetworkRow from './NetworkRow.svelte';
import WifiModeBadge from './WifiModeBadge.svelte';
import WifiModeErrorBand from './WifiModeErrorBand.svelte';
import WifiModeSelector from './WifiModeSelector.svelte';
import { deriveWifiAdapterModeView, wifiModeFrom, wifiModeTarget } from './wifi-adapter-mode-view';
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
	linkName?: (ifname: string) => string;
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

const { wifiRadios, linkName, netif, isFullyStale, staleInterfaces, onConnect, onOpenCountry }: Props =
	$props();

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
	<div class="flex items-center gap-2 border-b px-4 py-2">
		<Wifi aria-hidden="true" class="text-muted-foreground size-4 shrink-0" />
		<h2 class="text-sm font-semibold tracking-tight">{m["network.view.wifi"]()}</h2>
	</div>
	<div class="divide-y">
		{#if wifiRadios.length === 0}
			<!-- Zero radios is a REAL board state, not a loading gap: some boards ship
			     without one, and on others the radio needs a driver the image does not
			     carry yet (the band above names that second case when it applies). It
			     says so rather than leaving an unexplained blank section. -->
			<div class="px-4 py-4 text-center" data-testid="wifi-no-adapter" role="status">
				<p class="text-sm font-medium">{m["network.view.noWifi"]()}</p>
				<p class="text-muted-foreground mx-auto mt-1 max-w-prose text-sm">
					{m["network.wifiCapability.noAdapterBody"]()}
				</p>
			</div>
		{:else}
			{#each wifiRadios as [id, iface] (id)}
				{const entry = $derived(netif?.[iface.ifname])}
				{const isSwitching = $derived(isOperationPending(wifiHotspotOpKey(id, iface.incarnation)))}
				<!-- ONE derivation per adapter. The row's identity line, its selector,
				     HotspotSection's card and HotspotDialog's header all read this same
				     shape, so the mode they display cannot disagree. -->
				{const modeView = $derived(deriveWifiAdapterModeView({
					device: id,
					iface,
					entry: getWifiAdapterModeEntry(id),
					phase: getOperationPhase(wifiModeOpKey(id, iface.incarnation)),
					target: wifiModeTarget(getOperationTarget(wifiModeOpKey(id, iface.incarnation))),
					from: wifiModeFrom(getOperationTarget(wifiModeOpKey(id, iface.incarnation))),
					failureReason: getOperationReason(wifiModeOpKey(id, iface.incarnation)),
				}))}
				{const isHotspot = $derived(modeView.displayMode === 'hotspot')}
				<!-- A radio mid-transition holds its own adapter lock, so every station
				     mutation dispatched into that window is refused DEVICE_BUSY. The
				     controls therefore stay put and go disabled-with-reason rather than
				     staying live and failing, and the reason is rendered ON SCREEN — the
				     kiosk touchscreen cannot hover to reveal a `title`. Reads todo 7's
				     `wifi-mode:` key too: it answers `idle` until that control exists, so
				     this is inert today and cannot be forgotten when it lands. -->
				{const stationLock = $derived(deriveWifiStationLock({
					hotspot: getOperationPhase(wifiHotspotOpKey(id, iface.incarnation)),
					mode: getOperationPhase(wifiModeOpKey(id, iface.incarnation)),
				}))}
				{const stationLockReason = $derived(stationLock.reasonKey
					? resolveMessageKey(stationLock.reasonKey)
					: undefined)}
				{const net = $derived(activeWifiNetwork(iface))}
				{const connected = $derived(!isHotspot && Boolean(iface.conn && net))}
				{const ifaceStale = $derived(staleInterfaces.has(iface.ifname) || isFullyStale)}
				{const showStale = $derived(ifaceStale && !isHotspot && connected)}
				{const hasIp = $derived(Boolean(entry?.ip))}
				<!-- `undefined` here is the device saying it never computed a capability
				     report (no `iw`, an unresolvable wiphy, a failed parse, or a backend
				     that predates the field). The strip then contributes NOTHING and the
				     row is byte-identical to what it rendered before this existed. -->
				{const cap = $derived(deriveWifiCapabilityView(iface.capabilities))}
				<!-- The radio's CEILING is `cap`; this is what the station leg
				     negotiated. A Wi-Fi 7 adapter on an 802.11ac access point is
				     genuinely running VHT, so the two can differ and must. -->
				{const link = $derived(deriveWifiLinkView(iface.link))}
				{const degradedReasonKey = $derived(iface.degraded_reason
					? `network.wifiDegraded.${iface.degraded_reason}`
					: undefined)}
				{const blocked = $derived(cap?.blockedBands[0])}
				{const wpa3Key = $derived(cap ? wpa3ChipKey(cap.wpa3Sae) : undefined)}
				<NetworkRow
					data-testid="wifi-row"
					data-device={id}
					data-ifname={iface.ifname}
					dotClass={isHotspot ? 'bg-status-info' : connected ? 'bg-primary' : 'bg-muted-foreground/40'}
				>
					{#snippet heading()}
						{#if isHotspot}
							{iface.hotspot?.name || iface.ifname}
						{:else}
							{linkName?.(iface.ifname) ?? iface.ifname}
						{/if}
					{/snippet}
					<!-- The mode is a property of the RADIO, so its badge rides the radio's
					     name and the mode fact renders exactly once per row. -->
					{#snippet identity()}<WifiModeBadge device={id} mode={modeView.displayMode} />{/snippet}
					<!-- A degraded radio's reason is stated once, whole, in its warning band
					     below; the status line does not repeat it. -->
					{#snippet status()}
						{#if !degradedReasonKey}
							<span
								class={cn(
									'inline-flex min-w-0 flex-wrap items-center gap-x-1 wrap-anywhere transition-opacity',
									!isHotspot && ifaceStale && 'opacity-50',
								)}
							>
								{#if isHotspot}
									<Router class="text-status-info size-3.5 shrink-0" aria-hidden="true" />
									<span class="text-foreground font-medium">{m["network.view.hotspot"]()}</span>{' · '}{iface.ifname}
								{:else if connected && net}
									<Check class="text-status-success size-3.5 shrink-0" aria-hidden="true" />
									<span class="text-foreground font-medium">{m["network.view.connected"]()}</span>{#if !linkName}{' · '}{net.ssid}{/if}
								{:else}
									<CircleOff class="size-3.5 shrink-0" aria-hidden="true" />
									{m["network.view.disconnected"]()}
								{/if}
							</span>
						{/if}
						{#if !degradedReasonKey && showStale}
							<Badge variant="stale" data-stale-interface={iface.ifname} />
						{/if}
					{/snippet}
					{#snippet bond()}
						{#if !degradedReasonKey}
							{#if isHotspot}
								<!-- Exclusive AP: the radio carries no station leg, so it cannot bond. -->
								<BondToggle
									name={iface.ifname}
									enabled={false}
									disabledReason={m["network.view.hotspotNoBond"]()}
								/>
							{:else if hasIp}
									<BondToggle
										name={iface.ifname}
										enabled={Boolean(entry?.enabled)}
										ip={entry?.ip}
										disabledReason={stationLock.locked ? stationLockReason : undefined}
									/>
							{/if}
						{/if}
					{/snippet}
					<!-- THE BODY WRAPPER IS UNCONDITIONAL, and that is load-bearing: `wifi-link-telemetry` and `wifi-capabilities` are pinned
					     by byte-identity locks that delete the node and compare the row against
					     a legacy render, so no wrapper may exist only when one of them does. -->
					{#snippet meta()}
						<!-- WHAT IT NEGOTIATED, BESIDE WHAT IT CAN DO. This line reports the
						     CONNECTION and the strip below reports the RADIO, so the two
						     legitimately differ — a Wi-Fi 7 adapter on an 802.11ac access point
						     really is running VHT — and that difference is the reading. It used
						     to be the identity column's third line, two blocks away from the
						     ceiling it should be read against. -->
						{#if !isHotspot && link}
							<p
								class={cn(
									'text-muted-foreground text-xs wrap-anywhere transition-opacity',
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

					{/snippet}
					{#snippet reasons()}
							{#if degradedReasonKey}
								<div
									class="border-status-warning/30 bg-status-warning/10 flex items-start gap-2 rounded-lg border px-2.5 py-1.5"
									data-reason={iface.degraded_reason}
									data-testid="wifi-adapter-degraded"
									role="status"
								>
									<TriangleAlert aria-hidden="true" class="text-status-warning mt-0.5 size-3.5 shrink-0" />
									<p class="text-muted-foreground text-xs">{resolveMessageKey(degradedReasonKey)}</p>
								</div>
							{/if}
						{#if stationLock.locked && stationLockReason && !isHotspot}
							<p
								class="text-status-warning text-xs"
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

							     A MODE failure is deliberately NOT rendered here: the band below
							     states the same terminal with the device's own typed reason, and
							     one fact announced twice reads as two failures. -->
							<div
								class="border-status-warning/30 bg-status-warning/10 flex items-start gap-2 rounded-lg border px-2.5 py-1.5"
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

						<!-- The mode selector lives in a popover the operator can dismiss, so
						     the row keeps its terminal failure instead: an outcome nobody can
						     see is an outcome that did not happen. `WifiModeSelector` withholds
						     its own copy (`errorPlacement="host"`) so this fact renders once. -->
						{#if modeView.errorKey}
							<WifiModeErrorBand device={id} error={modeView.error} errorKey={modeView.errorKey} />
						{/if}

					{/snippet}
					{#snippet actions()}
						{#if !degradedReasonKey}
							{#if !isHotspot}
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
						<!-- The three-rung selector is a CHOICE an operator makes rarely, so it
						     no longer occupies the row at rest. It keeps every rule it had —
						     all three rungs on screen, each withheld one stating its reason,
						     the destructive confirm inline — just inside a popover instead of
						     under the row. Its TERMINAL FAILURE deliberately does NOT come
						     with it: a dismissed popover cannot report an outcome, so the row
						     hosts that band itself (see the secondary region below). -->
							<Popover.Root>
							<Popover.Trigger
								class="focus-visible:ring-ring text-muted-foreground hover:bg-accent/50 hover:text-foreground inline-flex h-8 min-h-[var(--touch-target-min)] items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors outline-hidden focus-visible:ring-2"
								data-testid="open-wifi-mode"
								data-device={id}
								data-pending={modeView.pending ? 'true' : undefined}
								title={m["network.wifiMode.label"]()}
								type="button"
							>
								<SlidersHorizontal aria-hidden="true" class="size-3.5 shrink-0" />
								{m["network.wifiMode.open"]()}
							</Popover.Trigger>
							<Popover.Content
								align="end"
								class="max-h-[var(--bits-popover-content-available-height)] w-80 overflow-y-auto"
								data-testid="wifi-mode-popover-{id}"
							>
								<Popover.Header>
									<Popover.Title>{m["network.wifiMode.label"]()}</Popover.Title>
								</Popover.Header>
								<WifiModeSelector
									view={modeView}
									context={{
										stationLinkLive: connected || Boolean(entry?.enabled),
										hotspotLive: hotspotIsActive(iface),
									}}
									errorPlacement="host"
									lockedReason={isSwitching ? stationLockReason : undefined}
								/>
							</Popover.Content>
							</Popover.Root>
						{:else if iface.degraded_reason === 'permanent-mac-unresolved'}
							{#if hotspotIsActive(iface)}
								<Button data-testid="open-hotspot-details" size="sm" variant="ghost" onclick={() => openHotspotSetup(id)}>
									{m["network.dialog.hotspotDetails"]()}
								</Button>
							{:else}
								<Button data-testid="open-wifi-selector-dialog" size="sm" variant="ghost" onclick={() => onConnect(id)}>
									{m["network.view.connect"]()}
								</Button>
							{/if}
							<WifiModeSelector view={modeView} context={{ stationLinkLive: connected, hotspotLive: hotspotIsActive(iface) }} />
						{/if}
					{/snippet}
					{#snippet details()}
					<!-- WHAT THE RADIO CAN DO, ON REQUEST. Every chip here is a §2 tier-5
					     hardware tag — a ceiling that changes only when the hardware or the
					     regulatory domain does — so at rest it is noise stacked under a row
					     whose job is to report a live link. It is DEMOTED, never dropped:
					     the disclosure keeps each fact one tap away, blocked band and its
					     "Set country" escape included.

					     The `<details>` itself carries `data-testid="wifi-capabilities"`, so
					     the byte-identity lock that deletes that node and compares the row
					     against a report-less render still removes the whole disclosure. -->
					{#if cap}
						<details
							class="group ps-5"
							data-testid="wifi-capabilities"
							data-device={id}
							data-generation={cap.generation}
							data-phy={cap.phy}
						>
							<summary
								class="text-muted-foreground hover:text-foreground flex min-h-[var(--touch-target-min)] cursor-pointer list-none items-center gap-1.5 text-xs font-medium select-none"
								data-testid="wifi-capabilities-toggle"
								data-device={id}
							>
								<ChevronRight
									aria-hidden="true"
									class="size-3.5 shrink-0 transition-transform group-open:rotate-90 rtl:rotate-180 rtl:group-open:-rotate-90"
								/>
								{m["network.wifiCapability.disclosure"]()}
							</summary>
							<div class="mt-1.5 space-y-1.5">
							<div class="flex flex-wrap items-center gap-1.5">
								<!-- NEVER inferred: the shipped RTL8852BE prints all-zero EHT
								     structures, so anything but the wire's own verdict would
								     stamp Wi-Fi 7 on a Wi-Fi 6 radio. -->
								<Badge
									class="border-border bg-muted/60 text-foreground border px-1.5 font-semibold"
									data-testid="wifi-generation-badge"
									data-generation={cap.generation}
									variant="neutral"
								>
									{resolveMessageKey(cap.generationLabelKey)}
								</Badge>

								{#each cap.bands as band (band.band)}
									<Badge
										class={cn(
											'border px-1.5',
											band.available
												? 'border-border/70 bg-muted/40 text-muted-foreground'
												: 'border-status-warning/40',
										)}
										data-testid="wifi-band-option"
										data-band={band.band}
										data-available={band.available}
										data-blocked-by={band.blockedBy}
										aria-disabled={band.available ? undefined : 'true'}
										variant={band.available ? 'neutral' : 'warning'}
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
									</Badge>
								{/each}

								{#if wpa3Key}
									<Badge
										class="border-border/70 bg-muted/40 text-muted-foreground border px-1.5"
										data-testid="wifi-wpa3"
										data-state={cap.wpa3Sae}
										variant="neutral"
									>
										{resolveMessageKey(wpa3Key)}
									</Badge>
								{/if}
							</div>

							{#if blocked}
								<!-- The band exists on this radio and is unavailable right now, so
								     it stays on screen with its reason. Hiding it would be
								     indistinguishable from a radio that cannot do 6 GHz at all. -->
								{const actionable = $derived(blockIsOperatorActionable(blocked))}
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
						</details>
					{/if}
					{/snippet}
				</NetworkRow>
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
