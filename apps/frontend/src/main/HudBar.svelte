<script lang="ts">
import { untrack } from 'svelte';
import { LL, locale } from '@ceraui/i18n/svelte';
import { formatBitrate, formatCurrent, formatRelativeTime, formatTemp, formatVoltage } from '@ceraui/i18n/formatters';
import ActivityIcon from '@lucide/svelte/icons/activity';
import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
import CircleDotIcon from '@lucide/svelte/icons/circle-dot';
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
import BufferingIndicator from '$lib/components/custom/BufferingIndicator.svelte';
import LinkIndicator from '$lib/components/custom/LinkIndicator.svelte';
import Badge from '$lib/components/custom/Badge.svelte';
import * as Sheet from '$lib/components/ui/sheet';
import * as Tooltip from '$lib/components/ui/tooltip';
import { type StalenessState, getStalenessState } from '$lib/helpers/staleness';
import { getBufferingState } from '$lib/stores/buffering.svelte';
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

// The three explicit HUD lifecycle states (Task 8, Live-Data Discipline). The
// sheet renders exactly ONE status-wording node keyed off this, and every
// live-only metric renders as absence ("—") outside `live` — never a dimmed
// stale number.
type HudLifecycle = 'live' | 'idle' | 'offline';
const lifecycle = $derived<HudLifecycle>(isOffline ? 'offline' : isLive ? 'live' : 'idle');

// Bitrate honesty: it is a LIVE streaming value, so it is shown ONLY while
// genuinely live. Idle/offline render "—" (absence rendered as absence).
// Dimming is reserved for aging-while-streaming (live + stale) and NEVER
// applies to an idle/offline absence.
const bitrateDimmed = $derived(isLive && hud.isBitrateStale);
const bitrateText = $derived(isLive && hud.bitrateKbps != null ? formatBitrate(loc)(hud.bitrateKbps) : '—');

// Store-and-forward buffering (Task 34): null until the engine advertises it.
const buffering = $derived(getBufferingState());

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
// SoC telemetry — the COMPACT strip surfaces temperature ONLY (one chip);
// voltage / current live in the expandable sheet's sensors line. The temp value
// routes through getStalenessState so the strip chip degrades honestly: 'stale'
// dims, 'nodata' shows a dash — never a fresh-looking aged value.
const soc = $derived(getSocTelemetry());
const socUpdatedAt = $derived(hud.lastUpdatedAt.sensors);
const tempState = $derived<StalenessState>(getStalenessState(soc.temp, socUpdatedAt, soc.isStale));
const tempText = $derived(soc.temp != null ? formatTemp(loc)(soc.temp) : '—');

const linkColor = (link: LinkSignal) => `var(--link-${link.linkIndex + 1})`;

function lastSeen(ts: number | null): string | null {
	if (ts == null) return null;
	return formatRelativeTime(loc)(new Date(ts));
}

// Relative "last seen" for the streaming signal — reused by the offline verdict
// ("No signal · last seen …") and the live/idle subtitle ("Last updated …").
const streamingLastSeen = $derived(lastSeen(hud.lastUpdatedAt.streaming));

// Polite live-region announcement of the HUD telemetry. The raw values change
// every tick; announcing each one would flood a screen reader, so a single
// concise summary (state · bitrate · link count) is DEBOUNCED — only the value
// that survives a quiet window is announced. Detail stays in the expandable
// sheet; this is the at-a-glance read for assistive tech.
const TELEMETRY_ANNOUNCE_DEBOUNCE_MS = 1500;
const telemetrySummary = $derived(
	[
		isOffline ? $LL.hud.offline() : isLive ? $LL.hud.live() : $LL.hud.idle(),
		`${$LL.hud.bitrate()}: ${bitrateText}`,
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
	`${$LL.hud.bitrate()}: ${isLive && hud.bitrateKbps != null ? formatBitrate(loc)(hud.bitrateKbps) : $LL.hud.noData()}${staleSuffix(bitrateDimmed)}`,
);
// The compact strip now shows a single temperature chip; the aria name carries
// just that value + its staleness (voltage / current moved to the sheet).
const socTempLabel = $derived(
	`${$LL.hud.sensors()}: ${$LL.hud.temperature()} ${tempState === 'nodata' ? '—' : tempText}${staleSuffix(soc.isStale)}`,
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

{#snippet rollupTile(testid: string, label: string, ok: boolean, okText: string, badText: string, okIcon: typeof CircleCheckIcon | null, badIcon: typeof CircleCheckIcon)}
	<div class="bg-secondary/40 flex flex-col gap-1 rounded-lg p-2.5" data-testid={testid}>
		<dt class="text-muted-foreground text-[0.7rem] font-medium">{label}</dt>
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

				<!-- Store-and-forward buffering indicator (capability-gated, calm) -->
				<BufferingIndicator state={buffering} />

				<span class="bg-border h-5 w-px shrink-0" aria-hidden="true"></span>

				<!-- Bitrate — live-only; renders "—" when idle/offline (never a dimmed stale number) -->
				<span
					class={cn('inline-flex shrink-0 items-center gap-1 font-mono tabular-nums', bitrateDimmed && 'opacity-50')}
					role="img"
					aria-label={bitrateLabel}
					title={$LL.hud.bitrate()}
				>
					{#if bitrateDimmed}
						<ClockIcon class="size-3 shrink-0" aria-hidden="true" />
					{/if}
					{bitrateText}
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

				<!-- SoC telemetry: single temperature chip (voltage/current live in the sheet) -->
				<span
					class="inline-flex shrink-0 items-center gap-1.5 font-mono tabular-nums"
					role="img"
					aria-label={socTempLabel}
					title={$LL.hud.temperature()}
				>
					{#if soc.isStale}
						<ClockIcon class="size-3 shrink-0 opacity-50" aria-hidden="true" />
					{:else}
						<ThermometerIcon class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
					{/if}
					{@render socValue(tempState, tempText, $LL.hud.temperature())}
				</span>
			</button>
		{/snippet}
	</Sheet.Trigger>

	<Sheet.Content side="bottom" class="max-h-[85dvh] gap-0 overflow-y-auto">
		<Sheet.Header class="gap-1">
			<Sheet.Title>{$LL.hud.status()}</Sheet.Title>
			<Sheet.Description>
				<span data-testid="hud-sheet-subtitle" data-state={lifecycle}>
					{#if lifecycle !== 'offline' && streamingLastSeen}
						{$LL.hud.lastUpdated()} {streamingLastSeen}
					{/if}
				</span>
			</Sheet.Description>
		</Sheet.Header>

		<div class="flex flex-col gap-4 px-4 pb-6">
			<!-- Streaming -->
			<section class="flex flex-col gap-2">
				<h3 class="text-muted-foreground mb-1 text-xs font-medium">{$LL.hud.streaming()}</h3>

				<!-- 1. ONE verdict line: lifecycle status + health rollup verdict (Task 8/15) -->
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
							{#if lifecycle === 'offline'}
								<ClockIcon class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
								{$LL.hud.noSignal()}
							{:else if rollup}
								<RollupIcon class={cn('size-4 shrink-0', rollupIconColor)} aria-hidden="true" />
								{rollupLabel}
							{:else}
								<CircleDotIcon class="text-status-neutral size-4 shrink-0" aria-hidden="true" />
								{$LL.hud.idle()}
							{/if}
						</span>
					</div>

					{#if lifecycle === 'offline'}
						{#if streamingLastSeen}
							<p class="text-muted-foreground text-xs" data-testid="hud-last-seen">{$LL.hud.lastSeen()} {streamingLastSeen}</p>
						{/if}
					{:else if rollup && healthReason}
						<p class="text-status-warning text-xs" data-testid="stream-health-reason-detail">{healthReason.detail}</p>
					{/if}
				</div>

				<!-- 2. Bond constellation: mounted ONLY while live (never implies an idle bond) -->
				{#if isLive}
					<div class="mx-auto w-full max-w-[16rem]" data-testid="hud-constellation">
						<BondConstellation links={hud.links} live={isLive} frozen={isEink} />
					</div>
				{/if}

				<!-- 3. Subsystem 2×2 tile grid: process / SRT / frames / bond (dl semantics kept) -->
				{#if lifecycle !== 'offline' && rollup}
					<dl class="grid grid-cols-2 gap-2 text-xs" data-testid="stream-health-rollup">
						{@render rollupTile(
							'health-process',
							$LL.hud.healthProcess(),
							rollup.process.alive,
							$LL.hud.healthRunning(),
							$LL.hud.healthNotRunning(),
							CircleCheckIcon,
							CircleXIcon,
						)}
						{@render rollupTile(
							'health-srt',
							$LL.hud.healthSrt(),
							!rollup.srt.reconnecting,
							$LL.hud.healthStable(),
							$LL.hud.healthReconnecting(),
							null,
							TriangleAlertIcon,
						)}
						{@render rollupTile(
							'health-frames',
							$LL.hud.healthFrames(),
							rollup.frames.advancing,
							$LL.hud.healthAdvancing(),
							$LL.hud.healthStalled(),
							null,
							TriangleAlertIcon,
						)}
						<div class="bg-secondary/40 flex flex-col gap-1 rounded-lg p-2.5" data-testid="health-bond">
							<dt class="text-muted-foreground text-[0.7rem] font-medium">{$LL.hud.healthBond()}</dt>
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
				{:else if lifecycle !== 'offline'}
					<p class="text-muted-foreground/70 text-xs" data-testid="stream-health-rollup-empty">{$LL.hud.noData()}</p>
				{/if}

				<!-- 4. Single bitrate row (Task 8 behavior) -->
				<div class={cn('flex items-center justify-between gap-3 border-b py-2', bitrateDimmed && 'opacity-50')}>
					<span class="text-muted-foreground flex items-center gap-2">
						{#if bitrateDimmed}<ClockIcon class="size-3.5" aria-hidden="true" />{/if}
						{$LL.hud.bitrate()}
					</span>
					<span class="font-mono tabular-nums">
						{bitrateText}
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
						<div class={cn('flex items-center justify-between gap-3 border-b py-2', link.isStale && 'opacity-50')}>
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

			<!-- Sensors: collapsed to ONE inline mono line (temp · voltage · current) -->
			<section class={cn('flex flex-col gap-1', hud.isSensorsStale && 'opacity-50')}>
				<h3 class="text-muted-foreground mb-1 flex items-center gap-2 text-xs font-medium">
					{$LL.hud.sensors()}
					{#if hud.isSensorsStale}<ClockIcon class="size-3.5" aria-hidden="true" />{/if}
				</h3>
				<div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 font-mono text-sm tabular-nums" data-testid="hud-sensors-line">
					<span class="inline-flex items-center gap-1.5" title={$LL.hud.temperature()}>
						<ThermometerIcon class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
						{hud.temperature != null ? formatTemp(loc)(hud.temperature) : '—'}
					</span>
					<span class="text-muted-foreground/40" aria-hidden="true">·</span>
					<span class="inline-flex items-center gap-1.5" title={$LL.hud.voltage()}>
						<ZapIcon class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
						{hud.voltage != null ? formatVoltage(loc)(hud.voltage) : '—'}
					</span>
					<span class="text-muted-foreground/40" aria-hidden="true">·</span>
					<span class="inline-flex items-center gap-1.5" title={$LL.hud.current()}>
						<ActivityIcon class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
						{hud.current != null ? formatCurrent(loc)(hud.current) : '—'}
					</span>
				</div>
				{#if lastSeen(hud.lastUpdatedAt.sensors)}
					<p class="text-muted-foreground/70 mt-1 text-xs">{$LL.hud.lastUpdated()} {lastSeen(hud.lastUpdatedAt.sensors)}</p>
				{/if}
			</section>
		</div>
	</Sheet.Content>
</Sheet.Root>
