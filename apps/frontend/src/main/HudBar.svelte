<script lang="ts">
import { untrack } from 'svelte';
import { LL, locale } from '@ceraui/i18n/svelte';
import { formatBitrate, formatCurrent, formatRelativeTime, formatTemp, formatVoltage } from '@ceraui/i18n/formatters';
import ActivityIcon from '@lucide/svelte/icons/activity';
import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
import CircleHelpIcon from '@lucide/svelte/icons/circle-help';
import CircleXIcon from '@lucide/svelte/icons/circle-x';
import ClockIcon from '@lucide/svelte/icons/clock';
import EthernetPortIcon from '@lucide/svelte/icons/ethernet-port';
import InfoIcon from '@lucide/svelte/icons/info';
import RadioTowerIcon from '@lucide/svelte/icons/radio-tower';
import ThermometerIcon from '@lucide/svelte/icons/thermometer';
import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
import WifiIcon from '@lucide/svelte/icons/wifi';
import ZapIcon from '@lucide/svelte/icons/zap';

import BondConstellation from '$lib/components/custom/BondConstellation.svelte';
import LinkIndicator from '$lib/components/custom/LinkIndicator.svelte';
import Badge from '$lib/components/custom/Badge.svelte';
import * as Sheet from '$lib/components/ui/sheet';
import * as Tooltip from '$lib/components/ui/tooltip';
import { type StalenessState, getStalenessState } from '$lib/helpers/staleness';
import { getDisplayProfile, getDisplayRefreshNonce, prefersEinkTheme } from '$lib/stores/display-profile.svelte';
import { getHudState, getSocTelemetry } from '$lib/stores/hud.svelte';
import { getStreamHealthRollup, getStreamHealthState, type HealthIndicator, type HealthRollup } from '$lib/stores/stream-health.svelte';
import type { LinkSignal } from '$lib/types/hud';
import { cn } from '$lib/utils';

// Rollup state is coded by ICON SHAPE, not color alone — a check, warning
// triangle, cross, and query glyph stay distinguishable on monochrome / e-ink
// panels and to colorblind users. Color is layered on top as a secondary cue.
const HEALTH_ICON: Record<HealthIndicator, typeof CircleCheckIcon> = {
	healthy: CircleCheckIcon,
	degraded: TriangleAlertIcon,
	dead: CircleXIcon,
	unknown: CircleHelpIcon,
};
const HEALTH_ICON_COLOR: Record<HealthIndicator, string> = {
	healthy: 'text-status-success',
	degraded: 'text-status-warning',
	dead: 'text-status-error',
	unknown: 'text-status-neutral',
};

let { class: className }: { class?: string } = $props();

let open = $state(false);

// Full reactive HUD snapshot — re-derives as getters / staleness clock change.
const hud = $derived(getHudState());
const loc = $derived($locale);

// Connection / streaming state machine for the lead badge.
const isOffline = $derived(hud.isFullyStale);
const isLive = $derived(hud.isStreaming && !isOffline);

// Stream-health rollup (Task 13/14): tri-state liveness surfaced as a dot.
const health = $derived(getStreamHealthState());
const HealthIcon = $derived(HEALTH_ICON[health]);
const healthIconColor = $derived(HEALTH_ICON_COLOR[health]);
const healthLabel = $derived(
	health === 'healthy'
		? $LL.hud.healthHealthy()
		: health === 'degraded'
			? $LL.hud.healthDegraded()
			: health === 'dead'
				? $LL.hud.healthDead()
				: $LL.hud.healthUnknown(),
);

// Stream-health rollup DETAIL (Task 15): the per-subsystem breakdown
// (process / frames / SRT / bond) the backend already rolls up, surfaced in the
// expandable HUD sheet. Under the e-ink / mono profile it is FROZEN like the
// kiosk HUD: the live read is untracked so an incoming broadcast can never
// repaint the e-paper, and the only re-sample is a manual display refresh
// (the Task 12 nonce). On lcd it tracks the live broadcast.
const isEink = $derived(prefersEinkTheme(getDisplayProfile()));
let frozenRollup = $state<HealthRollup | null>(getStreamHealthRollup());
$effect(() => {
	void getDisplayRefreshNonce();
	if (isEink) {
		untrack(() => {
			frozenRollup = getStreamHealthRollup();
		});
	}
});
const rollup = $derived(isEink ? frozenRollup : getStreamHealthRollup());
const rollupState = $derived<HealthIndicator>(rollup?.state ?? 'unknown');
const RollupIcon = $derived(HEALTH_ICON[rollupState]);
const rollupIconColor = $derived(HEALTH_ICON_COLOR[rollupState]);
const rollupLabel = $derived(
	rollupState === 'healthy'
		? $LL.hud.healthHealthy()
		: rollupState === 'degraded'
			? $LL.hud.healthDegraded()
			: rollupState === 'dead'
				? $LL.hud.healthDead()
				: $LL.hud.healthUnknown(),
);

// Top reason behind a non-healthy rollup (Task 16): the backend names the
// failing subsystem and a short detail (e.g. "1 of 3 links down"). Surfaced as a
// secondary label so an operator sees WHY at a glance, not just the dot.
const healthReason = $derived(rollup && rollup.state !== 'healthy' ? rollup.reason : undefined);

// SoC telemetry — temp / voltage / current, already parsed by the store
// (parseSensorNumber / parseVolts / parseCurrentAmps). Each value routes
// through getStalenessState so the compact bar degrades honestly: 'stale'
// dims, 'nodata' shows a dash — never a fresh-looking aged value.
const soc = $derived(getSocTelemetry());
const socUpdatedAt = $derived(hud.lastUpdatedAt.sensors);
const tempState = $derived<StalenessState>(getStalenessState(soc.temp, socUpdatedAt, soc.isStale));
const voltageState = $derived<StalenessState>(getStalenessState(soc.voltage, socUpdatedAt, soc.isStale));
const currentState = $derived<StalenessState>(getStalenessState(soc.current, socUpdatedAt, soc.isStale));
const tempText = $derived(soc.temp != null ? formatTemp(loc)(soc.temp) : '—');
const voltageText = $derived(soc.voltage != null ? formatVoltage(loc)(soc.voltage) : '—');
const currentText = $derived(soc.current != null ? formatCurrent(loc)(soc.current) : '—');

const linkColor = (link: LinkSignal) => `var(--link-${link.linkIndex + 1})`;

function lastSeen(ts: number | null): string | null {
	if (ts == null) return null;
	return formatRelativeTime(loc)(new Date(ts));
}

// Polite live-region announcement of the HUD telemetry. The raw values change
// every tick; announcing each one would flood a screen reader, so a single
// concise summary (state · bitrate · link count) is DEBOUNCED — only the value
// that survives a quiet window is announced. Detail stays in the expandable
// sheet; this is the at-a-glance read for assistive tech.
const TELEMETRY_ANNOUNCE_DEBOUNCE_MS = 1500;
const telemetrySummary = $derived(
	[
		isOffline ? $LL.hud.offline() : isLive ? $LL.hud.live() : $LL.hud.idle(),
		`${$LL.hud.bitrate()}: ${hud.bitrateKbps != null ? formatBitrate(loc)(hud.bitrateKbps) : '—'}`,
		`${$LL.hud.network()}: ${hud.links.length}`,
	].join(' · '),
);
let announcedTelemetry = $state('');
$effect(() => {
	const next = telemetrySummary;
	const id = setTimeout(() => {
		announcedTelemetry = next;
	}, TELEMETRY_ANNOUNCE_DEBOUNCE_MS);
	return () => clearTimeout(id);
});

// Accessible names for the compact badges. Each carries its current value AND its
// staleness ("Stale") so assistive tech reads the same degradation the sighted
// dimming conveys — never a fresh-sounding value for an aged reading.
const staleSuffix = (isStale: boolean) => (isStale ? `, ${$LL.hud.stale()}` : '');
const bitrateLabel = $derived(
	`${$LL.hud.bitrate()}: ${hud.bitrateKbps != null ? formatBitrate(loc)(hud.bitrateKbps) : $LL.hud.noData()}${staleSuffix(hud.isBitrateStale)}`,
);
const socLabel = $derived(
	`${$LL.hud.sensors()}: ${$LL.hud.temperature()} ${tempState === 'nodata' ? '—' : tempText}, ${$LL.hud.voltage()} ${voltageState === 'nodata' ? '—' : voltageText}, ${$LL.hud.current()} ${currentState === 'nodata' ? '—' : currentText}${staleSuffix(soc.isStale)}`,
);
function linkLabel(link: LinkSignal): string {
	const sig = link.signal != null ? `${Math.round(link.signal)}%` : $LL.hud.noData();
	return `${$LL.hud.network()} L${link.linkIndex + 1}: ${sig}${staleSuffix(link.isStale)}`;
}

// Critical-transition announcer (separate from the continuous summary above): a
// SECOND polite region that speaks only the rare, important edges — stream
// started/stopped, a bonded link dropping — so a screen-reader user hears the
// events that matter without the per-tick value noise. Edge-detected against the
// prior render's state (plain locals, not runes, so the compare never re-triggers
// the effect) and debounced so a burst coalesces to its final message.
const activeLinkCount = $derived(hud.links.filter((link) => link.isConnected).length);
let announcedTransition = $state('');
let prevLive = false;
let prevActiveLinks = 0;
let primed = false;
$effect(() => {
	const live = isLive;
	const links = activeLinkCount;
	let message: string | undefined;
	if (!primed) {
		primed = true;
	} else if (live && !prevLive) {
		message = $LL.hud.announceStreamStarted();
	} else if (!live && prevLive) {
		message = $LL.hud.announceStreamStopped();
	} else if (links < prevActiveLinks) {
		message = $LL.hud.announceLinkDropped();
	}
	prevLive = live;
	prevActiveLinks = links;
	if (message === undefined) return;
	const next = message;
	const id = setTimeout(() => {
		announcedTransition = next;
	}, TELEMETRY_ANNOUNCE_DEBOUNCE_MS);
	return () => clearTimeout(id);
});
</script>

{#snippet miniBars(link: LinkSignal)}
	<LinkIndicator
		shape="bars"
		size="sm"
		type={link.type}
		signal={link.signal}
		connectionState={link.connectionState}
		linkIndex={link.linkIndex}
	/>
{/snippet}

{#snippet socValue(state: StalenessState, text: string, label: string)}
	<span class={cn('shrink-0', state === 'stale' && 'opacity-50')} title={label}>
		{state === 'nodata' ? '—' : text}
	</span>
{/snippet}

{#snippet rollupRow(testid: string, label: string, ok: boolean, okText: string, badText: string, okIcon: typeof CircleCheckIcon | null, badIcon: typeof CircleCheckIcon)}
	<div class="flex items-center justify-between gap-2" data-testid={testid}>
		<dt class="text-muted-foreground">{label}</dt>
		<dd class={cn('inline-flex items-center gap-1 font-medium', ok ? 'text-status-success' : 'text-status-warning')}>
			{#if ok}
				{#if okIcon}{@const OkIcon = okIcon}<OkIcon class="size-3.5 shrink-0" aria-hidden="true" />{/if}
				{okText}
			{:else}
				{@const BadIcon = badIcon}
				<BadIcon class="size-3.5 shrink-0" aria-hidden="true" />
				{badText}
			{/if}
		</dd>
	</div>
{/snippet}

<span role="status" aria-live="polite" class="sr-only" data-testid="hud-telemetry-status">{announcedTelemetry}</span>
<span role="status" aria-live="polite" class="sr-only" data-testid="hud-transition-status">{announcedTransition}</span>

<Sheet.Root bind:open>
	<Sheet.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				data-hud-region
				aria-label={$LL.hud.expandDetails()}
				class={cn(
					'bg-sidebar text-foreground hover:bg-accent/50 focus-visible:ring-ring/50 flex h-12 w-full items-center gap-3 border-t px-4 text-start text-xs font-medium tracking-wide transition-colors focus-visible:ring-2 focus-visible:outline-none',
					className,
				)}
			>
				<!-- Lead status badge -->
				{#if isOffline}
					<span
						class="bg-muted text-muted-foreground inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-wider"
					>
						<ClockIcon class="size-3" aria-hidden="true" />
						{$LL.hud.offline()}
					</span>
				{:else if isLive}
					<span
						class="bg-status-live text-primary-foreground inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-wider"
					>
						<span class="size-2 rounded-full bg-current motion-safe:animate-pulse"></span>
						{$LL.hud.live()}
					</span>
				{:else}
					<span
						class="text-muted-foreground inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-wider"
					>
						<span class="bg-status-idle size-2 rounded-full"></span>
						{$LL.hud.idle()}
					</span>
				{/if}

				<!-- Stream-health indicator: icon SHAPE + visible label (never color alone) -->
				<span
					data-testid="stream-health"
					data-state={health}
					class="inline-flex shrink-0 items-center gap-1"
					title="{$LL.hud.streamHealth()}: {healthLabel}"
				>
					<HealthIcon class={cn('size-3.5 shrink-0', healthIconColor)} aria-hidden="true" />
					<span class="text-[0.7rem] font-semibold">{healthLabel}</span>
					<span class="sr-only">{$LL.hud.streamHealth()}</span>
				</span>

				{#if healthReason}
					<span
						data-testid="stream-health-reason"
						class="text-muted-foreground hidden min-w-0 truncate text-[0.7rem] font-medium sm:inline"
						title={healthReason.detail}
					>
						{healthReason.detail}
					</span>
				{/if}

				<span class="bg-border h-5 w-px shrink-0" aria-hidden="true"></span>

				<!-- Bitrate -->
				<span
					class={cn('inline-flex shrink-0 items-center gap-1 font-mono tabular-nums', hud.isBitrateStale && 'opacity-50')}
					role="img"
					aria-label={bitrateLabel}
					title={$LL.hud.bitrate()}
				>
					{#if hud.isBitrateStale}
						<ClockIcon class="size-3 shrink-0" aria-hidden="true" />
					{/if}
					{hud.bitrateKbps != null ? formatBitrate(loc)(hud.bitrateKbps) : '—'}
				</span>

				<span class="bg-border h-5 w-px shrink-0" aria-hidden="true"></span>

				<!-- Bonded link signals -->
				<span class="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
					{#if hud.links.length === 0}
						<span class="text-muted-foreground/60 truncate">{$LL.hud.noData()}</span>
					{:else}
						{#each hud.links as link (link.linkIndex)}
							<span
								class={cn('inline-flex shrink-0 items-end gap-1.5', link.isStale && 'opacity-50')}
								role="img"
								aria-label={linkLabel(link)}
							>
								<span class="font-mono text-[0.7rem] leading-none" style:color={linkColor(link)}>
									L{link.linkIndex + 1}
								</span>
								{@render miniBars(link)}
							</span>
						{/each}
					{/if}
				</span>

				<span class="bg-border h-5 w-px shrink-0" aria-hidden="true"></span>

				<!-- SoC telemetry: temperature · voltage · current (compact mono cluster) -->
				<span
					class="inline-flex shrink-0 items-center gap-2 font-mono tabular-nums"
					role="img"
					aria-label={socLabel}
					title={$LL.hud.sensors()}
				>
					{#if soc.isStale}
						<ClockIcon class="size-3 shrink-0 opacity-50" aria-hidden="true" />
					{:else}
						<ThermometerIcon class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
					{/if}
					{@render socValue(tempState, tempText, $LL.hud.temperature())}
					{@render socValue(voltageState, voltageText, $LL.hud.voltage())}
					{@render socValue(currentState, currentText, $LL.hud.current())}
				</span>
			</button>
		{/snippet}
	</Sheet.Trigger>

	<Sheet.Content side="bottom" class="max-h-[85dvh] gap-0 overflow-y-auto">
		<Sheet.Header class="gap-1">
			<Sheet.Title>{$LL.hud.status()}</Sheet.Title>
			<Sheet.Description>
				{#if isOffline}
					{$LL.hud.offline()}
				{:else if isLive}
					{$LL.hud.live()}
				{:else}
					{$LL.hud.idle()}
				{/if}
				{#if lastSeen(hud.lastUpdatedAt.streaming)}
					· {$LL.hud.lastUpdated()} {lastSeen(hud.lastUpdatedAt.streaming)}
				{/if}
			</Sheet.Description>
		</Sheet.Header>

		<div class="flex flex-col gap-6 px-4 pb-6">
			<!-- Streaming -->
			<section class="flex flex-col gap-1">
				<h3 class="text-muted-foreground mb-1 text-xs font-medium">{$LL.hud.streaming()}</h3>

				<!-- Bond constellation: visualizes the bond the rollup below states numerically -->
				<div class="mx-auto mb-2 w-full max-w-[22rem]">
					<BondConstellation links={hud.links} live={isLive} frozen={isEink} />
				</div>

				<div class="flex items-center justify-between gap-3 border-b py-2">
					<span class="text-muted-foreground flex items-center gap-2">
						<span
							class={cn(
								'size-2 rounded-full',
								isOffline ? 'bg-muted-foreground' : isLive ? 'bg-status-live' : 'bg-status-idle',
							)}
						></span>
						{$LL.hud.status()}
					</span>
					<span class="font-medium">
						{isOffline ? $LL.hud.offline() : isLive ? $LL.hud.live() : $LL.hud.idle()}
					</span>
				</div>

				<!-- Stream-health rollup: state + process/frames/SRT/bond breakdown (Task 15) -->
				<div class="flex flex-col gap-2 border-b py-2" data-testid="stream-health-detail" data-state={rollupState}>
					<div class="flex items-center justify-between gap-3">
						<span class="text-muted-foreground flex items-center gap-1.5">
							{$LL.hud.streamHealth()}
							<Tooltip.Provider>
								<Tooltip.Root>
									<Tooltip.Trigger>
										{#snippet child({ props })}
											<button
												{...props}
												type="button"
												data-testid="stream-health-info"
												aria-label={$LL.hud.streamHealth()}
												class="text-muted-foreground/70 hover:text-foreground focus-visible:ring-ring/50 inline-flex rounded-full transition-colors focus-visible:ring-2 focus-visible:outline-none"
											>
												<InfoIcon class="size-3.5" aria-hidden="true" />
											</button>
										{/snippet}
									</Tooltip.Trigger>
									<Tooltip.Content class="max-w-72">
										<ul class="flex flex-col gap-1.5 text-xs">
											<li class="flex items-start gap-1.5">
												<CircleCheckIcon class="text-status-success mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
												<span><span class="font-semibold">{$LL.hud.healthHealthy()}:</span> {$LL.hud.healthExplainHealthy()}</span>
											</li>
											<li class="flex items-start gap-1.5">
												<TriangleAlertIcon class="text-status-warning mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
												<span><span class="font-semibold">{$LL.hud.healthDegraded()}:</span> {$LL.hud.healthExplainDegraded()}</span>
											</li>
											<li class="flex items-start gap-1.5">
												<CircleXIcon class="text-status-error mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
												<span><span class="font-semibold">{$LL.hud.healthDead()}:</span> {$LL.hud.healthExplainDead()}</span>
											</li>
										</ul>
									</Tooltip.Content>
								</Tooltip.Root>
							</Tooltip.Provider>
						</span>
						<span class="inline-flex items-center gap-1.5 font-medium" data-testid="stream-health-state">
							<RollupIcon class={cn('size-4 shrink-0', rollupIconColor)} aria-hidden="true" />
							{rollupLabel}
						</span>
					</div>

					{#if healthReason}
						<p class="text-status-warning text-xs" data-testid="stream-health-reason-detail">{healthReason.detail}</p>
					{/if}

					{#if rollup}
						<dl class="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs" data-testid="stream-health-rollup">
							{@render rollupRow(
								'health-process',
								$LL.hud.healthProcess(),
								rollup.process.alive,
								$LL.hud.healthRunning(),
								$LL.hud.healthNotRunning(),
								CircleCheckIcon,
								CircleXIcon,
							)}
							{@render rollupRow(
								'health-frames',
								$LL.hud.healthFrames(),
								rollup.frames.advancing,
								$LL.hud.healthAdvancing(),
								$LL.hud.healthStalled(),
								null,
								TriangleAlertIcon,
							)}
							{@render rollupRow(
								'health-srt',
								$LL.hud.healthSrt(),
								!rollup.srt.reconnecting,
								$LL.hud.healthStable(),
								$LL.hud.healthReconnecting(),
								null,
								TriangleAlertIcon,
							)}
							<div class="flex items-center justify-between gap-2" data-testid="health-bond">
								<dt class="text-muted-foreground">{$LL.hud.healthBond()}</dt>
								<dd
									class={cn(
										'font-mono font-medium tabular-nums',
										rollup.bond.activeLinks < rollup.bond.linkCount && 'text-status-warning',
									)}
								>
									{rollup.bond.activeLinks}/{rollup.bond.linkCount}
								</dd>
							</div>
						</dl>
					{:else}
						<p class="text-muted-foreground/70 text-xs" data-testid="stream-health-rollup-empty">{$LL.hud.noData()}</p>
					{/if}
				</div>

				<div class={cn('flex items-center justify-between gap-3 border-b py-2', hud.isBitrateStale && 'opacity-50')}>
					<span class="text-muted-foreground flex items-center gap-2">
						{#if hud.isBitrateStale}<ClockIcon class="size-3.5" aria-hidden="true" />{/if}
						{$LL.hud.bitrate()}
					</span>
					<span class="font-mono tabular-nums">
						{hud.bitrateKbps != null ? formatBitrate(loc)(hud.bitrateKbps) : '—'}
					</span>
				</div>
			</section>

			<!-- Network links -->
			<section class="flex flex-col gap-1">
				<h3 class="text-muted-foreground mb-1 text-xs font-medium">{$LL.hud.network()}</h3>
				{#if hud.links.length === 0}
					<p class="text-muted-foreground/70 py-2 text-sm">{$LL.hud.noData()}</p>
				{:else}
					{#each hud.links as link (link.linkIndex)}
						<div class={cn('flex items-center justify-between gap-3 border-b py-2.5', link.isStale && 'opacity-50')}>
							<span class="flex min-w-0 items-center gap-2.5">
								<span class="size-2.5 shrink-0 rounded-full" style:background-color={linkColor(link)} style:opacity={link.isConnected ? '1' : '0.4'}></span>
								{#if link.type === 'wifi'}
									<WifiIcon class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
								{:else if link.type === 'ethernet'}
									<EthernetPortIcon class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
								{:else}
									<RadioTowerIcon class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
								{/if}
								<span class="truncate font-medium">{link.label}</span>
							</span>
							<span class="flex shrink-0 items-center gap-3">
								<Badge variant="speed" kbps={link.throughputKbps} stale={link.isStale} />
								{#if link.type !== 'ethernet'}
									{#if link.signal != null}
										<span class="font-mono text-xs tabular-nums" style:color={linkColor(link)}>
											{Math.round(link.signal)}%
										</span>
									{/if}
									{@render miniBars(link)}
								{/if}
							</span>
						</div>
					{/each}
				{/if}
			</section>

			<!-- Sensors -->
			<section class={cn('flex flex-col gap-1', hud.isSensorsStale && 'opacity-50')}>
				<h3 class="text-muted-foreground mb-1 flex items-center gap-2 text-xs font-medium">
					{$LL.hud.sensors()}
					{#if hud.isSensorsStale}<ClockIcon class="size-3.5" aria-hidden="true" />{/if}
				</h3>
				<div class="flex items-center justify-between gap-3 border-b py-2">
					<span class="text-muted-foreground flex items-center gap-2">
						<ThermometerIcon class="size-4" aria-hidden="true" />{$LL.hud.temperature()}
					</span>
					<span class="font-mono tabular-nums">{hud.temperature != null ? formatTemp(loc)(hud.temperature) : '—'}</span>
				</div>
				<div class="flex items-center justify-between gap-3 border-b py-2">
					<span class="text-muted-foreground flex items-center gap-2">
						<ZapIcon class="size-4" aria-hidden="true" />{$LL.hud.voltage()}
					</span>
					<span class="font-mono tabular-nums">{hud.voltage != null ? formatVoltage(loc)(hud.voltage) : '—'}</span>
				</div>
				<div class="flex items-center justify-between gap-3 border-b py-2">
					<span class="text-muted-foreground flex items-center gap-2">
						<ActivityIcon class="size-4" aria-hidden="true" />{$LL.hud.current()}
					</span>
					<span class="font-mono tabular-nums">{hud.current != null ? formatCurrent(loc)(hud.current) : '—'}</span>
				</div>
				{#if lastSeen(hud.lastUpdatedAt.sensors)}
					<p class="text-muted-foreground/70 mt-1 text-xs">{$LL.hud.lastUpdated()} {lastSeen(hud.lastUpdatedAt.sensors)}</p>
				{/if}
			</section>
		</div>
	</Sheet.Content>
</Sheet.Root>
