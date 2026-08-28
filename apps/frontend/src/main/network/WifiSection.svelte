<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import type { NetifMessage, WifiInterface } from '@ceraui/rpc/schemas';
import {
	Ban,
	ChevronRight,
	Globe,
	Settings2,
	SlidersHorizontal,
	TriangleAlert,
	Wifi,
} from '@lucide/svelte';

import BondToggle from '$lib/components/custom/BondToggle.svelte';
import Badge from '$lib/components/custom/Badge.svelte';
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

import WifiModeBadge from './WifiModeBadge.svelte';
import WifiModeErrorBand from './WifiModeErrorBand.svelte';
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
				<!-- Single-line row: identity (dot · name · status) left; bond + actions right.
				     The handle exists because the action group below wraps too, so a probe
				     climbing to the nearest `.flex-wrap` would stop there, not here. -->
				<div
					class="flex flex-wrap items-center gap-3 px-4 py-2.5"
					data-testid="wifi-row"
					data-device={id}
				>
					<span
						class={cn(
							'size-2 shrink-0 rounded-full',
							isHotspot ? 'bg-status-info' : connected ? 'bg-primary' : 'bg-muted-foreground/40',
						)}
						aria-hidden="true"
					></span>
					<!-- IDENTITY, THEN ONE STATUS LINE. The mode is a property of the
					     RADIO, so the badge belongs beside the radio's name — and putting it
					     there is what lets the mode fact render exactly ONCE per row: the
					     three-rung selector that used to restate it below now lives behind
					     the "Mode" affordance in the action cluster. Everything under the
					     name is then a single sentence about what the radio is doing. -->
					<div class="min-w-0 flex-1">
						<div class="flex min-w-0 items-center gap-1.5">
							<p class="truncate text-sm font-medium">
								{#if isHotspot}
									{iface.hotspot?.name || iface.ifname}
								{:else}
									{iface.ifname}
								{/if}
							</p>
							<WifiModeBadge device={id} mode={modeView.displayMode} />
						</div>
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
					</div>
					<!-- The controls travel as ONE wrapping group, and the group SHRINKS.
					     A hybrid radio carries four of them — bond, Connect, Setup, Mode —
					     which measure 373px inside a 278px row at 375px, so `shrink-0`
					     could only push Mode 39px past the viewport edge. Wrapping keeps
					     every control at full width and full tap target; `justify-end`
					     keeps the wrapped line on the row's trailing edge, and the group
					     wraps whole so no control strands away from its siblings. Same
					     shape as BondedLinksSection's trailing instrument group. -->
					<div class="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
						{#if showStale}
							<Badge variant="stale" data-stale-interface={iface.ifname} />
						{/if}
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
							<Popover.Content align="end" class="w-80" data-testid="wifi-mode-popover-{id}">
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
					</div>

				<!-- ONE SECONDARY REGION, not four stacked siblings.
				     The mode control, the lock reason, the negotiated link and the radio's
				     capability strip each used to be a `basis-full ps-5` sibling of the
				     identity line, so the parent's `gap-3` spaced them exactly as far apart
				     as it spaced them from the row header — four registers reading as four
				     unrelated facts. Grouped under one container with a tighter
				     `space-y-1.5`, proximity does the work: one gap separates the row's
				     header from its detail, and the detail reads as a block.

				     It is UNCONDITIONAL, and that is load-bearing. `wifi-link-telemetry`
				     and `wifi-capabilities` are both absent on an older backend, and both
				     are pinned by byte-identity locks that delete the node and compare the
				     section against a legacy render. A wrapper that existed only when one
				     of them did would survive that deletion as an empty div and break both
				     locks. Every row renders this container, so both locks still hold now
				     that the mode selector has moved into the header's popover. -->
					<div class="basis-full space-y-1.5 ps-5">
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

					<!-- WHAT IT NEGOTIATED, BESIDE WHAT IT CAN DO. This line reports the
					     CONNECTION and the strip below reports the RADIO, so the two
					     legitimately differ — a Wi-Fi 7 adapter on an 802.11ac access point
					     really is running VHT — and that difference is the reading. It used
					     to be the identity column's third line, two blocks away from the
					     ceiling it should be read against. -->
					{#if !isHotspot && link}
						<p
							class={cn(
								'text-muted-foreground truncate text-xs transition-opacity',
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
							class="group"
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
						</details>
					{/if}
					</div>
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
