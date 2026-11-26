<script lang="ts">
import { m, resolveMessageKey } from '@ceraui/i18n/svelte';
import { isAudioLiveSwitchEnabled } from '@ceraui/rpc';
import {
	type AudioCodec,
	BITRATE_DEFAULT_MAX,
	BITRATE_DEFAULT_MIN,
	BITRATE_MAX,
	BITRATE_MIN,
	type ConfigMessage,
	type RelayProtocol,
	SWITCH_AUDIO_ERRORS,
	SWITCH_INPUT_ERRORS,
} from '@ceraui/rpc/schemas';
import { Cpu, Loader2, Server } from '@lucide/svelte';
import { tick, untrack } from 'svelte';
import { toast } from 'svelte-sonner';
import { LazyDialog, LazyDialogFallback, lazyDialog } from '$lib/components/dialogs';
import { platformCapsForHardware } from '$lib/components/streaming/ValidationAdapter';
import { viewLogs, viewLogsToast } from '$lib/device-logs/view-logs';
import { getPipelineDisplayName } from '$lib/helpers/PipelineHelper';
import { stopStreaming } from '$lib/helpers/SystemHelper';
import { rpc } from '$lib/rpc';
import { osCommand } from '$lib/rpc/async-operation.svelte';
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
import { getStreamActivity } from '$lib/rpc/session-epoch.svelte';
import { statusFieldIsCurrent } from '$lib/rpc/status-field-order';
import {
	getStopRetryBusy,
	getStopStuckBannerVisible,
	getStreamingAttemptGeneration,
	getStreamingOptimismState,
	getStreamingStartFailure,
	getStreamingStopReason,
	reconcileStreamingOptimism,
	retryStopStreaming,
	stopStreamingOptimism,
	supersedeStartingOptimism,
} from '$lib/rpc/streaming-optimism.svelte';
import {
	getActiveInput,
	getCapabilities,
	getConfig,
	getConfigChange,
	getConnectionState,
	getIsConnected,
	getIsStreaming,
	getLinkTelemetry,
	getManagedIngestAccounts,
	getNetif,
	getRelays,
	getSensors,
	getSources,
	getStartConfigGeneration,
	getStatus,
} from '$lib/rpc/subscriptions.svelte';
import { getEncoderLoad } from '$lib/stores/device-health-history.svelte';
import { deriveBitrateReading, deriveMeasuredBitrateKbps } from '$lib/stores/hud/derive';
import { getLinks } from '$lib/stores/hud.svelte';
import { getLinkNames } from '$lib/stores/link-names.svelte';
import { requestMutationBlockReveal } from '$lib/stores/mutation-block-reveal';
import { getStreamHealthRollup, isVideoSignalLost } from '$lib/stores/stream-health.svelte';
import { assessStart } from '$lib/streaming/assess-start';
import { isSelectedAudioLost } from '$lib/streaming/audioLost';
import type { MatchAction } from '$lib/streaming/capture-failover';
import { configChangeReport } from '$lib/streaming/configChangeCopy';
import { isConfigChangeInFlight } from '$lib/streaming/configChangePhase';
import {
	fingerprintForValidation,
	getDestinationValidated,
	recordValidation,
	resolveValidationEndpoint,
} from '$lib/streaming/destination-validation.svelte';
import { dispatchStart } from '$lib/streaming/dispatch-start';
import { buildEncoderSetConfig } from '$lib/streaming/encoderConfig';
import { encoderSaveErrorMessage } from '$lib/streaming/encoderSaveError';
import { canLiveSwitchInput, isAudioInputId } from '$lib/streaming/liveAudioSwitch';
import { expectedOutputCodec, resolveRoute, routeCopy } from '$lib/streaming/outputFormat';
import {
	buildServerSummary,
	type Destination,
	deriveDestination,
	findActiveSlot,
	kindBadgeLabelKey,
	resolveReceiverKind,
} from '$lib/streaming/receiver-experience';
import {
	AUDIO_SOURCE_NO_AUDIO,
	audioSelectionWireId,
	audioSourceLabel,
	deriveActiveSummary,
	resolveAudioSelection,
	resolveAudioSourceList,
	resolvedAudioLabel,
} from '$lib/streaming/sourceSummary';
import { pipelinesFromSources } from '$lib/streaming/sources-view-model';
import { startFailureMessage } from '$lib/streaming/start-failure-copy';
import {
	claimStartFailurePresentation,
	clearStartRetry,
	consumeStartRetry,
} from '$lib/streaming/start-failure-presentation.svelte';
import { showUnconfirmedStreamStop, startOptimismSuperseded } from '$lib/streaming/unconfirmed-stream';
import {
	lifecycleSinceLostStartReply,
	operatorStopUnresolved,
	startRecoveryUnknown,
} from '$lib/streaming/unresolved-stream-actions.svelte';
import { goLiveUpdateRefusal } from '$lib/updates/update-bands';
// The TYPES stay static — `import type` is erased at compile, so it creates no
// runtime edge and cannot pull the dialog into the entry chunk. The COMPONENTS
// load on first open. This split is a bundling change, not an API change.
import type { AudioConfigValues } from '$main/dialogs/AudioDialog.svelte';
import type { EncoderConfig } from '$main/dialogs/EncoderDialog.svelte';
import { formatBitrate } from '$main/live/bitrate-display';
import CapabilityTierBanner from '$main/live/CapabilityTierBanner.svelte';
import IdleCockpit from '$main/live/IdleCockpit.svelte';
import LiveCockpit from '$main/live/LiveCockpit.svelte';
import LiveHeader from '$main/live/LiveHeader.svelte';
import type { ConfigRow } from '$main/live/StreamSettingsCard.svelte';
import UnconfirmedStreamBand from '$main/live/UnconfirmedStreamBand.svelte';
import UpdateRefusalBand from '$main/live/UpdateRefusalBand.svelte';
import StartRefusalActions from './live/StartRefusalActions.svelte';

// Reactive state — non-deprecated subscriptions getters only.
const config = $derived(getConfig());
const netif = $derived(getNetif());
const isStreaming = $derived(getIsStreaming());
const sensors = $derived(getSensors());
// Per-link srtla ingest telemetry (RTT/NAK/weight) — already broadcast via
// status.linkTelemetry; surfaced here as a read-only panel, no new collector.
const linkTelemetry = $derived(getIsConnected() ? getLinkTelemetry(true) : undefined);
// Mid-stream audio-device-lost banner: the selected real audio device dropped
// from the available list (backend also raises a silence-failover notification).
const audioSourceLost = $derived(
	isSelectedAudioLost(config?.asrc, getStatus()?.asrcs),
);
// Mid-stream video-signal loss. The backend health rollup already names this
// exactly ({component:"frames"}), but its only surfaces were the HUD dot — whose
// reason text is `hidden` below the `sm` breakpoint — and a 5 s transition toast,
// so an operator on the Live cockpit saw nothing at all. Distinct from
// `audioSourceLost`/`activeSourceLost`: the device never left, it went quiet.
const videoSignalLost = $derived(isVideoSignalLost(getStreamHealthRollup()));

// Streaming optimism state (Task 6): reflects user intent immediately on click.
const streamingOptimismState = $derived(getStreamingOptimismState());
const streamingStopReason = $derived(getStreamingStopReason());
// Typed start failure (Todo 29): phase + class + retriable, when the revert
// carried one. Rendered class-first with retry state; the legacy string reason
// is the fallback for code-only reverts.
const streamingStartFailure = $derived(getStreamingStartFailure());
// Only a current orchestrator receipt can veto Start. A typed refusal from
// an earlier attempt is advisory; the backend still owns D8 admission.
const updateRefusal = $derived(
	goLiveUpdateRefusal(
		getIsConnected() && statusFieldIsCurrent('update_orchestrator') ? getStatus()?.update_orchestrator : undefined,
		streamingStartFailure,
	),
);
// A delay notice, not a diagnosis: the first watchdog read did not confirm idle.
const stopStuckBanner = $derived(getStopStuckBannerVisible());

// Idle vs Live cockpit gate (Task 11): the optimistic view of streaming so the
// start transition shows LiveCockpit immediately (no flicker back to idle mid-
// start), and the stop transition keeps LiveCockpit until the authoritative
// is_streaming=false arrives (isStreaming is still true while `stopping`).
const optimisticIsStreaming = $derived(
	isStreaming || streamingOptimismState === 'starting',
);

const configChangeApplying = $derived(isConfigChangeInFlight(getConfigChange()));

// Reconcile optimism to authoritative is_streaming broadcast.
$effect(() => {
	reconcileStreamingOptimism(isStreaming);
});

// The device's own lifecycle outranks a local `starting` (FIX-16-C3). A start
// whose reply a connection reset swallowed keeps `starting` (the start may have
// worked) and `is_streaming:false` never clears it, so without this the cockpit
// sat on a disabled "Starting..." for the 90 s start watchdog while the device
// said `reconciling`, with no Stop anywhere. Only a lifecycle DELIVERED over the
// current link after the loss settles a lost reply: a restored session can hold
// the pre-reset snapshot when its hydrate failed (FIX-16-FRONT3 R1). The record
// lives outside this component, which navigation replaces.
const streamLifecycle = $derived(getStatus()?.stream_lifecycle);
$effect(() => {
	if (streamingOptimismState !== 'starting') return;
	const generation = getStreamingAttemptGeneration();
	if (startRecoveryUnknown(generation)) return;
	const superseded = startOptimismSuperseded({
		optimismState: streamingOptimismState,
		isStreaming,
		lifecycle: streamLifecycle,
		lifecycleSinceLostReply: lifecycleSinceLostStartReply(generation),
	});
	if (superseded) supersedeStartingOptimism(generation);
});
// An unresolved operator Stop keeps the band, and keeps the header from saying
// "Not streaming", until the device settles it (FIX-16-FRONT3 R2).
const streamOutcomeUnknown = $derived(
	showUnconfirmedStreamStop({
		lifecycle: streamLifecycle,
		isStreaming,
		optimismState: streamingOptimismState,
		stopUnresolved: operatorStopUnresolved(),
		startRecoveryUnknown: startRecoveryUnknown(getStreamingAttemptGeneration()),
	}),
);

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
let liveRoot: HTMLDivElement | undefined = $state();

// The idle bar unmounts on a local Start or an incoming live fact.
$effect.pre(() => {
	if (!showLiveCockpit) return;
	const root = liveRoot;
	const bar = document.activeElement?.closest('[data-testid="live-bar"]');
	if (!bar || !root?.contains(bar)) return;
	void tick().then(() => {
		if (root.isConnected && showLiveCockpit && !bar.isConnected &&
			document.activeElement === document.body) {
			focusLiveHeading(root);
		}
	});
});
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
	'source_taken_over',
] as const;

function startFailedMessage(code: string): string {
	return (STREAM_START_ERROR_KEYS as readonly string[]).includes(code)
		? resolveMessageKey(`live.startFailed.${code}`)
		: m["live.startFailed.generic"]();
}

// Todo-25 typed failure → localized message (`startFailureMessage`): the class
// names WHAT failed and a suffix the retry state; the engine's raw diagnostic is
// never concatenated (operators have no console; it stays in System Logs).
// `capture_source_unavailable` is selected by its typed cause, and
// `update_in_progress` says to start again once the update finishes.

// Show error toast if start failed. Prefer the typed failure (class + retry
// state); fall back to the legacy code-string reason. A terminal revert sets
// both, so the typed branch wins and only one toast fires per failure.
// A refusal with a decided next step carries it as the toast's button (Try
// again, Restart box, Open stream setup, Open destination, Open Network) and
// keeps View logs beside it for a helper; the rest keep View logs alone.
// An engine refusal that comes back after Try again on an engine refusal
// offers Restart box instead of another Try again.
let viewMounted = true;
let retryQueued = false;
let refusedStart: { readonly id: string; readonly intent: StartIntent } | undefined;
let refusalToastId: ReturnType<typeof toast.error> | undefined;
$effect(() => () => {
	viewMounted = false;
	if (refusalToastId !== undefined) toast.dismiss(refusalToastId);
});

function startFailureToast(failure: NonNullable<typeof streamingStartFailure>) {
	const attempt = failure.attemptId;
	if (!claimStartFailurePresentation(attempt)) return;
	if (refusalToastId !== undefined) toast.dismiss(refusalToastId);
	const generation = getStreamingAttemptGeneration();
	const repeated = consumeStartRetry(generation);
	const decision = startAssessment.decision;
	const admitted = !showLiveCockpit && decision.state === 'ready';
	const blockedReason = streamOutcomeUnknown
		? m["live.unconfirmedStream.body"]()
		: decision.state === 'blocked'
			? resolveMessageKey(decision.blockers[0]?.reasonKey ?? '')
			: undefined;
	const { step, message, logKey } = startFailureMessage(
		// Network cannot list the change before the cellular service is up.
		failure.class === 'mutation_blocked' && getStatus()?.cellular_initializing === true
			? { ...failure, class: 'recovery_pending' }
			: failure,
		repeated,
		admitted,
		blockedReason,
	);
	if (step === undefined) {
		toast.error(message, viewLogsToast(logKey));
		return;
	}
	const at = Date.now();
	const activity = getStreamActivity();
	const intent = refusedStart?.id === attempt ? refusedStart.intent : undefined;
	const close = () => toast.dismiss(id);
	const recover = () => {
		if (isCurrent()) focusStartRecovery();
	};
	const isCurrent = () => viewMounted && getStreamingStartFailure()?.attemptId === attempt;
	const canActInSession = () => isCurrent() && activity === getStreamActivity() &&
		generation === getStreamingAttemptGeneration() && !showLiveCockpit;
	const id = toast.error<typeof StartRefusalActions>(message, {
		// A separate corner keeps later notices from stacking this card offscreen.
		position: 'bottom-left',
		class: 'start-refusal-toast motion-reduce:transition-none! [word-break:auto-phrase] [&:lang(ko)]:break-keep [&:lang(zh)]:break-keep',
		duration: Number.POSITIVE_INFINITY,
		description: StartRefusalActions,
		componentProps: {
			message,
			close: () => { recover(); close(); },
			primary: {
				label: m[`live.startFailure.action.${step}`](),
				activate: (onBlocked?: () => void) => {
					if (step === 'tryAgain') {
						if (!intent || retryQueued) return false;
						const readmit = () => {
							const { decision: current, soleCamera } = assessStart(readStartInputs());
							return canActInSession() && current.state === 'ready' &&
								intent.configGeneration === getStartConfigGeneration() &&
								intent.audio === audioOverride &&
								intent.destination === currentDestinationFingerprint() &&
								intent.implicitSource === soleCamera?.id
								? current.config : undefined;
						};
						if (!readmit()) { recover(); return false; }
						retryQueued = true;
						void dispatchStart(readmit, {
							onRefused: rememberRefusedStart,
							beforeSend: rememberStartIntent,
							retry: { onSent: close, onBlocked: () => { recover(); onBlocked?.(); } },
						}).finally(() => { retryQueued = false; });
						return true;
					}
					if (step === 'restartBox') {
						if (!canActInSession() || startAssessment.decision.state !== 'ready') return false;
						powerOpen = true;
					} else if (!isCurrent()) {
						return false;
					} else if (step === 'openNetwork') {
						requestMutationBlockReveal();
						void handleManageLinks();
					} else if (!handleOpenSetup()) {
						return false;
					}
					close();
					return true;
				},
			},
			logs: () => {
				viewLogs(at);
				close();
			},
		},
	});
	refusalToastId = id;
}

$effect(() => {
	if (streamingStartFailure) {
		const failure = streamingStartFailure;
		untrack(() => startFailureToast(failure));
		return;
	}
	if (streamingStopReason) {
		clearStartRetry();
		// Once per attempt and reason, like a typed failure: a later visit to Live does not repeat it.
		const attempt = untrack(getStreamingAttemptGeneration);
		if (claimStartFailurePresentation(`start:${attempt}:${streamingStopReason}`))
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
		toast.warning(m["live.inputPicker.audioSwitchUnavailable"]());
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
			classify: (r) => ({ ok: r.success, reason: r.error }),
			confirmOnResolve: true,
			failMessage: (r) =>
				r?.error === SWITCH_INPUT_ERRORS.SOURCE_LOST
					? m["live.inputPicker.sourceLost"]()
					: m["live.inputPicker.switchFailed"](),
		});
		if (!res) return; // re-entry no-op or a thrown RPC (osCommand already toasted)
		if (res.success) {
			toast.success(m["live.inputPicker.switched"]({ ms: res.gap_ms ?? 0 }));
			if (res.audio_follow_pending) {
				toast.info(m["live.inputPicker.audioFollowsOnRestart"]());
			}
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
				toast.info(m["live.inputPicker.audioSwitched"]({ ms: res.gap_ms ?? 0 }));
			} else {
				// Success response without confirmed value: revert to prior state.
				markFieldFailed(AUDIO_SWITCH_FIELD, activeInput ?? inputId);
			}
		} else {
			markFieldFailed(AUDIO_SWITCH_FIELD, activeInput ?? inputId);
			toast.error(
				res.error === SWITCH_AUDIO_ERRORS.AUDIO_DEVICE_NOT_FOUND
					? m["live.inputPicker.audioSourceLost"]()
					: m["live.inputPicker.audioSwitchFailed"](),
			);
		}
	} catch {
		markFieldFailed(AUDIO_SWITCH_FIELD, activeInput ?? inputId);
		toast.error(m["live.inputPicker.audioSwitchFailed"]());
	} finally {
		switchingInput = undefined;
	}
}

// Server target: direct SRTLA address, or a selected relay server.
const serverTarget = $derived(config?.srtla_addr || config?.relay_server || '');
const hasServer = $derived(Boolean(serverTarget));

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
	const { navigateToDestination } = await import('$lib/stores/navigation-lazy');
	navigateToDestination('network');
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

// Start-refusal "Open stream setup": bring the setup card into view and put
// focus on its first control, so the operator lands on the settings to check.
function handleOpenSetup() {
	const title = document.getElementById('live-stream-setup-title');
	if (!title) return false;
	title.focus({ preventScroll: true });
	title.scrollIntoView({ block: 'center', behavior: 'instant' });
	return true;
}

function handleOpenAudioSource() {
	const picker = document.querySelector<HTMLElement>('[data-testid="audio-source-select"]');
	if (!picker) return handleOpenSource();
	picker.scrollIntoView({ block: 'nearest' });
	picker.focus({ preventScroll: true });
}

// ── Dialog open state ──────────────────────────────────────────────────────
let powerOpen = $state(false);
let serverDialogOpen = $state(false);
let audioDialogOpen = $state(false);
let encoderOpen = $state(false);

// The three Live config dialogs are their own chunks, fetched on first open.
const ServerDialog = lazyDialog(() => import('$main/dialogs/ServerDialog.svelte'));
// Restart box from a repeated engine refusal: the same reboot sheet as Settings,
// so the operator still confirms before anything restarts.
const PowerDialog = lazyDialog(() => import('$main/dialogs/PowerDialog.svelte'));
const AudioDialog = lazyDialog(() => import('$main/dialogs/AudioDialog.svelte'));
const EncoderDialog = lazyDialog(() => import('$main/dialogs/EncoderDialog.svelte'));

// EncoderDialog binds `config` as well as `open`, and a rest-spread cannot carry
// a binding — so it mounts through the registry directly and owns its own
// request edge instead of going through LazyDialog.
$effect(() => {
	if (encoderOpen) EncoderDialog.request();
});

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

// The pipeline registry, projected from the unified sources snapshot — the
// single ingestion point for every pipeline-keyed read on this view.
const pipelines = $derived(pipelinesFromSources(getSources()));
function readStartInputs() {
	const connected = getIsConnected();
	const status = connected ? getStatus() : undefined;
	return {
		isConnected: connected,
		config: connected ? getConfig(true) : undefined,
		caps: connected ? getCapabilities(true) : undefined,
		sources: connected ? getSources(true) : undefined,
		netif: connected ? getNetif(true) : undefined,
		relays: getRelays(),
		managedSlots: connected ? getManagedIngestAccounts(true) : undefined,
		networkIngest: statusFieldIsCurrent('network_ingest') ? status?.network_ingest : undefined,
		audioOverride,
		audioSources: statusFieldIsCurrent('audio_sources') ? status?.audio_sources : undefined,
		audioIds: statusFieldIsCurrent('asrcs') ? status?.asrcs : undefined,
		updateRefused: updateRefusal?.source === 'live',
		lifecycle: connected ? getStatus(true)?.stream_lifecycle : undefined,
		optimism: streamingOptimismState,
		streaming: isStreaming,
		outcomeUnknown: streamOutcomeUnknown,
	};
}
const startAssessment = $derived(assessStart(readStartInputs()));
let idleCockpit: IdleCockpit | undefined = $state();

/** Focus the current idle Start surface without activating. */
export function focusStartOrPreflight(): boolean {
	return idleCockpit?.focusStartOrPreflight() ?? false;
}

function focusStartRecovery() {
	const root = liveRoot;
	if (!root?.isConnected) return;
	if (!streamOutcomeUnknown && !showLiveCockpit && focusStartOrPreflight()) return;
	focusLiveHeading(root);
}

function focusLiveHeading(root: HTMLElement) {
	const heading = root.querySelector<HTMLElement>('h1');
	heading?.focus({ preventScroll: true });
	heading?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
}

// Pipeline metadata for the effective source — used to capability-gate the
// resolution/framerate overrides when persisting the encoder draft.
const effectivePipelineData = $derived(
	effectivePipeline ? pipelines?.[effectivePipeline] : undefined,
);

// i18n key resolver (mirrors EncoderDialog) — passed to PipelineHelper so the
// friendly source label is translated, with safe key-passthrough on a miss.
const t = resolveMessageKey;

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
	// An untouched Save carries nothing: send no request, so no saved key is rewritten.
	if (Object.keys(input).length === 0) return;
	// `apply_now` is a directive, not a config field — locking it would leave a
	// pending field the server never echoes back.
	const fields = Object.entries(input).filter(([field]) => field !== 'apply_now');
	for (const [field, value] of fields) markPending(field, value);
	try {
		// A refusal RESOLVES with `{success:false}` — it does not throw. Reporting
		// success without reading that flag is how a device-rejected combo used to
		// toast "Saved" over a config the device never accepted.
		const result = await rpc.streaming.setConfig(input);
		// An apply-now save reports the TRANSACTION outcome, not just the save:
		// a `reverted` change is an accepted save whose stream never changed, so
		// "Saved" alone would be a lie.
		if (result.configChange !== undefined) {
			const report = configChangeReport(result.configChange, m);
			if (report.level === 'success') toast.success(report.message);
			else if (report.level === 'warning') toast.warning(report.message, viewLogsToast(report.reasonKey));
			else toast.error(report.message, viewLogsToast(report.reasonKey));
		} else if (result.success) toast.success(m["notifications.saved"]());
		else toast.error(encoderSaveErrorMessage(result.error, m));
	} catch {
		toast.error(m["notifications.saveFailed"]());
	} finally {
		for (const [field] of fields) onRpcResolved(field);
	}
}

// The saved-passthrough notice's reset: its own save of `auto`, never folded into
// the encoder save, so nothing the operator did not change is written.
async function handleResetPassthrough(): Promise<boolean> {
	markPending('video_passthrough', 'auto');
	try {
		const result = await rpc.streaming.setConfig({ video_passthrough: 'auto' });
		if (result.success) {
			toast.success(m["notifications.saved"]());
			return true;
		}
		toast.error(encoderSaveErrorMessage(result.error, m));
		return false;
	} catch {
		toast.error(m["notifications.saveFailed"]());
		return false;
	} finally {
		onRpcResolved('video_passthrough');
	}
}

// Capture failover: adopt the backup camera's mode as the stream settings. It
// rides the SAME apply-now save the encoder dialog uses, so the transaction,
// the field locks and the outcome report are one code path — the draft is
// updated the way the dialog updates it on Save, so a later open seeds from it.
function handleMatchCamera(action: MatchAction) {
	encoderConfig = {
		...encoderConfig,
		resolution: action.resolution,
		framerate: action.framerate,
	};
	void handleEncoderSave({
		resolution: action.resolution,
		framerate: action.framerate,
		bitrate: undefined,
		bitrateOverlay: undefined,
		applyNow: true,
	});
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
// Resolved typed entries + the migration-shim selection (device-quality-wave2
// Todo 22): a SAVED `config.asrc` — an old asrc-key OR a new stable_id — resolves
// to the current entry's wire id, so a pre-upgrade selection keeps resolving after
// the identity scheme change. The persisted wire value stays the asrc id.
const audioEntries = $derived(resolveAudioSourceList(audioSourceList, audioSources));
const resolvedAudioSource = $derived(
	resolveAudioSelection(effectiveAudioSource, audioEntries)?.id ?? effectiveAudioSource,
);

function handleAudioSave(values: AudioConfigValues) {
	audioOverride = values;
}

// Inline pre-start audio-source pick from the Source section. Folds into the
// working audio override (keeping codec/delay) so the Live summary + start
// config reflect it immediately, then persists via setConfig (no stream restart)
// — mirrors AudioDialog's asrc path. Live audio switching stays gated (Task 10):
// the Source section only offers this control while idle.
async function handleSelectAudioSource(selection: string) {
	// The picker value may be a stable_id (Todo 22); map it back to the wire asrc
	// id before persisting — the engine ALSA path is keyed on the asrc id, and the
	// field-lock/echo must key on the same wire value the `config` broadcast echoes.
	const asrc = audioSelectionWireId(selection, audioEntries);
	audioOverride = {
		asrc,
		acodec: effectiveAudioCodec ?? 'aac',
		delay: effectiveAudioDelay,
	};
	markPending('asrc', asrc);
	try {
		// The backend adds the pick to the saved mix against its own current state.
		const result = await rpc.streaming.setConfig({ asrc, audio_pick: true });
		// A refused mix (a saved input since unplugged) must not lose the pick;
		// Start still sends the new main input first.
		if (!result.success) await rpc.streaming.setConfig({ asrc });
	} catch {
		toast.error(m["notifications.saveFailed"]());
	} finally {
		onRpcResolved('asrc');
	}
}

// A source switch can retire (or restore) the device audio pick in its own
// `setConfig`. `effectiveAudioSource` prefers this override, so without this the
// picker would keep rendering a pick the device has already replaced.
function handleAudioSelectionApplied(asrc: string) {
	audioOverride = {
		asrc,
		acodec: effectiveAudioCodec ?? 'aac',
		delay: effectiveAudioDelay,
	};
}

// Pick the operator-relevant sensors out of the flat string map.
function findSensor(predicate: (name: string) => boolean): string | undefined {
	const entries = sensors ? Object.entries(sensors) : [];
	const hit = entries.find(([name]) => predicate(name.toLowerCase()));
	return typeof hit?.[1] === 'string' ? hit[1] : undefined;
}
const tempSensor = $derived(findSensor((n) => n.includes('temp')));
const uptimeSensor = $derived(findSensor((n) => n.includes('uptime')));

// Per-core encoder load for the cockpit's ENCODER cell. No new subscription and
// no new RPC: this store is initialised app-wide from main.ts and reads the
// existing `encoder-load` broadcast. Derived HERE so LiveCockpit stays a pure
// prop pass-through, per its own state-ownership contract.
const encoderLoad = $derived(getEncoderLoad());

// The live bitrate, split three ways — the SAME rules the HUD uses, not a second
// data path.
//
//   measuredKbps — what actually left the device, summed across srtla_send's
//                  per-link `bitrate_bps`. The only observation of the three.
//   targetKbps   — the adaptive controller's setpoint (`applied_kbps`), or the
//                  configured value when the engine reports nothing.
//   ceilingKbps  — the limit the target was judged against: the engine's own
//                  when it reports one (a config the engine has not adopted yet
//                  is not the limit it is honouring), else the persisted config.
//
// The headline prefers the measurement, because the setpoint cannot tell
// "streaming at 4.1 Mbps" from "streaming nothing" — a board session proved
// exactly that. With no telemetry the target takes the headline and the card
// says so by relabelling itself, rather than passing a setpoint off as a reading.
const liveBitrate = $derived.by(() => {
	const engineBitrate = getStatus()?.engine_bitrate;
	const configured = config?.max_br ?? null;
	const reading = deriveBitrateReading(engineBitrate, configured);
	const measuredKbps = deriveMeasuredBitrateKbps(isStreaming ? linkTelemetry : null);
	return {
		measuredKbps,
		isMeasured: measuredKbps != null,
		primaryKbps: measuredKbps ?? reading.effectiveKbps,
		targetKbps: reading.effectiveKbps,
		belowCeiling: reading.belowCeiling,
		ceilingKbps: engineBitrate?.ceiling_kbps ?? configured,
	};
});

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
		if (!res.success) toast.error(m["notifications.saveFailed"]());
	} catch {
		// RPC rejected: clear the optimistic lock and reconcile to server truth so
		// the slider is never stuck on the unconfirmed optimistic value.
		onRpcResolved('max_br');
		const authoritative = config?.max_br ?? clamped;
		onRpcAppliedReactive('max_br', authoritative);
		bitrateDraft = authoritative;
		toast.error(m["notifications.saveFailed"]());
	}
}

function stepBitrate(delta: number) {
	const next = clampBitrate(bitrateDraft + delta);
	void commitBitrate(next);
}

// Config-row summaries — distilled from the saved config, never gray placeholders.
// The bitrate ceiling the encoder row shows: the unsaved dialog draft, else the saved one.
const encoderBitrateKbps = $derived(encoderConfig.bitrate ?? config?.max_br);
const encoderSummary = $derived.by(() => {
	const parts: string[] = [];
	const pipeline = encoderConfig.source ?? config?.pipeline;
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
				? getPipelineDisplayName(pipeline, pipelines, t)
				: m["live.reconfigureRequired"](),
		);
	}
	// The bitrate is NOT a part: the encoder row says it once, after this value,
	// as its own tappable figure (`encoderBitrate`).
	if (parts.length === 0 && !encoderBitrateKbps) return m["general.notConfigured"]();
	// Todo 12: transport token dropped here — the Destination/server row
	// (`serverSummary`) is the ONE idle surface that names the transport.
	return parts.join(' · ');
});
const encoderBitrate = $derived(encoderBitrateKbps ? formatBitrate(encoderBitrateKbps) : undefined);
// The encoder row's route line: the same resolveRoute the Encoder dialog shows,
// from the saved settings and the configured source (the Output card is idle-only).
const encoderRoute = $derived.by(() => {
	const sources = getSources();
	const source = config?.source
		? sources?.sources.find((s) => s.id === config.source)
		: undefined;
	if (!source) return undefined;
	const caps = getCapabilities();
	const route = resolveRoute({
		outputCodec: expectedOutputCodec(
			config?.video_codec,
			caps,
			caps?.platform ?? platformCapsForHardware(sources?.hardware),
		),
		balancer: config?.balancer,
		passthrough: config?.video_passthrough,
		source,
	});
	const copy = routeCopy(route);
	return { outcome: route.outcome, text: t(copy.key, copy.params) };
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
			notConfigured: m["general.notConfigured"](),
			kindLabel: (k) => t(kindBadgeLabelKey(k)),
			bondedAcross: (count) => m["live.server.bondedAcross"]({ count }),
			singleLink: m["live.server.singleLink"](),
			providerLabel: (provider) =>
				provider && provider !== 'custom' ? PROVIDER_LABELS[provider] : undefined,
			feedsCloudObsInstance: (label) => m["settings.feedsCloudObsInstance"]({ label }),
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
	// A running stream says itself whether it is silent; the saved pick is the next
	// Start's. One that does not say (older device, adopted stream) is read by the pick.
	const runningOff = isStreaming ? getStatus()?.audio_off_active : undefined;
	const pickedOff = effectiveAudioSource === AUDIO_SOURCE_NO_AUDIO;
	if (runningOff ?? pickedOff)
		return { current: t('audio.sources.noAudio'), pending: resolved.pending, embedded: false };
	const activeSrc = config?.source
		? getSources()?.sources.find((s) => s.id === config.source)
		: undefined;
	const embeddedActive =
		activeSrc?.audioKind === 'embedded' && getCapabilities()?.network_embedded_audio === true;
	let current: string | undefined;
	if (resolved.current) {
		current = resolved.current;
	} else if (effectiveAudioSource && !pickedOff) {
		const entry = entries.find((e) => e.id === effectiveAudioSource);
		current = entry ? audioSourceLabel(entry, t) : effectiveAudioSource;
	}
	return {
		current,
		pending: resolved.pending,
		embedded: resolved.embedded || embeddedActive,
	};
});

type StartIntent = {
	readonly configGeneration: number;
	readonly audio: AudioConfigValues | null;
	readonly implicitSource: string | undefined;
	readonly destination: string;
};

function currentDestinationFingerprint() {
	return fingerprintForValidation(getConfig(), getRelays(), getManagedIngestAccounts());
}

let sentStart: StartIntent | undefined;
function rememberStartIntent() {
	sentStart = {
		configGeneration: getStartConfigGeneration(),
		audio: audioOverride,
		implicitSource: startAssessment.soleCamera?.id,
		destination: currentDestinationFingerprint(),
	};
}

function rememberRefusedStart(id: string) {
	if (sentStart) refusedStart = { id, intent: sentStart };
}

function handleStart() {
	if (showLiveCockpit || startAssessment.decision.state !== 'ready') return;
	toast.dismiss();
	void dispatchStart(() => {
		// This attempt owns the local Starting state, not a device Starting receipt.
		const current = assessStart({ ...readStartInputs(), optimism: 'idle' }).decision;
		return viewMounted && current.state === 'ready' ? current.config : undefined;
	}, { beforeSend: rememberStartIntent, onRefused: rememberRefusedStart });
}

function handleStop() {
	try {
		toast.dismiss();
	} catch {
		/* dismiss is best-effort */
	}

	// Claim this Stop now; the composition lane may send it later.
	const prepareDispatch = stopStreamingOptimism();

	if (typeof window !== 'undefined' && window.stopStreamingWithNotificationClear) {
		window.stopStreamingWithNotificationClear(prepareDispatch);
	} else {
		void stopStreaming(prepareDispatch);
	}
}

// Retry checks the original Stop's status before any re-dispatch.
function handleRetryStop() {
	retryStopStreaming();
}

const configRows = $derived<ConfigRow[]>([
	{
		icon: Cpu,
		label: m["settings.encoderSettings"](),
		value: encoderSummary,
		section: 'encoder',
		onEdit: () => (encoderOpen = true),
		testId: 'open-encoder-dialog',
		warn: pipelineNeedsReconfigure,
		...(encoderRoute ? { route: encoderRoute } : {}),
		...(encoderBitrate ? { bitrate: encoderBitrate } : {}),
	},
	{
		icon: Server,
		label: m["general.serverSettings"](),
		value: serverSummary,
		section: 'server',
		onEdit: () => (serverDialogOpen = true),
		testId: 'open-server-dialog',
	},
]);
</script>

<div bind:this={liveRoot} class="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6 lg:max-w-6xl" class:short-live={isStreaming}>
	<LiveHeader {isStreaming} unconfirmed={streamOutcomeUnknown} />

	<!-- Capability-tier state: calm banner when the engine is offline/starting or
	     reports a schema mismatch. Renders nothing in the normal tier. -->
	<CapabilityTierBanner caps={getCapabilities()} />

	<!-- Apply-now progress. Driven by the attempt-id-fenced `config-change` push,
	     so a phase from a superseded transaction can never strand this banner on
	     screen; every terminal phase clears it. -->
	{#if configChangeApplying}
		<div
			role="status"
			aria-live="polite"
			data-testid="config-change-applying"
			class="flex items-center gap-3 rounded-lg border border-status-info/40 bg-status-info/10 px-4 py-3 text-sm text-status-info"
		>
			<Loader2 class="size-4 shrink-0 animate-spin" />
			<span>{m["live.encoder.applyPhase.applying"]()}</span>
		</div>
	{/if}

	{#if stopStuckBanner}
		<div
			role="alert"
			data-testid="stop-stuck-banner"
			class="flex items-center justify-between gap-3 rounded-lg border border-status-warning/40 bg-status-warning/10 px-4 py-3 text-sm text-status-warning"
		>
			<span>{m["live.stopStuck.message"]()}</span>
			<button
				type="button"
				data-testid="stop-stuck-retry"
				class="shrink-0 rounded-md border border-status-warning/50 px-3 py-1 font-medium transition-colors enabled:hover:bg-status-warning/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-warning/60 disabled:opacity-50"
				disabled={getStopRetryBusy()}
				onclick={handleRetryStop}
			>
				{m["live.stopStuck.retry"]()}
			</button>
		</div>
	{/if}

	<!-- Above both cockpits on purpose: the post-stream summary window can still
	     hold LiveCockpit (with no Stop) while the device falls into an
	     unconfirmed state, and the optimistic starting cockpit shows only a
	     disabled "Starting...". -->
	<UnconfirmedStreamBand
		lifecycle={streamLifecycle}
		{isStreaming}
		optimismState={streamingOptimismState}
	/>

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
			onMatchCamera={handleMatchCamera}
			capabilities={getCapabilities()}
			bitrate={formatBitrate(liveBitrate.primaryKbps ?? undefined)}
			bitrateMeasured={liveBitrate.isMeasured}
			bitrateTarget={liveBitrate.isMeasured && liveBitrate.targetKbps != null
				? formatBitrate(liveBitrate.targetKbps)
				: undefined}
			bitrateLimit={liveBitrate.belowCeiling
				? formatBitrate(liveBitrate.ceilingKbps ?? undefined)
				: undefined}
			{tempSensor}
			{uptimeSensor}
			{encoderLoad}
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
			onSliderCancel={() => {
				if (interacting) interacting = false;
			}}
			telemetry={linkTelemetry}
			telemetryConnected={getIsConnected()}
			telemetryWaiting={getStatus()?.link_telemetry_waiting === true}
			bitrateKbps={liveBitrate.primaryKbps ?? undefined}
			linkNames={getLinkNames()}
			hudLinks={linkTelemetry?.links.length ? getLinks() : undefined}
			measuredBitrateKbps={liveBitrate.measuredKbps ?? undefined}
			{audioSourceLost}
			{videoSignalLost}
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
		{#if updateRefusal}
			<UpdateRefusalBand refusal={updateRefusal} />
		{/if}
		<IdleCockpit
			bind:this={idleCockpit}
			{config}
			sources={getSources()}
			{netif}
			assessment={startAssessment}
			{pipelines}
			{configRows}
			{isStreaming}
			{destinationValidated}
			onStart={handleStart}
			onOpenSource={handleOpenSource}
			onGoNetwork={handleManageLinks}
			{activeInput}
			{switchingInput}
			onSwitch={handleSwitchInput}
			{audioSources}
			{audioSourceList}
			audioStatus={getStatus()}
			selectedAudioSource={resolvedAudioSource}
			onSelectAudioSource={handleSelectAudioSource}
			onAudioSelectionApplied={handleAudioSelectionApplied}
			onOpenAudioDialog={() => (audioDialogOpen = true)}
			onOpenAudioSource={handleOpenAudioSource}
			selectedPipeline={config?.pipeline}
			capabilities={getCapabilities()}
			activeEncode={getStatus()?.active_encode ?? null}
			startFailureCaptureCause={streamingStartFailure?.captureCause}
		/>
	{/if}
</div>

<style>
	@media (orientation: landscape) and (max-height: 420px) and (width < 1024px) {
		.short-live { padding-block: 0.5rem; }
		.short-live > :global(:not(:last-child)) { margin-block-end: 0.5rem; }
	}
</style>

<LazyDialog dialog={ServerDialog} bind:open={serverDialogOpen} onSaved={validateSavedDestination} />

<LazyDialog dialog={PowerDialog} bind:open={powerOpen} />

<!-- Audio configuration dialog (opened from the Audio "Edit" row). -->
<LazyDialog
	dialog={AudioDialog}
	bind:open={audioDialogOpen}
	audioCodec={effectiveAudioCodec}
	audioDelay={effectiveAudioDelay}
	audioSource={effectiveAudioSource}
	effectivePipeline={effectivePipeline}
	onOpenEncoder={() => (encoderOpen = true)}
	onSave={handleAudioSave}
/>

<!-- Encoder configuration dialog (opened from the Encoder "Edit" row). -->
{#if EncoderDialog.current}
	{const Encoder = $derived(EncoderDialog.current)}
	<Encoder
		activeEncode={getStatus()?.active_encode ?? null}
		bind:open={encoderOpen}
		bind:config={encoderConfig}
		onResetPassthrough={handleResetPassthrough}
		onSave={handleEncoderSave}
	/>
{:else if EncoderDialog.pending}
	<LazyDialogFallback
		bind:open={encoderOpen}
		failed={EncoderDialog.failed}
		onRetry={EncoderDialog.retry}
	/>
{/if}
