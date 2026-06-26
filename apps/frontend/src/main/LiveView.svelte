<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { isAudioLiveSwitchEnabled } from '@ceraui/rpc';
import {
	type AudioCodec,
	BITRATE_DEFAULT_MAX,
	BITRATE_DEFAULT_MIN,
	BITRATE_MAX,
	BITRATE_MIN,
	SWITCH_AUDIO_ERRORS,
	SWITCH_INPUT_ERRORS,
} from '@ceraui/rpc/schemas';
import {
	ChevronRight,
	Cpu,
	PictureInPicture2,
	Radio,
	Server,
	ServerOff,
	Shuffle,
	Volume2,
} from '@lucide/svelte';
import { toast } from 'svelte-sonner';

import { Button } from '$lib/components/ui/button';
import ComingSoon from '$lib/components/custom/ComingSoon.svelte';
import IngestStats from '$lib/components/custom/IngestStats.svelte';
import SourceSection from '$lib/components/custom/SourceSection.svelte';
import PreviewCanvas from '$lib/components/preview/PreviewCanvas.svelte';
import * as Card from '$lib/components/ui/card';
import { getPipelineDisplayName } from '$lib/helpers/PipelineHelper';
import { startStreaming, stopStreaming } from '$lib/helpers/SystemHelper';
import { rpc } from '$lib/rpc';
import {
	confirmOperation,
	failOperation,
	osCommand,
} from '$lib/rpc/async-operation.svelte';
import {
	markPending,
	onRpcAppliedReactive,
	onRpcResolved,
} from '$lib/rpc/dirty-registry.svelte';
import {
	beginFieldSync,
	markFieldApplied,
	markFieldApplying,
	markFieldFailed,
} from '$lib/rpc/field-sync-state.svelte';
import {
	reconcileSwitchingInput,
	resolveAppliedBitrate,
} from '$lib/rpc/live-apply-reconcile';
import {
	buildServerSummary,
	type Destination,
	deriveDestination,
	findActiveSlot,
	kindBadgeLabelKey,
	managedSlotLabel,
	resolveReceiverKind,
} from '$lib/streaming/receiver-experience';
import {
	deriveFailover,
	normalizeOrder,
	reorderSource,
} from '$lib/streaming/source-preference';
import { navElements } from '$lib/config';
import {
	getActiveInput,
	getCapabilities,
	getConfig,
	getConnectionState,
	getDevices,
	getIsStreaming,
	getLinkTelemetry,
	getManagedIngestAccounts,
	getNetif,
	getPipelines,
	getRelays,
	getSensors,
	getStatus,
} from '$lib/rpc/subscriptions.svelte';
import {
	dismissOnboarding,
	isOnboardingDismissed,
} from '$lib/stores/onboarding.svelte';
import {
	getStreamingOptimismState,
	getStreamingStopReason,
	startStreamingOptimism,
	stopStreamingOptimism,
	reconcileStreamingOptimism,
	revertStreamingOptimism,
	clearStreamingStopReason,
} from '$lib/rpc/streaming-optimism.svelte';
import { buildEncoderSetConfig } from '$lib/streaming/encoderConfig';
import { canLiveSwitchInput, isAudioInputId } from '$lib/streaming/liveAudioSwitch';
import { buildStartConfig, canStartStream } from '$lib/streaming/startStreaming';
import AudioDialog, { type AudioConfigValues } from '$main/dialogs/AudioDialog.svelte';
import EncoderDialog, { type EncoderConfig } from '$main/dialogs/EncoderDialog.svelte';
import ServerDialog from '$main/dialogs/ServerDialog.svelte';
import BitrateAdjuster from '$main/live/BitrateAdjuster.svelte';
import CapabilityTierBanner from '$main/live/CapabilityTierBanner.svelte';
import LiveHeader from '$main/live/LiveHeader.svelte';
import OnboardingChecklist from '$main/live/OnboardingChecklist.svelte';
import ServerReadiness from '$main/live/ServerReadiness.svelte';
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

// Streaming optimism state (Task 6): reflects user intent immediately on click.
const streamingOptimismState = $derived(getStreamingOptimismState());
const streamingStopReason = $derived(getStreamingStopReason());

// Reconcile optimism to authoritative is_streaming broadcast.
$effect(() => {
	reconcileStreamingOptimism(isStreaming);
});

// The cerastream Tier-2 reason codes that carry a SPECIFIC start-failure
// message; any other reason (or an unstructured throw) shows the generic copy.
const STREAM_START_REASON_KEYS = [
	'srt_connect_failed',
	'srt_connection_lost',
	'srtla_initial_connect_failed',
	'srtla_no_connections',
	'capture_audio_error',
	'capture_video_error',
	'pipeline_stall',
] as const;
type StreamStartReasonKey = (typeof STREAM_START_REASON_KEYS)[number];

function startFailedMessage(reason: string): string {
	return (STREAM_START_REASON_KEYS as readonly string[]).includes(reason)
		? $LL.live.startFailed[reason as StreamStartReasonKey]()
		: $LL.live.startFailed.generic();
}

// Show error toast if start failed (stop reason set).
$effect(() => {
	if (streamingStopReason) {
		toast.error(startFailedMessage(streamingStopReason));
	}
});

// Keep the ingest panel mounted across the streaming→idle edge so its end-of-
// session summary (peak/avg bitrate, per-link uptime, drops) survives the stream
// stopping — the live table unmounts with the streaming-only strip, but the
// device-local summary must persist until the next session starts.
let hadSession = $state(false);
$effect(() => {
	if (isStreaming) hadSession = true;
});

// Hotplug input picker (Task 34). The pipeline picker (EncoderDialog) is
// untouched.
const devices = $derived(getDevices());
const activeInput = $derived(getActiveInput());
let selectedInput = $state<string | undefined>(undefined);
let switchingInput = $state<string | undefined>(undefined);

// Reconnect-aware reconciliation (Task 15): a live `switchInput` restarts the
// pipeline, which can drop and replace the WebSocket — orphaning the in-flight
// RPC so its `finally` never clears `switchingInput`. Watch the authoritative
// connection state and, on the reconnect edge (→ connected), drop a stuck latch
// so the picker reconciles to the server-reported `activeInput` instead of a
// stale optimistic "switching" state.
let prevConnection = $state(getConnectionState());
$effect(() => {
	const next = getConnectionState();
	switchingInput = reconcileSwitchingInput(prevConnection, next, switchingInput);
	prevConnection = next;
});

// Sole gate for the live audio-switch affordance (G2): the engine capability
// flag, never a version string. False in Track 1, so audio sources render a
// disabled "coming soon" affordance and can never be live-switched.
const audioLiveSwitchEnabled = $derived(isAudioLiveSwitchEnabled(getCapabilities()));

// One per-field sync key drives the audio-switch applying/applied/failed glyph
// in the picker (Task 5 machine), regardless of which audio source is targeted.
const AUDIO_SWITCH_FIELD = 'audio_switch';

async function handleSwitchInput(inputId: string) {
	// Defense-in-depth: even if a UI path offered an audio switch, refuse to
	// dispatch a live switch for an audio:* id while the capability is off — the
	// engine would reject it with DeviceNotFound (TD-live-audio-switch).
	if (!canLiveSwitchInput(inputId, audioLiveSwitchEnabled)) {
		console.warn(
			`[CeraUI] Blocked live switch for audio source "${inputId}": live audio switching is not available (audio_live_switch capability is off).`,
		);
		return;
	}
	if (isAudioInputId(inputId)) {
		await handleSwitchAudio(inputId);
		return;
	}
	switchingInput = inputId;
	try {
		// The live input switch routes through the keyed async-operation machine
		// (key 'switch-input') for the re-entry guard + in-flight `pending` phase.
		// `classify` keeps every resolved verdict `ok` so osCommand never emits its
		// generic toast — the picker keeps its nuanced switched/source-lost/failed
		// feedback below — and we drive the confirmed/failed phase by hand. Only a
		// thrown RPC toasts (via `failMessage`).
		const res = await osCommand({
			key: 'switch-input',
			target: inputId,
			rpc: () => rpc.streaming.switchInput({ input_id: inputId }),
			classify: () => ({ ok: true }),
			failMessage: () => $LL.live.inputPicker.switchFailed(),
		});
		if (!res) return; // re-entry no-op or a thrown RPC (osCommand already toasted)
		if (res.success) {
			confirmOperation('switch-input');
			toast.success($LL.live.inputPicker.switched({ ms: res.gap_ms ?? 0 }));
		} else {
			failOperation('switch-input', res.error ?? 'failed');
			toast.error(
				res.error === SWITCH_INPUT_ERRORS.SOURCE_LOST
					? $LL.live.inputPicker.sourceLost()
					: $LL.live.inputPicker.switchFailed(),
			);
		}
	} finally {
		switchingInput = undefined;
	}
}

// Live audio source switch (Task 25): gated on audio_live_switch, dispatched via
// the dedicated switchAudio procedure with the Task-5 applying→applied/failed
// machine and a non-blocking informational gap toast on success.
async function handleSwitchAudio(inputId: string) {
	switchingInput = inputId;
	beginFieldSync(AUDIO_SWITCH_FIELD, inputId);
	markFieldApplying(AUDIO_SWITCH_FIELD);
	try {
		const res = await rpc.streaming.switchAudio({ audio_input_id: inputId });
		if (res.success) {
			markFieldApplied(AUDIO_SWITCH_FIELD, res.active_audio_input ?? inputId);
			toast.info($LL.live.inputPicker.audioSwitched({ ms: res.gap_ms ?? 0 }));
		} else {
			markFieldFailed(AUDIO_SWITCH_FIELD, activeInput ?? inputId);
			toast.error(
				res.error === SWITCH_AUDIO_ERRORS.AUDIO_DEVICE_NOT_FOUND
					? $LL.live.inputPicker.audioSourceLost()
					: $LL.live.inputPicker.audioSwitchFailed(),
			);
		}
	} catch {
		markFieldFailed(AUDIO_SWITCH_FIELD, activeInput ?? inputId);
		toast.error($LL.live.inputPicker.audioSwitchFailed());
	} finally {
		switchingInput = undefined;
	}
}

function handleSelectInput(inputId: string) {
	selectedInput = inputId;
}

// Operator-ordered source preference (Task 11). Display order is the persisted
// preference reconciled against the live device list; the engine's auto-failover
// is sticky and does NOT consult this order.
const SOURCE_PREFERENCE_FIELD = 'source_preference';
const sourceOrder = $derived(normalizeOrder(devices, config?.source_preference));
const sourceFailover = $derived(deriveFailover(sourceOrder, devices, activeInput));

async function handleReorderSource(inputId: string, direction: 'up' | 'down') {
	const current = normalizeOrder(devices, config?.source_preference);
	const next = reorderSource(current, inputId, direction);
	if (next.length === current.length && next.every((id, i) => id === current[i])) {
		return;
	}
	beginFieldSync(SOURCE_PREFERENCE_FIELD, next);
	markFieldApplying(SOURCE_PREFERENCE_FIELD);
	try {
		await rpc.streaming.setConfig({ source_preference: next });
		markFieldApplied(SOURCE_PREFERENCE_FIELD, next);
	} catch {
		markFieldFailed(SOURCE_PREFERENCE_FIELD, current);
		toast.error($LL.live.sourcePreference.sync.failed());
	}
}

// Server target: direct SRTLA address, or a selected relay server.
const serverTarget = $derived(config?.srtla_addr || config?.relay_server || '');
const hasServer = $derived(Boolean(serverTarget));
const showEmptyState = $derived(!hasServer && !isStreaming);

// First-run onboarding (T13). Each step is checked off from existing state — no
// new subscription. Network = at least one enabled bonded interface that has an
// IP; Server = the existing `hasServer`; Start = the stream is or has been live.
// The checklist auto-hides once both CONFIG steps (Network + Server) are done, so
// a fully-configured device never sees it; it can also be dismissed (persisted).
const netif = $derived(getNetif());
const hasNetwork = $derived(
	Object.values(netif ?? {}).some((entry) => Boolean(entry?.enabled) && Boolean(entry?.ip)),
);
const onboardingStartDone = $derived(isStreaming || hadSession);
const onboardingComplete = $derived(hasNetwork && hasServer);
const showOnboarding = $derived(!isOnboardingDismissed() && !onboardingComplete);

// Destination + receiver kind for the header chip (T5 helpers). Managed shows a
// provider label, custom shows the endpoint; both append the transport badge.
// Brand provider names are non-translated literals (i18n branding convention;
// mirrors ServerDialog's PROVIDER_LABELS).
const PROVIDER_LABELS: Record<string, string> = {
	ceralive: 'CeraLive Cloud',
	belabox: 'BELABOX Cloud',
};
const relays = $derived(getRelays());
const relayServerInfo = $derived(
	config?.relay_server ? relays?.servers?.[config.relay_server] : undefined,
);
const destination = $derived<Destination | undefined>(
	hasServer ? deriveDestination(config) : undefined,
);
const receiverKind = $derived(
	hasServer
		? resolveReceiverKind({
				protocol: config?.relay_protocol,
				destination: destination ?? 'custom',
				server: relayServerInfo,
			})
		: undefined,
);
const providerName = $derived(
	PROVIDER_LABELS[config?.remote_provider ?? ''] ?? relayServerInfo?.name ?? 'CeraLive Cloud',
);
const receiverEndpoint = $derived.by(() => {
	if (!config?.srtla_addr) return undefined;
	return config?.srtla_port ? `${config.srtla_addr}:${config.srtla_port}` : config.srtla_addr;
});

// Active managed ingest slot (T19): when the persisted selection resolves to a
// known platform slot, its label names the instance in the header chip.
const activeSlot = $derived(
	findActiveSlot(getManagedIngestAccounts(), config?.selected_ingest_endpoint),
);
const slotLabel = $derived(activeSlot ? managedSlotLabel(activeSlot) : undefined);

// Live active-link count drives the bonded-links readiness hint (T13). Null
// while idle (`getLinkTelemetry()` is null) so SRTLA degrades to label-only —
// never a stale count. The readiness reuses the header's `receiverKind`.
const linkCount = $derived(linkTelemetry ? linkTelemetry.links.length : null);

async function handleManageLinks() {
	const network = navElements.network;
	if (!network) return;
	// Lazy import severs the LiveView→navigation static edge: navigation.svelte.ts
	// (and $lib/config) statically import LiveView for the default destination, so
	// a static back-import here closes a module cycle whose initializer touches
	// LiveView before it is defined (TDZ at app mount). Resolved at click time.
	const { navigateTo } = await import('$lib/stores/navigation.svelte');
	navigateTo({ network });
}

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

// Pipeline-reported audio sources (status.asrcs) — the pre-start asrc selection
// surfaced inline in the unified Source section, identical feed to AudioDialog.
const audioSources = $derived(getStatus()?.asrcs ?? []);

function handleAudioSave(values: AudioConfigValues) {
	audioOverride = values;
}

// Inline pre-start audio-source pick from the Source section. Folds into the
// working audio override (keeping codec/delay) so the Live summary + start
// config reflect it immediately, then persists via setConfig (no stream restart)
// — mirrors AudioDialog's asrc path. Live audio switching stays gated (Task 10):
// the Source section only offers this control while idle.
async function handleSelectAudioSource(asrc: string) {
	audioOverride = {
		asrc,
		acodec: effectiveAudioCodec ?? 'aac',
		delay: effectiveAudioDelay,
	};
	markPending('asrc', asrc);
	try {
		await rpc.streaming.setConfig({ asrc });
	} catch {
		toast.error($LL.notifications.saveFailed());
	} finally {
		onRpcResolved('asrc');
	}
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
		const res = await rpc.streaming.setBitrate({ max_br: clamped });
		onRpcResolved('max_br');
		// Release the field-lock to the SERVER-APPLIED value (T9 envelope), never
		// the optimistic value we sent. On success:false reconcile to the last
		// known server value so a rejected write never sticks on the slider.
		const applied = resolveAppliedBitrate(res, clamped, config?.max_br);
		onRpcAppliedReactive('max_br', applied);
		bitrateDraft = applied;
		if (!res.success) toast.error($LL.notifications.saveFailed());
	} catch {
		// RPC rejected: clear the optimistic lock and reconcile to server truth so
		// the slider is never stuck on the unconfirmed optimistic value.
		onRpcResolved('max_br');
		const authoritative = config?.max_br ?? clamped;
		onRpcAppliedReactive('max_br', authoritative);
		bitrateDraft = authoritative;
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
// Kind-aware server config-row summary (T11): reuses the header's `receiverKind`
// and the live `linkCount` (null while idle → 0, so a disconnected receiver
// shows no fresh bonding clause).
const serverSummary = $derived(
	buildServerSummary(
		config,
		receiverKind,
		linkCount ?? 0,
		{
			notConfigured: $LL.general.notConfigured(),
			kindLabel: (k) => t(kindBadgeLabelKey(k)),
			bondedAcross: (count) => $LL.live.server.bondedAcross({ count }),
			singleLink: $LL.live.server.singleLink(),
			providerLabel: (provider) =>
				provider && provider !== 'custom' ? PROVIDER_LABELS[provider] : undefined,
			feedsCloudObsInstance: (label) => $LL.settings.feedsCloudObsInstance({ label }),
		},
		activeSlot,
	),
);

// Start: assemble the full ConfigMessage from the SAVED backend config (the
// encoder/server dialogs persist via setConfig), fold in the unpersisted audio
// override, validate pipeline + server, then dispatch via SystemHelper →
// rpc.streaming.start. The streaming/idle UI is driven by getIsStreaming(),
// updated by the backend status push — never set locally here.
// Optimistic transient: Start button shows `starting` immediately on click,
// then reconciles to authoritative is_streaming broadcast (Task 6).
const canStart = $derived(
	canStartStream({
		hasServer,
		pipelineRecognized,
		starting: streamingOptimismState === 'starting',
	}),
);

// Reason the Start control is disabled, surfaced as a hover hint (reuses the
// existing cannot-start copy; ordered to match canStartStream's predicate).
const startDisabledReason = $derived(
	streamingOptimismState === 'starting'
		? $LL.live.starting()
		: !pipelineRecognized
			? $LL.live.cannotStartNoPipeline()
			: !hasServer
				? $LL.live.cannotStartNoServer()
				: undefined,
);

async function handleStart() {
	if (streamingOptimismState !== 'idle') return;

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

	// Optimistic transient: show `starting` immediately.
	startStreamingOptimism();

	try {
		const startResult = await startStreaming(result.config);
		// A structured `{ success: false, reason }` is the engine refusing the
		// start — surface the SPECIFIC reason code so the toast names it. On
		// success, reconciliation happens via the is_streaming broadcast.
		if (startResult && !startResult.success) {
			revertStreamingOptimism(startResult.reason ?? 'unknown_error');
		}
	} catch (error) {
		// Transport/validation throw: revert to idle with the error message.
		const reason =
			error instanceof Error ? error.message : 'unknown_error';
		revertStreamingOptimism(reason);
	}
}

function handleStop() {
	try {
		toast.dismiss();
	} catch {
		/* dismiss is best-effort */
	}

	// Optimistic transient: show `stopping` immediately.
	stopStreamingOptimism();

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
		{destination}
		kind={receiverKind}
		{providerName}
		{slotLabel}
		endpoint={receiverEndpoint}
		onEditServer={() => (serverDialogOpen = true)}
	/>

	<!-- Capability-tier state: calm banner when the engine is offline/starting or
	     reports a schema mismatch. Renders nothing in the normal tier. -->
	<CapabilityTierBanner caps={getCapabilities()} />

	<!-- First-run guidance (T13): a calm Network → Server → Start checklist that
	     complements (never replaces) the empty-state hero below. Auto-hides once
	     Network + Server are configured; dismissible, with the dismissal persisted. -->
	{#if showOnboarding}
		<OnboardingChecklist
			networkDone={hasNetwork}
			serverDone={hasServer}
			startDone={onboardingStartDone}
			onConfigureNetwork={handleManageLinks}
			onConfigureServer={() => (serverDialogOpen = true)}
			onDismiss={dismissOnboarding}
		/>
	{/if}

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
					<h2 class="text-lg font-semibold">{$LL.live.chooseDestination()}</h2>
					<p class="text-muted-foreground mx-auto max-w-sm text-sm">
						{$LL.settings.destinationCustomHint()}
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

		{/if}

		<!-- Bonded-ingest telemetry + per-session summary/export (#21). Kept mounted
		     across the streaming→idle edge so the rollup survives stream stop. -->
		{#if isStreaming || hadSession}
			<IngestStats telemetry={linkTelemetry} {isStreaming} bitrateKbps={config?.max_br} />
		{:else}
			<!-- Idle ingest area: no live bond yet. Calm, informational (no telemetry
			     values shown, so no fresh-looking stale data) — points to Network. -->
			<Card.Root>
				<Card.Content class="flex flex-col items-center gap-4 px-6 py-10 text-center" data-testid="ingest-idle-empty">
					<div class="bg-secondary grid size-12 place-items-center rounded-xl">
						<Radio aria-hidden={true} class="text-muted-foreground h-6 w-6" />
					</div>
					<div class="space-y-1.5">
						<h2 class="text-base font-semibold">{$LL.live.ingest.idleTitle()}</h2>
						<p class="text-muted-foreground mx-auto max-w-sm text-sm">{$LL.live.ingest.idleHint()}</p>
					</div>
					<Button class="gap-2" onclick={handleManageLinks} variant="outline">
						<Radio aria-hidden={true} class="h-4 w-4" />
						{$LL.live.server.manageLinks()}
						<ChevronRight aria-hidden={true} class="h-4 w-4 rtl:-scale-x-100" />
					</Button>
				</Card.Content>
			</Card.Root>
		{/if}

	<SourceSection
		{activeInput}
		audioLiveSwitchField={AUDIO_SWITCH_FIELD}
		{audioLiveSwitchEnabled}
		{audioSources}
		capabilities={getCapabilities()}
		{devices}
		{isStreaming}
			onReorderSource={handleReorderSource}
			onSelect={handleSelectInput}
			onSelectAudioSource={handleSelectAudioSource}
			onSwitch={handleSwitchInput}
			selectedAudioSource={effectiveAudioSource}
			{selectedInput}
			sourceFailover={sourceFailover}
			sourceOrder={sourceOrder}
			sourcePreferenceField={SOURCE_PREFERENCE_FIELD}
			{switchingInput}
		/>

		<!--
			Roadmap affordances — genuine future features surfaced as calm, purely
			informational pills (NOT the disabled-with-reason warning treatment). Each
			ComingSoon renders a dynamic data-debt-id into the DOM for tests; the static
			binding the CI gate (scripts/check-tech-debt.mjs) verifies lives in the literal
			ids on the next line.
			roadmap: data-debt-id="TD-pip" data-debt-id="TD-mode-fallback"
		-->
		<div
			class="bg-muted/30 flex flex-col gap-2.5 rounded-lg border px-4 py-3"
			data-testid="live-roadmap"
		>
			<div class="flex items-center justify-between gap-3">
				<span class="text-muted-foreground flex items-center gap-2 text-sm">
					<PictureInPicture2 aria-hidden={true} class="size-4 shrink-0" />
					{$LL.live.comingSoon.pip()}
				</span>
				<ComingSoon debtId="TD-pip" />
			</div>
			<div class="flex items-center justify-between gap-3">
				<span class="text-muted-foreground flex items-center gap-2 text-sm">
					<Shuffle aria-hidden={true} class="size-4 shrink-0" />
					{$LL.live.comingSoon.modeFallback()}
				</span>
				<ComingSoon debtId="TD-mode-fallback" />
			</div>
		</div>

		<PreviewCanvas />

		{#if receiverKind}
			<ServerReadiness
				kind={receiverKind}
				{linkCount}
				onManageLinks={handleManageLinks}
			/>
		{/if}

		<StreamSettingsCard {configRows} {isStreaming} />

		<StreamControlButton
			{canStart}
			disabledReason={startDisabledReason}
			{isStreaming}
			optimismState={streamingOptimismState}
			onStart={handleStart}
			onStop={handleStop}
		/>
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
