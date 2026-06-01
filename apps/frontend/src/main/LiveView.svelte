<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import {
	ChevronRight,
	Cpu,
	Pencil,
	Play,
	Server,
	ServerOff,
	Square,
	Volume2,
} from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import { stopStreaming } from '$lib/helpers/SystemHelper';
import { getConfig, getIsStreaming, getSensors } from '$lib/rpc/subscriptions.svelte';

// Reactive state — non-deprecated subscriptions getters only.
const config = $derived(getConfig());
const isStreaming = $derived(getIsStreaming());
const sensors = $derived(getSensors());

// Server target: direct SRTLA address, or a selected relay server.
const serverTarget = $derived(config?.srtla_addr || config?.relay_server || '');
const hasServer = $derived(Boolean(serverTarget));
const showEmptyState = $derived(!hasServer && !isStreaming);

function formatBitrate(kbps: number | undefined): string {
	if (kbps === undefined || kbps === null) return '—';
	if (kbps >= 1000) {
		const mbps = kbps / 1000;
		const value = Number.isInteger(mbps) ? String(mbps) : mbps.toFixed(1);
		return `${value} ${$LL.units.mbps()}`;
	}
	return `${kbps} ${$LL.units.kbps()}`;
}

// Pick the operator-relevant sensors out of the flat string map.
function findSensor(predicate: (name: string) => boolean): string | undefined {
	const entries = sensors ? Object.entries(sensors) : [];
	const hit = entries.find(([name]) => predicate(name.toLowerCase()));
	return typeof hit?.[1] === 'string' ? hit[1] : undefined;
}
const tempSensor = $derived(findSensor((n) => n.includes('temp')));
const uptimeSensor = $derived(findSensor((n) => n.includes('uptime')));

// Config-row summaries — distilled from the saved config, never gray placeholders.
const encoderSummary = $derived.by(() => {
	const parts: string[] = [];
	if (config?.pipeline) parts.push(config.pipeline);
	if (config?.max_br) parts.push(formatBitrate(config.max_br));
	return parts.length ? parts.join(' · ') : $LL.general.notConfigured();
});
const audioSummary = $derived.by(() => {
	const parts: string[] = [];
	if (config?.acodec) parts.push(String(config.acodec).toUpperCase());
	if (config?.asrc) parts.push(config.asrc);
	return parts.length ? parts.join(' · ') : $LL.general.notConfigured();
});
const serverSummary = $derived.by(() => {
	if (!serverTarget) return $LL.general.notConfigured();
	return config?.srtla_port ? `${serverTarget}:${config.srtla_port}` : serverTarget;
});

// Wave 2 replaces these triggers with real Encoder / Audio / Server dialogs.
function openConfigDialog(section: string) {
	toast.info(`${section} — ${$LL.live.editSettings()}`, {
		description: 'Configuration dialog arrives in Wave 2.',
	});
}

function handleStart() {
	// The full start flow (source / resolution / codec selection) lives in the
	// encoder + server dialogs landing in Wave 2; the shell points there for now.
	toast.info($LL.live.startStream(), {
		description: 'Stream configuration dialog arrives in Wave 2.',
	});
}

function handleStop() {
	try {
		toast.dismiss();
	} catch {
		/* dismiss is best-effort */
	}
	if (typeof window !== 'undefined' && window.stopStreamingWithNotificationClear) {
		window.stopStreamingWithNotificationClear();
	} else {
		stopStreaming();
	}
}

type ConfigRow = {
	icon: typeof Cpu;
	label: string;
	value: string;
	section: string;
};
const configRows = $derived<ConfigRow[]>([
	{
		icon: Cpu,
		label: $LL.settings.encoderSettings(),
		value: encoderSummary,
		section: $LL.settings.encoderSettings(),
	},
	{
		icon: Volume2,
		label: $LL.general.audioSettings(),
		value: audioSummary,
		section: $LL.general.audioSettings(),
	},
	{
		icon: Server,
		label: $LL.general.serverSettings(),
		value: serverSummary,
		section: $LL.general.serverSettings(),
	},
]);
</script>

<div class="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
	<!-- Header: stream status, title, and a quick server reference -->
	<header class="flex flex-wrap items-center justify-between gap-4">
		<div class="flex items-center gap-3">
			{#if isStreaming}
				<span
					class="flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold tracking-wide uppercase"
					style="color: var(--status-live); border-color: color-mix(in oklab, var(--status-live) 40%, transparent); background-color: color-mix(in oklab, var(--status-live) 12%, transparent);"
				>
					<span
						class="h-2 w-2 rounded-full motion-safe:animate-pulse"
						style="background-color: var(--status-live);"
					></span>
					{$LL.live.streamingActive()}
				</span>
			{:else}
				<span
					class="text-muted-foreground flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold tracking-wide uppercase"
				>
					<span class="bg-muted-foreground/50 h-2 w-2 rounded-full"></span>
					{$LL.live.notStreaming()}
				</span>
			{/if}
			<div>
				<h1 class="text-2xl font-bold tracking-tight">{$LL.live.title()}</h1>
				<p class="text-muted-foreground text-sm">{$LL.live.description()}</p>
			</div>
		</div>

		{#if hasServer}
			<button
				class="hover:bg-accent focus-visible:ring-ring/50 flex max-w-full items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
				onclick={() => openConfigDialog($LL.general.serverSettings())}
			>
				<Server aria-hidden={true} class="text-muted-foreground h-4 w-4 shrink-0" />
				<span class="max-w-[12rem] truncate font-mono">{serverTarget}</span>
				<ChevronRight aria-hidden={true} class="text-muted-foreground h-4 w-4 shrink-0 rtl:-scale-x-100" />
			</button>
		{/if}
	</header>

	{#if showEmptyState}
		<!-- First-boot / empty state: no relay server, actionable prompt -->
		<Card.Root>
			<Card.Content
				class="flex flex-col items-center gap-5 px-6 py-14 text-center"
			>
				<div
					class="bg-secondary grid h-16 w-16 place-items-center rounded-2xl"
				>
					<ServerOff aria-hidden={true} class="text-muted-foreground h-8 w-8" />
				</div>
				<div class="space-y-2">
					<h2 class="text-lg font-semibold">{$LL.general.youHaventConfigured()}</h2>
					<p class="text-muted-foreground mx-auto max-w-sm text-sm">
						{$LL.live.configureToStart()}
					</p>
				</div>
				<Button
					class="gap-2"
					onclick={() => openConfigDialog($LL.general.serverSettings())}
				>
					<Server aria-hidden={true} class="h-4 w-4" />
					{$LL.live.editSettings()}
					<ChevronRight aria-hidden={true} class="h-4 w-4 rtl:-scale-x-100" />
				</Button>
			</Card.Content>
		</Card.Root>
	{:else}
		<!-- Live telemetry strip — only meaningful while streaming -->
		{#if isStreaming}
			<section
				aria-label={$LL.live.overview()}
				class="bg-card flex flex-wrap items-center gap-x-10 gap-y-4 rounded-xl border px-5 py-4"
			>
				<div class="space-y-1">
					<p class="text-muted-foreground text-xs font-medium tracking-wide uppercase">
						{$LL.hud.bitrate()}
					</p>
					<p class="font-mono text-lg font-semibold" style="color: var(--status-live);">
						{formatBitrate(config?.max_br)}
					</p>
				</div>
				{#if tempSensor}
					<div class="space-y-1">
						<p class="text-muted-foreground text-xs font-medium tracking-wide uppercase">
							{$LL.hud.temperature()}
						</p>
						<p class="font-mono text-lg font-semibold">{tempSensor}</p>
					</div>
				{/if}
				{#if uptimeSensor}
					<div class="space-y-1">
						<p class="text-muted-foreground text-xs font-medium tracking-wide uppercase">
							{$LL.hud.uptime()}
						</p>
						<p class="font-mono text-lg font-semibold">{uptimeSensor}</p>
					</div>
				{/if}
			</section>
		{/if}

		<!-- Configuration overview — one card, three trigger rows (no nested cards) -->
		<Card.Root class="overflow-hidden">
			<Card.Header class="pb-3">
				<Card.Title class="text-sm font-semibold">{$LL.live.streamSettings()}</Card.Title>
			</Card.Header>
			<Card.Content class="divide-border divide-y py-0">
				{#each configRows as row (row.label)}
					<div class="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
						<div class="flex min-w-0 items-start gap-3">
							<row.icon
								aria-hidden={true}
								class="text-muted-foreground mt-0.5 h-5 w-5 shrink-0"
							/>
							<div class="min-w-0">
								<p class="text-sm font-medium">{row.label}</p>
								<p class="text-muted-foreground truncate font-mono text-sm">{row.value}</p>
							</div>
						</div>
						<Button
							class="shrink-0 gap-1.5"
							onclick={() => openConfigDialog(row.section)}
							size="sm"
							variant="ghost"
						>
							<Pencil aria-hidden={true} class="h-3.5 w-3.5" />
							<span class="hidden sm:inline">{$LL.live.editSettings()}</span>
							<ChevronRight aria-hidden={true} class="h-4 w-4 rtl:-scale-x-100" />
						</Button>
					</div>
				{/each}
			</Card.Content>
		</Card.Root>

		<!-- Streaming control — prominent, lime to start, neutral to stop -->
		{#if isStreaming}
			<Button
				class="bg-secondary text-secondary-foreground hover:bg-secondary/80 group w-full gap-3 py-6 text-base font-semibold"
				onclick={handleStop}
				size="lg"
				type="button"
			>
				<Square aria-hidden={true} class="h-5 w-5 transition-transform group-hover:scale-110" />
				{$LL.live.stopStream()}
			</Button>
		{:else}
			<Button
				class="bg-primary text-primary-foreground hover:bg-primary/90 group w-full gap-3 py-6 text-base font-semibold"
				disabled={!hasServer}
				onclick={handleStart}
				size="lg"
				type="button"
			>
				<Play
					aria-hidden={true}
					class="h-5 w-5 transition-transform group-hover:translate-x-0.5 group-hover:scale-110"
				/>
				{$LL.live.startStream()}
			</Button>
		{/if}
	{/if}
</div>
