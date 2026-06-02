<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import {
	type AudioCodec,
	BITRATE_DEFAULT_MAX,
	BITRATE_DEFAULT_MIN,
	BITRATE_MAX,
	BITRATE_MIN,
} from '@ceraui/rpc/schemas';
import {
	ChevronRight,
	Cpu,
	Lock,
	Minus,
	Pencil,
	Play,
	Plus,
	Server,
	ServerOff,
	Square,
	Volume2,
} from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import { Button } from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import { Slider } from '$lib/components/ui/slider';
import { startStreaming, stopStreaming } from '$lib/helpers/SystemHelper';
import { rpc } from '$lib/rpc';
import { getConfig, getIsStreaming, getPipelines, getSensors } from '$lib/rpc/subscriptions.svelte';
import { buildEncoderSetConfig } from '$lib/streaming/encoderConfig';
import { buildStartConfig } from '$lib/streaming/startStreaming';
import { isSectionLocked, type StreamSection } from '$lib/streaming/streamingLockPolicy';
import AudioDialog, { type AudioConfigValues } from '$main/dialogs/AudioDialog.svelte';
import EncoderDialog, { type EncoderConfig } from '$main/dialogs/EncoderDialog.svelte';
import ServerDialog from '$main/dialogs/ServerDialog.svelte';

// Reactive state — non-deprecated subscriptions getters only.
const config = $derived(getConfig());
const isStreaming = $derived(getIsStreaming());
const sensors = $derived(getSensors());

// Server target: direct SRTLA address, or a selected relay server.
const serverTarget = $derived(config?.srtla_addr || config?.relay_server || '');
const hasServer = $derived(Boolean(serverTarget));
const showEmptyState = $derived(!hasServer && !isStreaming);

// ── Dialog open state ──────────────────────────────────────────────────────
let serverDialogOpen = $state(false);
let audioDialogOpen = $state(false);
let encoderOpen = $state(false);

// Encoder configuration dialog — owns the editable encoder draft; the dialog
// seeds from the saved device config and writes the selection back here.
let encoderConfig = $state<EncoderConfig>({
	source: undefined,
	resolution: undefined,
	framerate: undefined,
	bitrate: undefined,
	bitrateOverlay: undefined,
});

// Audio dialog: working override layered over the saved config until the next
// stream (re)start folds it into the full config sent to rpc.streaming.start.
let audioOverride = $state<AudioConfigValues | null>(null);

// Drives the AudioDialog gate: the drafted encoder source wins, the saved
// config pipeline is the fallback (mirrors EncoderDialog's own seeding).
const effectivePipeline = $derived(encoderConfig.source ?? config?.pipeline);

// Pipeline metadata for the effective source — used to capability-gate the
// resolution/framerate overrides when persisting the encoder draft.
const effectivePipelineData = $derived(
	effectivePipeline ? getPipelines()?.pipelines?.[effectivePipeline] : undefined,
);

// Persist the encoder draft via setConfig when EncoderDialog saves — mirrors
// the AudioDialog/ServerDialog persistence pattern. Resolution/framerate are
// capability-gated against the selected pipeline (buildEncoderSetConfig).
async function handleEncoderSave(saved: EncoderConfig) {
	try {
		await rpc.streaming.setConfig(buildEncoderSetConfig(saved, effectivePipelineData));
		toast.success($LL.notifications.saved());
	} catch {
		toast.error($LL.notifications.saveFailed());
	}
}

const effectiveAudioSource = $derived(audioOverride?.asrc ?? config?.asrc);
const effectiveAudioCodec = $derived(
	(audioOverride?.acodec ?? config?.acodec) as AudioCodec | undefined,
);
const effectiveAudioDelay = $derived(audioOverride?.delay ?? config?.delay ?? 0);

function handleAudioSave(values: AudioConfigValues) {
	audioOverride = values;
}

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

// ── Bitrate hot-adjust (the ONLY field changeable mid-stream) ──────────────
// Practical slider window seeded from the canonical schema constants.
const BITRATE_STEP = 250;
let interacting = $state(false);
// Seeded from the schema default; the $effect below mirrors the live config value.
let bitrateDraft = $state<number>(BITRATE_DEFAULT_MIN);

// Mirror the authoritative server value while the operator isn't dragging.
$effect(() => {
	const serverBr = config?.max_br;
	if (!interacting && typeof serverBr === 'number') {
		bitrateDraft = serverBr;
	}
});

function clampBitrate(kbps: number): number {
	return Math.round(Math.max(BITRATE_MIN, Math.min(BITRATE_MAX, kbps)));
}

// setBitrate applies live via ceracoder — NO stream stop required.
async function commitBitrate(kbps: number) {
	const clamped = clampBitrate(kbps);
	bitrateDraft = clamped;
	try {
		await rpc.streaming.setBitrate({ max_br: clamped });
	} catch {
		toast.error($LL.notifications.saveFailed());
	}
}

function stepBitrate(delta: number) {
	const next = clampBitrate(bitrateDraft + delta);
	commitBitrate(next);
}

// Config-row summaries — distilled from the saved config, never gray placeholders.
const encoderSummary = $derived.by(() => {
	const parts: string[] = [];
	const pipeline = encoderConfig.source ?? config?.pipeline;
	const bitrate = encoderConfig.bitrate ?? config?.max_br;
	if (pipeline) parts.push(pipeline);
	if (bitrate) parts.push(formatBitrate(bitrate));
	return parts.length ? parts.join(' · ') : $LL.general.notConfigured();
});
const audioSummary = $derived.by(() => {
	const parts: string[] = [];
	if (effectiveAudioCodec) parts.push(String(effectiveAudioCodec).toUpperCase());
	if (effectiveAudioSource) parts.push(effectiveAudioSource);
	return parts.length ? parts.join(' · ') : $LL.general.notConfigured();
});
const serverSummary = $derived.by(() => {
	if (!serverTarget) return $LL.general.notConfigured();
	return config?.srtla_port ? `${serverTarget}:${config.srtla_port}` : serverTarget;
});

// Start: assemble the full ConfigMessage from the SAVED backend config (the
// encoder/server dialogs persist via setConfig), fold in the unpersisted audio
// override, validate pipeline + server, then dispatch via SystemHelper →
// rpc.streaming.start. The streaming/idle UI is driven by getIsStreaming(),
// updated by the backend status push — never set locally here.
async function handleStart() {
	const result = buildStartConfig(config, audioOverride);
	if (!result.ok) {
		toast.error(
			result.error === 'missingPipeline'
				? $LL.live.cannotStartNoPipeline()
				: $LL.live.cannotStartNoServer(),
		);
		return;
	}

	try {
		toast.dismiss();
	} catch {
		/* dismiss is best-effort */
	}

	try {
		await startStreaming(result.config);
	} catch {
		toast.error($LL.live.startFailed());
	}
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
		void stopStreaming();
	}
}

type ConfigRow = {
	icon: typeof Cpu;
	label: string;
	value: string;
	section: StreamSection;
	onEdit: () => void;
};
const configRows = $derived<ConfigRow[]>([
	{
		icon: Cpu,
		label: $LL.settings.encoderSettings(),
		value: encoderSummary,
		section: 'encoder',
		onEdit: () => (encoderOpen = true),
	},
	{
		icon: Volume2,
		label: $LL.general.audioSettings(),
		value: audioSummary,
		section: 'audio',
		onEdit: () => (audioDialogOpen = true),
	},
	{
		icon: Server,
		label: $LL.general.serverSettings(),
		value: serverSummary,
		section: 'server',
		onEdit: () => (serverDialogOpen = true),
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
				class="hover:bg-accent focus-visible:ring-ring/50 flex min-h-[44px] max-w-full items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
				onclick={() => (serverDialogOpen = true)}
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
					onclick={() => (serverDialogOpen = true)}
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

			<!-- Bitrate hot-adjust: applied live via setBitrate, no stream stop -->
			<section
				aria-label={$LL.live.adjustBitrate()}
				class="bg-card space-y-3 rounded-xl border px-5 py-4"
			>
				<div class="flex items-center justify-between gap-4">
					<p class="text-sm font-medium">{$LL.live.adjustBitrate()}</p>
					<p
						class="font-mono text-base font-semibold tabular-nums"
						style="color: var(--status-live);"
					>
						{formatBitrate(bitrateDraft)}
					</p>
				</div>
				<div class="flex items-center gap-3">
					<Button
						aria-label="-{BITRATE_STEP} {$LL.units.kbps()}"
						class="size-11 shrink-0 rounded-lg"
						disabled={bitrateDraft <= BITRATE_MIN}
						onclick={() => stepBitrate(-BITRATE_STEP)}
						size="icon"
						variant="outline"
					>
						<Minus aria-hidden={true} class="h-4 w-4" />
					</Button>
					<Slider
						aria-label={$LL.live.adjustBitrate()}
						class="grow"
						max={BITRATE_DEFAULT_MAX}
						min={BITRATE_DEFAULT_MIN}
						onValueChange={(v: number) => {
							interacting = true;
							bitrateDraft = v;
						}}
						onValueCommit={(v: number) => {
							interacting = false;
							commitBitrate(v);
						}}
						step={BITRATE_STEP}
						type="single"
						value={bitrateDraft}
					/>
					<Button
						aria-label="+{BITRATE_STEP} {$LL.units.kbps()}"
						class="size-11 shrink-0 rounded-lg"
						disabled={bitrateDraft >= BITRATE_MAX}
						onclick={() => stepBitrate(BITRATE_STEP)}
						size="icon"
						variant="outline"
					>
						<Plus aria-hidden={true} class="h-4 w-4" />
					</Button>
				</div>
			</section>
		{/if}

		<!-- Configuration overview — one card, three trigger rows (no nested cards) -->
		<Card.Root class="overflow-hidden">
			<Card.Header class="pb-3">
				<Card.Title class="text-sm font-semibold">{$LL.live.streamSettings()}</Card.Title>
			</Card.Header>
			<Card.Content class="divide-border divide-y py-0">
				{#each configRows as row (row.label)}
					{@const locked = isSectionLocked(row.section, isStreaming)}
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
						{#if locked}
							<!-- Restart-required while live: stop the stream to change it -->
							<span
								class="text-muted-foreground inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium"
								title={$LL.live.stopToChange()}
							>
								<Lock aria-hidden={true} class="h-3.5 w-3.5" />
								<span class="hidden sm:inline">{$LL.live.stopToChange()}</span>
							</span>
						{:else}
							<Button
								class="min-h-[44px] shrink-0 gap-1.5"
								onclick={row.onEdit}
								size="sm"
								variant="ghost"
							>
								<Pencil aria-hidden={true} class="h-3.5 w-3.5" />
								<span class="hidden sm:inline">{$LL.live.editSettings()}</span>
								<ChevronRight aria-hidden={true} class="h-4 w-4 rtl:-scale-x-100" />
							</Button>
						{/if}
					</div>
				{/each}
			</Card.Content>
		</Card.Root>

		<!-- Streaming control — prominent, lime to start, neutral to stop -->
		{#if isStreaming}
			<Button
				class="bg-secondary text-secondary-foreground hover:bg-secondary/80 group min-h-[44px] w-full gap-3 py-6 text-base font-semibold"
				onclick={handleStop}
				size="lg"
				type="button"
			>
				<Square aria-hidden={true} class="h-5 w-5 transition-transform group-hover:scale-110" />
				{$LL.live.stopStream()}
			</Button>
		{:else}
			<Button
				class="bg-primary text-primary-foreground hover:bg-primary/90 group min-h-[44px] w-full gap-3 py-6 text-base font-semibold"
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

<ServerDialog bind:open={serverDialogOpen} />

<!-- Audio configuration dialog (opened from the Audio "Edit" row). -->
<AudioDialog
	bind:open={audioDialogOpen}
	audioCodec={effectiveAudioCodec}
	audioDelay={effectiveAudioDelay}
	audioSource={effectiveAudioSource}
	effectivePipeline={effectivePipeline}
	onSave={handleAudioSave}
/>

<!-- Encoder configuration dialog (opened from the Encoder "Edit" row). -->
<EncoderDialog bind:open={encoderOpen} bind:config={encoderConfig} onSave={handleEncoderSave} />
