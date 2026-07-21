<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { isAudioLiveSwitchEnabled } from '@ceraui/rpc';
import {
	type AudioCodec,
	BITRATE_DEFAULT_MAX,
	BITRATE_DEFAULT_MIN,
	BITRATE_MAX,
	BITRATE_MIN,
	type RelayProtocol,
	SWITCH_AUDIO_ERRORS,
	SWITCH_INPUT_ERRORS,
} from '@ceraui/rpc/schemas';
import { Cpu, Server } from '@lucide/svelte';
import { toast } from 'svelte-sonner';

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
	fingerprintForValidation,
	getDestinationValidated,
	recordValidation,
	resolveValidationEndpoint,
} from '$lib/streaming/destination-validation.svelte';
import {
	buildServerSummary,
	type Destination,
	deriveDestination,
	findActiveSlot,
	kindBadgeLabelKey,
	resolveReceiverKind,
} from '$lib/streaming/receiver-experience';
import {
	audioSourceLabel,
	deriveActiveSummary,
	resolveAudioSourceList,
	resolvedAudioLabel,
} from '$lib/streaming/sourceSummary';
import { navElements } from '$lib/config';
import {
	getActiveInput,
	getCapabilities,
	getConfig,
	getConnectionState,
	getIsConnected,
	getIsStreaming,
	getLinkTelemetry,
	getManagedIngestAccounts,
	getNetif,
	getPipelines,
	getRelays,
	getSensors,
	getSources,
	getStatus,
} from '$lib/rpc/subscriptions.svelte';
import {
	getStopStuckBannerVisible,
	getStreamingOptimismState,
	getStreamingStopReason,
	retryStopStreaming,
	startStreamingOptimism,
	stopStreamingOptimism,
	reconcileStreamingOptimism,
	revertStreamingOptimism,
} from '$lib/rpc/streaming-optimism.svelte';
import { isSelectedAudioLost } from '$lib/streaming/audioLost';
import { buildEncoderSetConfig } from '$lib/streaming/encoderConfig';
import { canLiveSwitchInput, isAudioInputId } from '$lib/streaming/liveAudioSwitch';
import { buildStartConfig } from '$lib/streaming/startStreaming';
import AudioDialog, { type AudioConfigValues } from '$main/dialogs/AudioDialog.svelte';
import EncoderDialog, { type EncoderConfig } from '$main/dialogs/EncoderDialog.svelte';
import ServerDialog from '$main/dialogs/ServerDialog.svelte';
import CapabilityTierBanner from '$main/live/CapabilityTierBanner.svelte';
import IdleCockpit from '$main/live/IdleCockpit.svelte';
import LiveCockpit from '$main/live/LiveCockpit.svelte';
import LiveHeader from '$main/live/LiveHeader.svelte';
import type { ConfigRow } from '$main/live/StreamSettingsCard.svelte';

// Reactive state — non-deprecated subscriptions getters only.
const config = $derived(getConfig());
const isStreaming = $derived(getIsStreaming());
const sensors = $derived(getSensors());
// Per-link srtla ingest telemetry (RTT/NAK/weight) — already broadcast via
// status.linkTelemetry; surfaced here as a read-only panel, no new collector.
const linkTelemetry = $derived(getLinkTelemetry());
// Mid-stream audio-device-lost banner: the selected real audio device dropped
// from the available list (backend also raises a silence-failover notification).
const audioSourceLost = $derived(
	isSelectedAudioLost(config?.asrc, getStatus()?.asrcs),
);

// Streaming optimism state (Task 6): reflects user intent immediately on click.
const streamingOptimismState = $derived(getStreamingOptimismState());
const streamingStopReason = $derived(getStreamingStopReason());
// Truthful stop-stuck banner (T0): shown only while the authoritative flag still
// says streaming after the bounded stopping watchdog pulled + re-dispatched.
const stopStuckBanner = $derived(getStopStuckBannerVisible());

// Idle vs Live cockpit gate (Task 11): the optimistic view of streaming so the
// start transition shows LiveCockpit immediately (no flicker back to idle mid-
// start), and the stop transition keeps LiveCockpit until the authoritative
// is_streaming=false arrives (isStreaming is still true while `stopping`).
const optimisticIsStreaming = $derived(
	isStreaming || streamingOptimismState === 'starting',
);

// Reconcile optimism to authoritative is_streaming broadcast.
$effect(() => {
	reconcileStreamingOptimism(isStreaming);
});

// ── Post-stream summary window ─────────────────────────────────────────────
// IngestStats' historical "Session ended · {duration}" summary lives inside
// LiveCockpit and only renders while `isStreaming !== true` — but LiveCockpit
// unmounts the instant `isStreaming` flips false (`optimisticIsStreaming` drops
// in the same tick), so the summary never got a chance to paint. Keep LiveCockpit
// mounted for a bounded window after a REAL stop (authoritative `isStreaming`
// true→false — the SAME edge IngestStats folds its rollup on, so a failed
// `starting` revert with no live session never opens it). During the window
// LiveCockpit switches to `summaryMode`: the still-mounted IngestStats shows the
// historical summary, and its live chrome (telemetry strip / bitrate adjuster /
// stop control) is hidden so the UI is not trapped in a stale "live" mode. The
// window is bounded — a fixed timeout closes it, and the next stream start resets
// it — so it always resolves back to IdleCockpit.
const SUMMARY_WINDOW_MS = 30_000;
// Prod-inert e2e seam: shrink the summary window (mirrors `__ceraRebootCountdownSeconds`).
function resolveSummaryWindowMs(): number {
	const override =
		typeof window !== 'undefined'
			? (window as unknown as { __ceraSummaryWindowMs?: number }).__ceraSummaryWindowMs
			: undefined;
	return typeof override === 'number' && override >= 0 ? override : SUMMARY_WINDOW_MS;
}
let showingSummary = $state(false);
let summaryTimer: ReturnType<typeof setTimeout> | undefined;
let lastStreamingState = false;

// `$effect.pre` (not `$effect`): the window flag must flip BEFORE the cockpit
// gate renders. A post-render `$effect` lags one tick, so on the stop edge the
// template would render once with `showLiveCockpit` false (unmounting LiveCockpit)
// before the flag flips it back true — remounting a fresh IngestStats and wiping
// the session rollup the summary reads.
$effect.pre(() => {
	const streamingNow = isStreaming;
	if (streamingNow === lastStreamingState) return;
	lastStreamingState = streamingNow;
	clearTimeout(summaryTimer);
	if (streamingNow) {
		// A (re)start closes any lingering summary window immediately.
		showingSummary = false;
	} else {
		// A real stream just stopped: open the bounded post-stream summary window.
		showingSummary = true;
		summaryTimer = setTimeout(() => {
			showingSummary = false;
		}, resolveSummaryWindowMs());
	}
});

// Clear a pending window timer if the view unmounts mid-window.
$effect(() => () => clearTimeout(summaryTimer));

// Explicit post-stream summary close (T13 "Done"): the Done button in
// LiveCockpit's summaryMode escapes the bounded window immediately. Clear the
// flag AND the fallback timer in the SAME synchronous call so no stale timer
// fires after the click and flips the view back to summary. Idempotent — a
// second click just re-clears an already-false flag / already-cleared timer.
function closeSummary() {
	clearTimeout(summaryTimer);
	summaryTimer = undefined;
	showingSummary = false;
}

// LiveCockpit stays mounted while streaming/starting OR through the bounded
// post-stream summary window; `summaryMode` collapses it to summary-only chrome
// once the stream has actually stopped (never during the optimistic start edge).
const showLiveCockpit = $derived(optimisticIsStreaming || showingSummary);
const summaryMode = $derived(showingSummary && !optimisticIsStreaming);

const STREAM_START_ERROR_KEYS = [
	'srt_connect_failed',
	'srt_connection_lost',
	'srtla_initial_connect_failed',
	'srtla_no_connections',
	'capture_audio_error',
	'capture_video_error',
	'pipeline_stall',
	'audio_source_probe_failed',
	'audio_codec_unsupported_transport',
	'source_lost',
	'source_unavailable',
] as const;
type StreamStartErrorKey = (typeof STREAM_START_ERROR_KEYS)[number];

function startFailedMessage(code: string): string {
	return (STREAM_START_ERROR_KEYS as readonly string[]).includes(code)
		? $LL.live.startFailed[code as StreamStartErrorKey]()
		: $LL.live.startFailed.generic();
}

// Show error toast if start failed (stop reason set).
$effect(() => {
	if (streamingStopReason) {
		toast.error(startFailedMessage(streamingStopReason));
	}
});

const activeInput = $derived(getActiveInput());
let switchingInput = $state<string | undefined>(undefined);

// Reconnect-aware reconciliation (Task 15): a live `switchInput` restarts the
// pipeline, which can drop and replace the WebSocket — orphaning the in-flight
// RPC so its `finally` never clears `switchingInput`. On the reconnect edge drop
// a stuck latch so the picker reconciles to the server-reported `activeInput`.
let prevConnection = $state(getConnectionState());
$effect(() => {
	const next = getConnectionState();
	switchingInput = reconcileSwitchingInput(prevConnection, next, switchingInput);
	prevConnection = next;
});

// Sole gate for the live audio-switch affordance (G2): the engine capability
// flag, never a version string. Guards handleSwitchInput/handleSwitchAudio so a
// live audio source switch can never be dispatched when the engine can't honor it.
const audioLiveSwitchEnabled = $derived(isAudioLiveSwitchEnabled(getCapabilities()));

// One per-field sync key drives the audio-switch applying/applied/failed glyph
// (Task 5 machine), regardless of which audio source is targeted.
const AUDIO_SWITCH_FIELD = 'audio_switch';

// Live input switch (Task 34/25): dispatched from the unified source list's
// capture rows WHILE streaming (SourceSection `onSwitch`). Routes through the
// keyed async-operation machine for the in-flight phase + re-entry guard; an
// `audio:*` id is delegated to the gated switchAudio path.
async function handleSwitchInput(inputId: string) {
	// Defense-in-depth: the live-switch affordance is disabled-with-reason when
	// the capability is off. If it is somehow reached, surface a calm reason and
	// refuse — the engine would otherwise reject the live audio:* switch.
	if (!canLiveSwitchInput(inputId, audioLiveSwitchEnabled)) {
		toast.warning($LL.live.inputPicker.audioSwitchUnavailable());
		return;
	}
	if (isAudioInputId(inputId)) {
		await handleSwitchAudio(inputId);
		return;
	}
	switchingInput = inputId;
	try {
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
			if (res.audio_follow_pending) {
				toast.info($LL.live.inputPicker.audioFollowsOnRestart());
			}
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
			// Only release to the applied value when it is confirmed by the backend.
			// If res.active_audio_input is absent, treat as unconfirmed (incomplete response).
			if (res.active_audio_input !== undefined) {
				markFieldApplied(AUDIO_SWITCH_FIELD, res.active_audio_input);
				toast.info($LL.live.inputPicker.audioSwitched({ ms: res.gap_ms ?? 0 }));
			} else {
				// Success response without confirmed value: revert to prior state.
				markFieldFailed(AUDIO_SWITCH_FIELD, activeInput ?? inputId);
			}
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

// Server target: direct SRTLA address, or a selected relay server.
const serverTarget = $derived(config?.srtla_addr || config?.relay_server || '');
const hasServer = $derived(Boolean(serverTarget));

// Network readiness for the Network gate fix + the readiness card. Network = at
// least one enabled bonded interface that has an IP.
const netif = $derived(getNetif());

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
// Active managed ingest slot (T19): when the persisted selection resolves to a
// known platform slot, its label names the instance in the server summary row.
const activeSlot = $derived(
	findActiveSlot(getManagedIngestAccounts(), config?.selected_ingest_endpoint),
);

// Destination "traffic light" verdict (Task 5): green only when the LAST passing
// relay.validate fingerprint still matches the currently-resolved endpoint. Reads
// the session-only store — informational, never a Start gate, never persisted.
const destinationValidated = $derived(
	getDestinationValidated(config, relays, getManagedIngestAccounts()),
);

// Post-save validation orchestrator (Task 5). Lives HERE (not in ServerDialog) so
// the federated dialog bundle never depends on the relay.validate RPC. Fired by
// ServerDialog's optional `onSaved` after a successful save; resolves the saved
// endpoint EXACTLY the way the validate input is built, then records the verdict
// keyed by the endpoint fingerprint. Best-effort: a throw records a failed verdict
// (light stays neutral) and never disturbs save or Start.
async function validateSavedDestination() {
	const savedConfig = getConfig();
	const savedRelays = getRelays();
	const accounts = getManagedIngestAccounts();
	const endpoint = resolveValidationEndpoint(savedConfig, savedRelays, accounts);
	if (!endpoint) return;
	const fingerprint = fingerprintForValidation(savedConfig, savedRelays, accounts);
	try {
		const result = await rpc.relay.validate({
			addr: endpoint.addr,
			port: endpoint.port,
			streamid: endpoint.streamid,
			protocol: endpoint.protocol as RelayProtocol | undefined,
		});
		recordValidation(fingerprint, result.valid);
	} catch {
		recordValidation(fingerprint, false);
	}
}

// Live active-link count drives the kind-aware server summary (T11). Null while
// idle (`getLinkTelemetry()` is null) so SRTLA degrades to label-only — never a
// stale count.
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

// Source-gate fix + sole-camera "Change" (T10): retarget to the unified source
// list instead of opening EncoderDialog — a blocked/undesired source is fixed by
// PICKING one, so scroll it into view and focus its list container.
function handleOpenSource() {
	if (typeof document === 'undefined') return;
	const section = document.querySelector<HTMLElement>('[data-testid="source-section"]');
	if (!section) return;
	section.scrollIntoView({ behavior: 'smooth' });
	const list = section.querySelector<HTMLElement>('[data-testid="source-list"]') ?? section;
	list.focus();
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
// Typed audio-source model (status.audio_sources) beside the legacy asrcs — drives
// the humanized picker; falls back to `audioSources` on an older backend.
const audioSourceList = $derived(getStatus()?.audio_sources);

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

// Commit a bitrate edit — the live hot-adjust path (setBitrate, applies
// immediately with no stop). BitrateAdjuster renders ONLY in LiveCockpit (T12),
// so this only ever runs while streaming; the idle max_br ceiling is now the sole
// responsibility of EncoderDialog (setConfig), never this path. Single bitrate
// owner per mode: live → setBitrate here, idle → EncoderDialog.
async function commitBitrate(kbps: number) {
	const clamped = clampBitrate(kbps);
	bitrateDraft = clamped;
	// Lock max_br before the RPC so a stale config echo of the prior bitrate can't
	// flicker the slider back; release after settle.
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
	void commitBitrate(next);
}

// Config-row summaries — distilled from the saved config, never gray placeholders.
const encoderSummary = $derived.by(() => {
	const parts: string[] = [];
	const pipeline = encoderConfig.source ?? config?.pipeline;
	const bitrate = encoderConfig.bitrate ?? config?.max_br;
	// Name the source by the SAME display name the source list (`getSources()`)
	// shows: when `config.source` resolves to a capture source, use its REAL
	// hardware `displayName`; else fall back to the pipeline display name /
	// reconfigure-required copy. (Todo 12: no generic pipeline name for a
	// concrete capture device.)
	const activeSource = config?.source
		? getSources()?.sources.find((s) => s.id === config.source)
		: undefined;
	if (activeSource?.origin === 'capture') {
		parts.push(activeSource.displayName);
	} else if (pipeline) {
		parts.push(
			pipelineRecognized
				? getPipelineDisplayName(pipeline, getPipelines()?.pipelines, t)
				: $LL.live.reconfigureRequired(),
		);
	}
	if (bitrate) parts.push(formatBitrate(bitrate));
	if (parts.length === 0) return $LL.general.notConfigured();
	// Todo 12: transport token dropped here — the Destination/server row
	// (`serverSummary`) is the ONE idle surface that names the transport.
	return parts.join(' · ');
});
const audioSummary = $derived.by(() => {
	const parts: string[] = [];
	if (effectiveAudioCodec) parts.push(String(effectiveAudioCodec).toUpperCase());
	// Route the source label through the single resolvedAudioLabel owner: an active
	// Auto selection shows "Auto → device"; an explicit pick shows its own label.
	const entries = resolveAudioSourceList(audioSourceList, audioSources);
	const resolved = resolvedAudioLabel(
		{ ...config, asrc: effectiveAudioSource },
		getStatus(),
		entries,
		t,
	);
	if (resolved.current) {
		parts.push(resolved.current);
	} else if (effectiveAudioSource) {
		const entry = entries.find((e) => e.id === effectiveAudioSource);
		parts.push(entry ? audioSourceLabel(entry, t) : effectiveAudioSource);
	}
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

// ── "Now streaming" summary strip + live source switch (T12) ────────────────
// The active-encode summary (engine truth while streaming, else saved config)
// feeds LiveCockpit's LiveSummaryStrip. `deriveActiveSummary` prefers config.source
// via the sources list, then the legacy selected_video_input/pipeline fallbacks.
const liveSummary = $derived(
	deriveActiveSummary(
		config,
		getStatus()?.active_encode ?? null,
		getCapabilities(),
		getSources()?.sources,
	),
);
// The CURRENT audio for the strip's second line — routed through the single
// resolvedAudioLabel owner: an active Auto pick shows "Auto → device", an explicit
// pick shows its own label, and a deferred follow (T7) rides the pending pill. This
// shows what the stream is USING, never the future target as if it were live.
const summaryAudio = $derived.by(() => {
	const entries = resolveAudioSourceList(audioSourceList, audioSources);
	const resolved = resolvedAudioLabel(
		{ ...config, asrc: effectiveAudioSource },
		getStatus(),
		entries,
		t,
	);
	const activeSrc = config?.source
		? getSources()?.sources.find((s) => s.id === config.source)
		: undefined;
	const embeddedActive =
		activeSrc?.audioKind === 'embedded' && getCapabilities()?.network_embedded_audio === true;
	let current: string | undefined;
	if (resolved.current) {
		current = resolved.current;
	} else if (effectiveAudioSource) {
		const entry = entries.find((e) => e.id === effectiveAudioSource);
		current = entry ? audioSourceLabel(entry, t) : effectiveAudioSource;
	}
	return {
		current,
		pending: resolved.pending,
		embedded: resolved.embedded || embeddedActive,
	};
});

// Start: assemble the full ConfigMessage from the SAVED backend config (the
// encoder/server dialogs persist via setConfig), fold in the unpersisted audio
// override + the implicit sole-camera source (T10/T11), validate pipeline +
// server, then dispatch via SystemHelper → rpc.streaming.start. The streaming/
// idle UI is driven by getIsStreaming(), updated by the backend status push —
// never set locally here. Optimistic transient: Start button shows `starting`
// immediately on click, then reconciles to authoritative is_streaming.
async function handleStart(overrides: { source?: string } = {}) {
	if (streamingOptimismState !== 'idle') return;

	// Fold the implicit sole-camera source (T10) into the start base so the FE
	// pipeline gate passes and the backend re-resolves source → pipeline/input
	// (T3 streamingStartProcedure reads `input.source ?? getConfig().source`).
	let startBase = config;
	if (overrides.source !== undefined) {
		const entry = getSources()?.sources.find((s) => s.id === overrides.source);
		startBase = {
			...(config ?? {}),
			source: overrides.source,
			...(entry ? { pipeline: entry.pipelineId } : {}),
		} as typeof config;
	}

	const result = buildStartConfig(startBase, audioOverride, getPipelines()?.pipelines);
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
		if (startResult && !startResult.success) {
			revertStreamingOptimism(startResult.error ?? 'unknown_error');
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

// Stop-stuck banner Retry: re-run the bounded watchdog (pull→stop→pull) via the
// direct rpc path — never the window global (backend stop is idempotent).
function handleRetryStop() {
	retryStopStreaming();
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
	<LiveHeader {isStreaming} />

	<!-- Capability-tier state: calm banner when the engine is offline/starting or
	     reports a schema mismatch. Renders nothing in the normal tier. -->
	<CapabilityTierBanner caps={getCapabilities()} />

	{#if stopStuckBanner}
		<!-- Truthful bounded stop-stuck banner (T0): the stopping watchdog pulled +
		     re-dispatched but the authoritative flag still says streaming. The view
		     stays truthfully live (never fake-idle); Retry re-runs pull→stop→pull. -->
		<div
			role="alert"
			data-testid="stop-stuck-banner"
			class="flex items-center justify-between gap-3 rounded-lg border border-status-warning/40 bg-status-warning/10 px-4 py-3 text-sm text-status-warning"
		>
			<span>{$LL.live.stopStuck.message()}</span>
			<button
				type="button"
				data-testid="stop-stuck-retry"
				class="shrink-0 rounded-md border border-status-warning/50 px-3 py-1 font-medium transition-colors hover:bg-status-warning/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-warning/60"
				onclick={handleRetryStop}
			>
				{$LL.live.stopStuck.retry()}
			</button>
		</div>
	{/if}

	{#if showLiveCockpit}
		<!-- Live cockpit: telemetry strip + live bitrate hot-adjust + ingest stats
		     + Stop. Shown optimistically the moment Start is pressed so the start
		     transition never flickers back through idle, and kept mounted through
		     the bounded post-stream summary window (summaryMode) so IngestStats can
		     render the historical "Session ended" summary before reverting to idle. -->
		<LiveCockpit
			{liveSummary}
			destination={serverSummary}
			audioCurrent={summaryAudio.current}
			audioPending={summaryAudio.pending}
			audioEmbedded={summaryAudio.embedded}
			sources={getSources()}
			{config}
			activeEncode={getStatus()?.active_encode ?? null}
			{activeInput}
			{switchingInput}
			onSwitch={handleSwitchInput}
			bitrate={formatBitrate(config?.max_br)}
			{tempSensor}
			{uptimeSensor}
			{bitrateDraft}
			bitrateLabel={formatBitrate(bitrateDraft)}
			bitrateMax={BITRATE_MAX}
			bitrateMin={BITRATE_MIN}
			sliderMax={BITRATE_DEFAULT_MAX}
			sliderMin={BITRATE_DEFAULT_MIN}
			step={BITRATE_STEP}
			onStep={stepBitrate}
			onSliderChange={(v) => {
				interacting = true;
				bitrateDraft = v;
			}}
			onSliderCommit={(v) => {
				interacting = false;
				commitBitrate(v);
			}}
			telemetry={linkTelemetry}
			bitrateKbps={config?.max_br}
			{audioSourceLost}
			{isStreaming}
			optimismState={streamingOptimismState}
			{summaryMode}
			onStop={handleStop}
			onCloseSummary={closeSummary}
		/>
	{:else}
		<!-- Idle cockpit (source-first, T10): SourceSection → StreamSetupChain
		     (readiness rows + config edits + Start at its foot) → Preview + Roadmap
		     disclosures. Absorbs the old onboarding checklist, no-server empty-state,
		     ServerReadiness and StreamSettingsCard. -->
		<IdleCockpit
			{config}
			caps={getCapabilities()}
			sources={getSources()}
			{netif}
			isConnected={getIsConnected()}
			networkIngest={getStatus()?.network_ingest ?? null}
			pipelines={getPipelines()?.pipelines}
			{relays}
			managedSlots={getManagedIngestAccounts()}
			{configRows}
			{isStreaming}
			optimismState={streamingOptimismState}
			{destinationValidated}
			maxBitrate={config?.max_br}
			onStart={handleStart}
			onStop={handleStop}
			onOpenSource={handleOpenSource}
			onGoNetwork={handleManageLinks}
			onOpenServer={() => (serverDialogOpen = true)}
			onOpenEncoder={() => (encoderOpen = true)}
			{activeInput}
			{switchingInput}
			onSwitch={handleSwitchInput}
			{audioSources}
			{audioSourceList}
			audioStatus={getStatus()}
			selectedAudioSource={effectiveAudioSource}
			onSelectAudioSource={handleSelectAudioSource}
			onOpenAudioDialog={() => (audioDialogOpen = true)}
			selectedPipeline={config?.pipeline}
			capabilities={getCapabilities()}
			activeEncode={getStatus()?.active_encode ?? null}
		/>
	{/if}
</div>

<ServerDialog bind:open={serverDialogOpen} onSaved={validateSavedDestination} />

<!-- Audio configuration dialog (opened from the Audio "Edit" row). -->
<AudioDialog
	bind:open={audioDialogOpen}
	audioCodec={effectiveAudioCodec}
	audioDelay={effectiveAudioDelay}
	audioSource={effectiveAudioSource}
	effectivePipeline={effectivePipeline}
	onOpenEncoder={() => (encoderOpen = true)}
	onSave={handleAudioSave}
/>

<!-- Encoder configuration dialog (opened from the Encoder "Edit" row). -->
<EncoderDialog bind:open={encoderOpen} bind:config={encoderConfig} onSave={handleEncoderSave} />
