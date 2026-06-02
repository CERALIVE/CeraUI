<script lang="ts">
import { LL, locale } from '@ceraui/i18n/svelte';
import { formatBitrate, formatCurrent, formatRelativeTime, formatTemp, formatVoltage } from '@ceraui/i18n/formatters';
import ActivityIcon from '@lucide/svelte/icons/activity';
import ClockIcon from '@lucide/svelte/icons/clock';
import EthernetPortIcon from '@lucide/svelte/icons/ethernet-port';
import RadioTowerIcon from '@lucide/svelte/icons/radio-tower';
import SignalZeroIcon from '@lucide/svelte/icons/signal-zero';
import ThermometerIcon from '@lucide/svelte/icons/thermometer';
import WifiIcon from '@lucide/svelte/icons/wifi';
import ZapIcon from '@lucide/svelte/icons/zap';

import SpeedBadge from '$lib/components/custom/SpeedBadge.svelte';
import * as Sheet from '$lib/components/ui/sheet';
import { getHudState } from '$lib/stores/hud.svelte';
import type { LinkSignal } from '$lib/types/hud';
import { cn } from '$lib/utils';

let { class: className }: { class?: string } = $props();

let open = $state(false);

// Full reactive HUD snapshot — re-derives as getters / staleness clock change.
const hud = $derived(getHudState());
const loc = $derived($locale);

// Connection / streaming state machine for the lead badge.
const isOffline = $derived(hud.isFullyStale);
const isLive = $derived(hud.isStreaming && !isOffline);

const linkColor = (link: LinkSignal) => `var(--link-${link.linkIndex + 1})`;

/** 0–3 filled mini-bars from a signal percentage. */
function filledBars(signal: number | null): number {
	if (signal == null) return 0;
	if (signal >= 66) return 3;
	if (signal >= 33) return 2;
	if (signal > 0) return 1;
	return 0;
}

function lastSeen(ts: number | null): string | null {
	if (ts == null) return null;
	return formatRelativeTime(loc)(new Date(ts));
}
</script>

{#snippet miniBars(link: LinkSignal)}
	{#if link.signal === null}
		<SignalZeroIcon class="size-3.5 text-muted-foreground/70" aria-hidden="true" />
	{:else}
		{@const filled = filledBars(link.signal)}
		<span class="flex items-end gap-px" aria-hidden="true">
			{#each [0, 1, 2] as i (i)}
				<span
					class="w-1 rounded-[1px]"
					style:height={`${6 + i * 3}px`}
					style:background-color={i < filled ? linkColor(link) : 'var(--border)'}
					style:opacity={i < filled ? '1' : '0.5'}
				></span>
			{/each}
		</span>
	{/if}
{/snippet}

<Sheet.Root bind:open>
	<Sheet.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				data-hud-region
				aria-label={$LL.hud.expandDetails()}
				class={cn(
					'bg-sidebar text-foreground hover:bg-accent/50 focus-visible:ring-ring/50 flex h-12 w-full items-center gap-3 border-t px-4 text-left text-xs font-medium tracking-wide transition-colors focus-visible:ring-2 focus-visible:outline-none',
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

				<span class="bg-border h-5 w-px shrink-0" aria-hidden="true"></span>

				<!-- Bitrate -->
				<span
					class={cn('inline-flex shrink-0 items-center gap-1 font-mono tabular-nums', hud.isBitrateStale && 'opacity-50')}
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
							<span class={cn('inline-flex shrink-0 items-center gap-1', link.isStale && 'opacity-50')}>
								<span class="font-mono text-[0.7rem]" style:color={linkColor(link)}>
									L{link.linkIndex + 1}
								</span>
								{@render miniBars(link)}
							</span>
						{/each}
					{/if}
				</span>

				<span class="bg-border h-5 w-px shrink-0" aria-hidden="true"></span>

				<!-- SoC temperature -->
				<span
					class={cn('inline-flex shrink-0 items-center gap-1 font-mono tabular-nums', hud.isSensorsStale && 'opacity-50')}
					title={$LL.hud.temperature()}
				>
					{#if hud.isSensorsStale}
						<ClockIcon class="size-3 shrink-0" aria-hidden="true" />
					{:else}
						<ThermometerIcon class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
					{/if}
					{hud.temperature != null ? formatTemp(loc)(hud.temperature) : '—'}
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
								<SpeedBadge kbps={link.throughputKbps} stale={link.isStale} />
								{#if link.signal != null}
									<span class="font-mono text-xs tabular-nums" style:color={linkColor(link)}>
										{Math.round(link.signal)}%
									</span>
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
