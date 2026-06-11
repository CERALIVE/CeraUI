<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import {
	type AudioCodec,
	BITRATE_DEFAULT_MAX,
	BITRATE_DEFAULT_MIN,
	BITRATE_MAX,
	BITRATE_MIN,
	SWITCH_INPUT_ERRORS,
} from '@ceraui/rpc/schemas';
import { ChevronRight, Cpu, Server, ServerOff, Volume2 } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import { Button } from '$lib/components/ui/button';
import IngestStats from '$lib/components/custom/IngestStats.svelte';
import InputPicker from '$lib/components/custom/InputPicker.svelte';
import PreviewCanvas from '$lib/components/preview/PreviewCanvas.svelte';
import * as Card from '$lib/components/ui/card';
import { getPipelineDisplayName } from '$lib/helpers/PipelineHelper';
import { startStreaming, stopStreaming } from '$lib/helpers/SystemHelper';
import { rpc } from '$lib/rpc';
import { markPending, onRpcResolved } from '$lib/rpc/dirty-registry.svelte';
import {
	getActiveInput,
	getConfig,
	getDevices,
	getIsStreaming,
	getLinkTelemetry,
	getPipelines,
	getSensors,
} from '$lib/rpc/subscriptions.svelte';
import { buildEncoderSetConfig } from '$lib/streaming/encoderConfig';
import { buildStartConfig, canStartStream } from '$lib/streaming/startStreaming';
import AudioDialog, { type AudioConfigValues } from '$main/dialogs/AudioDialog.svelte';
import EncoderDialog, { type EncoderConfig } from '$main/dialogs/EncoderDialog.svelte';
import ServerDialog from '$main/dialogs/ServerDialog.svelte';
import BitrateAdjuster from '$main/live/BitrateAdjuster.svelte';
import LiveHeader from '$main/live/LiveHeader.svelte';
import StreamControlButton from '$main/live/StreamControlButton.svelte';
import StreamSettingsCard, { type ConfigRow } from '$main/live/StreamSettingsCard.svelte';
import StreamTelemetryStrip from '$main/live/StreamTelemetryStrip.svelte';

// Reactive state — non-deprecated subscriptions getters only.
const config = $derived(getConfig());
const isStreaming = $derived(getIsStreaming());
const sensors = $derived(getSensors());
// Per-link srtla ingest telemetry (RTT/NAK/weight) — already broadcast via
// status.linkTelemetry; surfaced here as a read-only panel, no new collector.
const linkTelemetry = $derived(getLinkTelemetry());

// Hotplug input picker (Task 34). The pipeline picker (EncoderDialog) is
// untouched.
const devices = $derived(getDevices());
const activeInput = $derived(getActiveInput());
let selectedInput = $state<string | undefined>(undefined);
let switchingInput = $state<string | undefined>(undefined);

async function handleSwitchInput(inputId: string) {
	switchingInput = inputId;
	try {
		const res = await rpc.streaming.switchInput({ input_id: inputId });
		if (res.success) {
			toast.success($LL.live.inputPicker.switched({ ms: res.gap_ms ?? 0 }));
		} else if (res.error === SWITCH_INPUT_ERRORS.SOURCE_LOST) {
			toast.error($LL.live.inputPicker.sourceLost());
		} else {
			toast.error($LL.live.inputPicker.switchFailed());
		}
	} catch {
		toast.error($LL.live.inputPicker.switchFailed());
	} finally {
		switchingInput = undefined;
	}
}

function handleSelectInput(inputId: string) {
	selectedInput = inputId;
}

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

// i18n key resolver (mirrors EncoderDialog) — passed to PipelineHelper so the
// friendly source label is translated, with safe key-passthrough on a miss.
const t = (key: string): string => {
	const parts = key.split('.');
	let result: unknown = $LL;
	for (const part of parts) {
		if (result && typeof result === 'object' && part in result) {
			result = (result as Record<string, unknown>)[part];
		} else {
			return key;
		}
	}
	return typeof result === 'function' ? (result as () => string)() : key;
};

// Whether the effective pipeline resolves to a known registry entry. Single
// source of truth for the reconfigure-required affordance (consumed by T8).
const pipelineRecognized = $derived(effectivePipeline ? Boolean(effectivePipelineData) : false);

// Set-but-unrecognized: a stale/legacy pipeline id is persisted but absent from
// the live registry — surface "reconfigure required" instead of the raw id.
const pipelineNeedsReconfigure = $derived(Boolean(effectivePipeline) && !pipelineRecognized);

// Persist the encoder draft via setConfig when EncoderDialog saves — mirrors
// the AudioDialog/ServerDialog persistence pattern. Resolution/framerate are
// capability-gated against the selected pipeline (buildEncoderSetConfig).
async function handleEncoderSave(saved: EncoderConfig) {
	// Lock each field this save actually changes BEFORE the RPC, so a stale
	// server echo of the old value can't revert the optimistic edit; release
	// after the RPC settles (resolve or reject) to avoid a permanent lock.
	const input = buildEncoderSetConfig(saved, effectivePipelineData);
	const fields = Object.entries(input);
	for (const [field, value] of fields) markPending(field, value);
	try {
		await rpc.streaming.setConfig(input);
		toast.success($LL.notifications.saved());
	} catch {
		toast.error($LL.notifications.saveFailed());
	} finally {
		for (const [field] of fields) onRpcResolved(field);
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

// setBitrate applies live via the engine — NO stream stop required.
async function commitBitrate(kbps: number) {
	const clamped = clampBitrate(kbps);
	bitrateDraft = clamped;
	// Live edit (no gating): lock max_br before the RPC so a stale config echo
	// of the prior bitrate can't flicker the slider back; release after settle.
	markPending('max_br', clamped);
	try {
		await rpc.streaming.setBitrate({ max_br: clamped });
	} catch {
		toast.error($LL.notifications.saveFailed());
	} finally {
		onRpcResolved('max_br');
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
	if (pipeline) {
		parts.push(
			pipelineRecognized
				? getPipelineDisplayName(pipeline, getPipelines()?.pipelines, t)
				: $LL.live.reconfigureRequired(),
		);
	}
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
// Double-start safety: guards against a second dispatch while one is in flight.
let starting = $state(false);

// Start is allowed only with a server, a recognized pipeline, and no start
// already in flight — mirrors the buildStartConfig gates client-side.
const canStart = $derived(canStartStream({ hasServer, pipelineRecognized, starting }));

async function handleStart() {
	if (starting) return;

	const result = buildStartConfig(config, audioOverride, getPipelines()?.pipelines);
	if (!result.ok) {
		toast.error(
			result.error === 'missingServer'
				? $LL.live.cannotStartNoServer()
				: $LL.live.cannotStartNoPipeline(),
		);
		return;
	}

	try {
		toast.dismiss();
	} catch {
		/* dismiss is best-effort */
	}

	starting = true;
	try {
		await startStreaming(result.config);
	} catch {
		toast.error($LL.live.startFailed());
	} finally {
		starting = false;
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

const configRows = $derived<ConfigRow[]>([
	{
		icon: Cpu,
		label: $LL.settings.encoderSettings(),
		value: encoderSummary,
		section: 'encoder',
		onEdit: () => (encoderOpen = true),
		testId: 'open-encoder-dialog',
		warn: pipelineNeedsReconfigure,
	},
	{
		icon: Volume2,
		label: $LL.general.audioSettings(),
		value: audioSummary,
		section: 'audio',
		onEdit: () => (audioDialogOpen = true),
		testId: 'open-audio-dialog',
	},
	{
		icon: Server,
		label: $LL.general.serverSettings(),
		value: serverSummary,
		section: 'server',
		onEdit: () => (serverDialogOpen = true),
		testId: 'open-server-dialog',
	},
]);
</script>

<div class="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
	<LiveHeader
		{hasServer}
		{isStreaming}
		onEditServer={() => (serverDialogOpen = true)}
		{serverTarget}
	/>

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
		<!-- Live telemetry strip + bitrate hot-adjust — only meaningful while streaming -->
		{#if isStreaming}
			<StreamTelemetryStrip
				bitrate={formatBitrate(config?.max_br)}
				{tempSensor}
				{uptimeSensor}
			/>

			<BitrateAdjuster
				bitrateDraft={bitrateDraft}
				bitrateLabel={formatBitrate(bitrateDraft)}
				bitrateMax={BITRATE_MAX}
				bitrateMin={BITRATE_MIN}
				onSliderChange={(v) => {
					interacting = true;
					bitrateDraft = v;
				}}
				onSliderCommit={(v) => {
					interacting = false;
					commitBitrate(v);
				}}
				onStep={stepBitrate}
				sliderMax={BITRATE_DEFAULT_MAX}
				sliderMin={BITRATE_DEFAULT_MIN}
				step={BITRATE_STEP}
			/>

			<!-- Bonded-ingest telemetry (RTT / NAK / weight per uplink) — Task 21 -->
			<IngestStats telemetry={linkTelemetry} />
		{/if}

		<Card.Root>
			<Card.Content class="p-4 sm:p-6">
				<InputPicker
					activeInput={activeInput}
					devices={devices}
					isStreaming={isStreaming}
					onSelect={handleSelectInput}
					onSwitch={handleSwitchInput}
					selectedInput={selectedInput}
					switchingInput={switchingInput}
				/>
			</Card.Content>
		</Card.Root>

		<PreviewCanvas />

		<StreamSettingsCard {configRows} {isStreaming} />

		<StreamControlButton {canStart} {isStreaming} onStart={handleStart} onStop={handleStop} />
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
