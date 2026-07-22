<!--
  PreviewCanvas.svelte — on-demand local video preview for the cerastream engine.

  cerastream serves the preview WebSocket directly (ADR-0002 preview-ws addendum):
  the client sends `{ action:"start", tier }`, then receives a `codec-config` JSON
  message followed by binary access units (keyframe-first) and `audio-level` JSON
  events at <=10 Hz.

  Two delivery tiers, selected by browser capability:
    • WebCodecs — `VideoDecoder` decodes raw H.264 access units onto a <canvas>.
    • MSE       — fallback: fragmented-MP4 segments fed to a <video> SourceBuffer.

  The preview is OFF until the operator toggles it on, and it tears down on
  toggle-off and on unmount (navigate-away). A dropped socket reconnects with
  capped, jittered exponential backoff while the toggle stays on.
-->
<script lang="ts">
import { onDestroy, untrack } from 'svelte';

import { LL } from '@ceraui/i18n/svelte';
import {
	PREVIEW_CLOSE_UNAUTHORIZED,
	PREVIEW_CLOSE_UPSTREAM_DOWN,
	PREVIEW_CLOSE_UPSTREAM_UNAVAILABLE,
} from '@ceraui/rpc/schemas';
import { Eye, EyeOff, Loader, LoaderCircle, Play, ServerOff } from '@lucide/svelte';

import AudioLevelMeter from '$lib/components/preview/AudioLevelMeter.svelte';
import {
	cappedAttemptText,
	derivePreviewAvailability,
	engineFailureBand,
	PREVIEW_CLOSE_REASON_BACKPRESSURE,
	type PreviewAvailability,
} from '$lib/components/preview/preview-availability';
import {
	DEFAULT_LIVE_EDGE_POLICY,
	deriveLiveEdgeAction,
	type PlaybackSample,
	pushBoundedSegment,
} from '$lib/components/preview/preview-live-edge';
import {
	buildTierList,
	createTierLadder,
	currentTier,
	DEFAULT_WEBRTC_NO_FRAME_DEADLINE_MS,
	DEFAULT_WEBRTC_SIGNALING_TIMEOUT_MS,
	descend,
	evaluateWebrtcDeadline,
	type LadderFallbackTrigger,
	type WebrtcPhase,
} from '$lib/components/preview/preview-tier-ladder';
import { Button } from '$lib/components/ui/button';
import { getPreviewSocketUrl } from '$lib/env';
import { rpc } from '$lib/rpc';
import { getCapabilities, getConfig } from '$lib/rpc/subscriptions.svelte';
import { cn } from '$lib/utils';

interface Props {
	class?: string;
	/**
	 * Drop the standalone card chrome (border/padding) for hosts that already
	 * supply their own — e.g. the EncoderDialog modal (#72). Behaviour is
	 * otherwise identical; default keeps the full Live-view card.
	 */
	compact?: boolean;
	/**
	 * Whether the host considers the preview on-screen. IdleCockpit binds this to
	 * its preview `<details open>` state so collapsing the disclosure counts as
	 * "not viewed" and feeds the 30s viewer-liveness auto-stop. Defaults to `true`
	 * for hosts with no collapse (e.g. the EncoderDialog modal).
	 */
	hostActive?: boolean;
}

const {
	class: className = undefined,
	compact = false,
	hostActive = true,
}: Props = $props();

type PreviewStatus =
	| 'idle'
	| 'connecting'
	| 'reconnecting'
	| 'waiting'
	| 'live'
	| 'unsupported'
	| 'error';

const RECONNECT_BASE_MS = 500;
const RECONNECT_CAP_MS = 15000;

// How long the preview socket may stay open and silent after `start` before the
// media watchdog gives up. The engine's preview leg taps the ACTIVE program
// pipeline (ADR-0002 preview-ws addendum): while the device is idle it accepts
// the socket but emits no `codec-config`/access units, so without this deadline
// the UI hangs on "Connecting…" forever. A healthy stream sends codec-config with
// its first keyframe (key-int-max 60 → ≤2s at 30fps), so 8s never false-fires on
// a live signal while still surfacing the idle case promptly.
const PREVIEW_MEDIA_TIMEOUT_MS = 8000;

// Reconnect budget for a session that had already progressed past `connecting`
// (reached `waiting`/`live`). Once exhausted the socket is a lost cause: rather
// than spin the backoff loop forever, surface the terminal `interrupted` band.
const PREVIEW_MAX_RECONNECT_ATTEMPTS = 5;

// The client OWNS the idle-preview auto-stop: once the preview has gone unwatched
// (tab hidden, canvas scrolled off-viewport, or the host `<details>` collapsed)
// continuously for this window, it cleanly closes the socket so the single-owner
// engine tears the idle leg down. Re-viewing before the window elapses cancels it.
const VIEWER_IDLE_TIMEOUT_MS = 30000;

const hasWindow = typeof window !== 'undefined';
const supportsWebCodecs = hasWindow && typeof window.VideoDecoder === 'function';
const supportsMse = hasWindow && typeof window.MediaSource === 'function';
const supportsWebRtc =
	hasWindow && typeof window.RTCPeerConnection === 'function';

// Ordered delivery-tier ladder (ADR-0006): WebRTC is the low-latency PRIMARY
// tier, MSE the guaranteed FLOOR, with the pre-WebRTC WebCodecs decoder as an
// intermediate rung when the browser supports it. The pure FSM lives in
// `preview-tier-ladder.ts`; the component drives it and descends one rung on a
// signaling timeout, an ICE failure, or a no-frame deadline.
const baseTiers = buildTierList({
	webrtc: supportsWebRtc,
	webcodecs: supportsWebCodecs,
	mse: supportsMse,
});
let ladder = $state(createTierLadder(baseTiers));
const activeTier = $derived(currentTier(ladder));
function resetLadder(): void {
	ladder = createTierLadder(baseTiers);
}

let enabled = $state(false);
let status = $state<PreviewStatus>('idle');
let rmsDb = $state<number[]>([]);
let peakDb = $state<number[]>([]);

let canvasEl = $state<HTMLCanvasElement | null>(null);
let videoEl = $state<HTMLVideoElement | null>(null);

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
// Fires when an OPEN socket stays silent past PREVIEW_MEDIA_TIMEOUT_MS (no
// codec-config, no access unit) — the idle-engine case. Cleared the instant any
// media arrives, and on every teardown/close.
let mediaWatchdog: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = $state(0);
// Post-dial availability set by a close code (4502→engineOffline,
// 4503→previewUnavailable, second 4401→engineOffline). Overrides the pre-dial
// snapshot gate and stops the reconnect loop until the operator re-toggles.
let closeReason = $state<PreviewAvailability | null>(null);
// The unauthorized (4401) close triggers exactly ONE silent token re-mint before
// the tokenRejected band is surfaced; reset on a successful open.
let remintAttempted = false;
// True once the session progressed past `connecting` (reached waiting/live or any
// media arrived). Gates `interrupted` (a was-live drop) from a never-connected
// exhaustion. Reset per start().
let everProgressed = false;
// pausedHidden: the viewer-liveness auto-stop cleanly closed the socket after 30s
// unwatched. NOT an error band — carries a resume affordance and auto-redials on
// re-view. Kept out of `closeReason` so a stale close code never masks it.
let paused = $state(false);
// Viewer-liveness inputs (drive the 30s auto-stop). `documentHidden` tracks the tab
// visibility; `intersecting` tracks whether the preview card is on-screen (defaults
// true when IntersectionObserver is unavailable, e.g. jsdom).
let documentHidden = $state(false);
let intersecting = $state(true);
let sectionEl = $state<HTMLElement | null>(null);
let viewerIdleTimer: ReturnType<typeof setTimeout> | null = null;
// Latched true once the component is torn down (onDestroy). A reconnect timer
// that fires after unmount must not touch reactive state or dial a new socket.
let destroyed = false;
// Monotonic connection-attempt generation. Bumped on every start()/stop() (and
// therefore every source-change restart). connect() captures it BEFORE minting its
// async token; if a newer start()/stop() supersedes the attempt while the mint is
// in flight, the stale connect aborts without dialing and its socket handlers
// no-op. This is the double-dial guard: a stop();start() restart that lands while a
// mint is in flight can no longer leak a second live socket.
let connectionGeneration = 0;

let decoder: VideoDecoder | null = null;
let sawKeyframe = false;

let mediaSource: MediaSource | null = null;
let sourceBuffer: SourceBuffer | null = null;
let mediaObjectUrl: string | null = null;
const pendingSegments: ArrayBuffer[] = [];

// ── WebRTC tier (ADR-0006) ──────────────────────────────────────────────────
// The engine is the offerer (sendonly H.264); the browser answers (recvonly) and
// renders the peer-connection track onto the shared <video>. Media rides the peer
// connection, NOT the preview WS — the WS carries only the signaling frames.
let pc: RTCPeerConnection | null = null;
let webrtcPhase: WebrtcPhase = 'offer-wait';
let webrtcWatchdog: ReturnType<typeof setTimeout> | null = null;
let webrtcStartMs = 0;

function base64ToBuffer(b64: string): ArrayBuffer {
	const binary = atob(b64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out.buffer;
}

function backoffDelay(attempt: number): number {
	const capped = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** attempt);
	const jitter = 1 + (Math.random() * 0.6 - 0.3);
	return Math.round(capped * jitter);
}

function paintFrame(frame: VideoFrame): void {
	const canvas = canvasEl;
	if (!canvas) {
		frame.close();
		return;
	}
	if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
		canvas.width = frame.displayWidth;
		canvas.height = frame.displayHeight;
	}
	const ctx = canvas.getContext('2d');
	if (ctx) ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
	frame.close();
	status = 'live';
}

function configureWebCodecs(msg: {
	codec: string;
	description?: string;
	coded_width?: number;
	coded_height?: number;
}): void {
	if (!supportsWebCodecs) return;
	sawKeyframe = false;
	decoder = new VideoDecoder({
		output: (frame) => paintFrame(frame),
		error: () => {
			status = 'error';
		},
	});
	const config: VideoDecoderConfig = { codec: msg.codec };
	if (msg.description) config.description = base64ToBuffer(msg.description);
	if (msg.coded_width) config.codedWidth = msg.coded_width;
	if (msg.coded_height) config.codedHeight = msg.coded_height;
	decoder.configure(config);
	if (canvasEl && msg.coded_width && msg.coded_height) {
		canvasEl.width = msg.coded_width;
		canvasEl.height = msg.coded_height;
	}
	status = 'waiting';
}

function configureMse(msg: { mime?: string; init_segment?: string }): void {
	if (!supportsMse || !msg.mime || !videoEl) return;
	mediaSource = new MediaSource();
	mediaObjectUrl = URL.createObjectURL(mediaSource);
	videoEl.src = mediaObjectUrl;
	const mime = msg.mime;
	const init = msg.init_segment;
	mediaSource.addEventListener(
		'sourceopen',
		() => {
			if (mediaSource?.readyState !== 'open') return;
			try {
				sourceBuffer = mediaSource.addSourceBuffer(mime);
				sourceBuffer.addEventListener('updateend', flushSegments);
				if (init) sourceBuffer.appendBuffer(base64ToBuffer(init));
			} catch {
				status = 'error';
			}
		},
		{ once: true },
	);
	status = 'waiting';
}

function flushSegments(): void {
	const sb = sourceBuffer;
	if (!sb || sb.updating) return;
	const next = pendingSegments.shift();
	if (next) {
		try {
			sb.appendBuffer(next);
		} catch {
			status = 'error';
		}
	}
}

function decodeAccessUnit(buffer: ArrayBuffer): void {
	if (decoder?.state !== 'configured') return;
	// 9-byte header: [flags:u8][pts_us:i64 BE]; flags bit 0 = keyframe.
	if (buffer.byteLength <= 9) return;
	const view = new DataView(buffer);
	const flags = view.getUint8(0);
	const isKey = (flags & 0x1) === 1;
	const timestamp = Number(view.getBigInt64(1, false));
	if (!isKey && !sawKeyframe) return;
	if (isKey) sawKeyframe = true;
	const data = new Uint8Array(buffer, 9);
	decoder.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp, data }));
}

// Read the current playhead vs. buffered live edge, or `null` when the
// `<video>` has no buffered range yet.
function readBufferedSample(): PlaybackSample | null {
	const v = videoEl;
	if (!v || v.buffered.length === 0) return null;
	return {
		bufferedStart: v.buffered.start(0),
		bufferedEnd: v.buffered.end(v.buffered.length - 1),
		currentTime: v.currentTime,
	};
}

// Live-edge policy: pin the MSE playhead to live so preview never drifts behind
// the encoder. A large drift hard-seeks to the edge; a moderate drift applies a
// modest catch-up playbackRate inside the soft window; the back-buffer is trimmed
// once it grows past the window. Pure decision in `preview-live-edge.ts`.
function applyLiveEdge(): void {
	const v = videoEl;
	if (!v) return;
	const sample = readBufferedSample();
	if (!sample) return;
	const decision = deriveLiveEdgeAction(sample);
	if (decision.seekTo !== null) {
		try {
			v.currentTime = decision.seekTo;
		} catch {
			/* seek rejected mid-load */
		}
	}
	if (v.playbackRate !== decision.playbackRate) v.playbackRate = decision.playbackRate;
	const sb = sourceBuffer;
	// Trim only when nothing is queued to append (append keeps priority) and the
	// SourceBuffer is idle — `remove` would otherwise race a pending `appendBuffer`.
	if (
		decision.trimBackBufferTo !== null &&
		sb &&
		!sb.updating &&
		pendingSegments.length === 0 &&
		decision.trimBackBufferTo > sample.bufferedStart
	) {
		try {
			sb.remove(0, decision.trimBackBufferTo);
		} catch {
			/* remove rejected mid-update */
		}
	}
}

function appendMseSegment(buffer: ArrayBuffer): void {
	// Drop-oldest bound so a stalled SourceBuffer can never grow the queue without
	// bound; `applyLiveEdge` seeks over any gap the eviction opens.
	pushBoundedSegment(pendingSegments, buffer, DEFAULT_LIVE_EDGE_POLICY.maxPendingSegments);
	flushSegments();
	applyLiveEdge();
	if (videoEl && videoEl.readyState >= 2) status = 'live';
}

function handleText(raw: string): void {
	let msg: Record<string, unknown>;
	try {
		msg = JSON.parse(raw);
	} catch {
		return;
	}
	const type = msg.type;
	// WebRTC signaling (ADR-0006) rides the same WS. Route it before the generic
	// failure/codec-config handling; it is a no-op off the WebRTC rung.
	if (typeof type === 'string' && type.startsWith('webrtc-')) {
		handleWebrtcFrame(type, msg);
		return;
	}
	if (type === 'preview-error') {
		// The session-cap rejection (§4) degrades WebRTC to the MSE floor.
		if (msg.reason === 'rejected-limit' && activeTier === 'webrtc') {
			fallbackFromWebrtc('rejected-limit');
		}
		return;
	}
	// Engine typed idle-preview failure frame (cerastream Todo 10). Tolerant of both
	// `{type:'error',reason}` and `{type:'<reason>'}` — see PREVIEW_ENGINE_FAILURE_REASONS.
	const failureBand =
		engineFailureBand(typeof type === 'string' ? type : undefined) ??
		engineFailureBand(typeof msg.reason === 'string' ? msg.reason : undefined);
	if (failureBand) {
		clearMediaWatchdog();
		closeReason = failureBand;
		return;
	}
	if (type === 'codec-config' || type === 'config') {
		// On the WebRTC rung media rides the peer connection, not the WS — ignore a
		// codec-config the engine may emit and let the WebRTC watchdog fall back.
		if (activeTier === 'webrtc') return;
		// Media is flowing — the socket is no longer a silent stall.
		clearMediaWatchdog();
		everProgressed = true;
		if ((msg.tier ?? activeTier) === 'mse')
			configureMse(msg as Parameters<typeof configureMse>[0]);
		else configureWebCodecs(msg as Parameters<typeof configureWebCodecs>[0]);
		return;
	}
	if (type === 'audio-level' || type === 'levels') {
		if (Array.isArray(msg.rms_db)) rmsDb = msg.rms_db as number[];
		else if (typeof msg.rms === 'number') rmsDb = [linearToDb(msg.rms)];
		if (Array.isArray(msg.peak_db)) peakDb = msg.peak_db as number[];
		else if (typeof msg.peak === 'number') peakDb = [linearToDb(msg.peak)];
	}
}

function linearToDb(value: number): number {
	if (value <= 0) return -1e6;
	return 20 * Math.log10(value);
}

function handleMessage(event: MessageEvent): void {
	if (typeof event.data === 'string') {
		handleText(event.data);
		return;
	}
	if (event.data instanceof ArrayBuffer) {
		// On the WebRTC rung media rides the peer connection, never the WS.
		if (activeTier === 'webrtc') return;
		// A binary access unit is unambiguous media progress; stand the watchdog
		// down even if the codec-config text was missed.
		clearMediaWatchdog();
		everProgressed = true;
		if (activeTier === 'webcodecs') decodeAccessUnit(event.data);
		else appendMseSegment(event.data);
	}
}

async function connect(): Promise<void> {
	if (typeof WebSocket === 'undefined') {
		status = 'error';
		return;
	}
	// Capture the generation this attempt belongs to BEFORE the async mint. A
	// start()/stop() (e.g. a source-change restart) that lands while the mint is in
	// flight bumps the generation, so this now-stale attempt aborts instead of
	// opening a second socket (double-dial guard).
	const generation = connectionGeneration;
	// The engine idle leg needs to know WHICH device to preview. The applied
	// (broadcast-confirmed) `config.source` is CeraLive's resolved source id — for a
	// capture device it IS the engine `input_id` (list-devices id). Send it on the
	// start frame; an absent/coarse source is omitted so the engine falls back to its
	// own selection (or replies with a typed no-source-applied/source-unavailable frame).
	// Read it UNTRACKED: the source-change redial is owned by the applied-source
	// follow effect, so leaking this read into the dial effect would double-dial.
	const inputId = untrack(() => getConfig()?.source);
	// Mint a fresh single-use token over the authenticated RPC socket, then dial
	// the backend-origin `/preview` proxy. The RPC credential never rides the URL.
	let token: string;
	try {
		token = (await rpc.system.mintPreviewToken()).token;
	} catch {
		// A superseded attempt must not surface a band for a session a newer
		// start()/stop() already owns.
		if (generation !== connectionGeneration) return;
		// The mint RPC threw: the control session is unauthenticated or the backend
		// is unreachable. Surface the distinct mintFailed band instead of a silent
		// reconnect loop.
		closeReason = 'mintFailed';
		return;
	}
	// The toggle may have flipped, the component torn down, or a newer attempt
	// superseded this one while the mint was in flight — do not dial a socket the
	// operator no longer wants (or that a restart has already replaced).
	if (destroyed || !enabled || generation !== connectionGeneration) return;
	let ws: WebSocket;
	try {
		ws = new WebSocket(getPreviewSocketUrl(token));
	} catch {
		scheduleReconnect();
		return;
	}
	socket = ws;
	ws.binaryType = 'arraybuffer';
	status = reconnectAttempt > 0 ? 'reconnecting' : 'connecting';
	// Every handler is fenced by the captured generation: a socket that belongs to a
	// superseded attempt (e.g. a race where a stale ws still fires) must not mutate
	// state or drive the reconnect/close machinery.
	ws.onopen = () => {
		if (generation !== connectionGeneration) return;
		reconnectAttempt = 0;
		remintAttempted = false;
		closeReason = null;
		status = 'connecting';
		const t = activeTier;
		ws.send(
			JSON.stringify(
				inputId !== undefined
					? { action: 'start', tier: t, input_id: inputId }
					: { action: 'start', tier: t },
			),
		);
		if (t === 'webrtc') {
			// WebRTC media rides the peer connection; the WS-media watchdog does not
			// apply. The WebRTC establishment watchdog owns the fallback deadline.
			startWebrtc(ws, generation);
		} else {
			// The socket is open but no media has arrived yet. Guard against an engine
			// that accepts the socket and stays silent (the idle case) so the UI does
			// not sit on "Connecting…" indefinitely.
			armMediaWatchdog();
		}
	};
	ws.onmessage = (event) => {
		if (generation !== connectionGeneration) return;
		handleMessage(event);
	};
	ws.onerror = () => {
		if (generation !== connectionGeneration) return;
		ws.close();
	};
	ws.onclose = (event) => {
		if (generation !== connectionGeneration) return;
		handleSocketClose(event.code, event.reason);
	};
}

// Arm the media watchdog on an OPEN, `start`-sent socket. If the engine stays
// silent (idle: no program pipeline to tap), it fires and surfaces the calm
// `noVideo` band instead of an endless "Connecting…".
function armMediaWatchdog(): void {
	clearMediaWatchdog();
	mediaWatchdog = setTimeout(() => {
		mediaWatchdog = null;
		if (destroyed || !enabled) return;
		// Only the still-connecting/waiting path is a silent socket; a live feed or
		// an already-surfaced band must not be overridden.
		if (status === 'live' || closeReason !== null) return;
		closeReason = 'noVideo';
	}, PREVIEW_MEDIA_TIMEOUT_MS);
}

// Cleared the instant the engine delivers any media (codec-config or an access
// unit) and on every teardown/close — the socket is no longer silently stalled.
function clearMediaWatchdog(): void {
	if (mediaWatchdog) {
		clearTimeout(mediaWatchdog);
		mediaWatchdog = null;
	}
}

// ── WebRTC handshake (ADR-0006) ──────────────────────────────────────────────
// Host-ICE-only (no STUN, per §5): the browser gathers host + mDNS candidates and
// the engine gathers raw LAN host candidates. On any establishment failure the
// ladder descends to the MSE floor.
function startWebrtc(ws: WebSocket, generation: number): void {
	teardownWebrtc();
	webrtcPhase = 'offer-wait';
	let peer: RTCPeerConnection;
	try {
		peer = new RTCPeerConnection({ iceServers: [] });
	} catch {
		fallbackFromWebrtc('ice-failure');
		return;
	}
	pc = peer;
	peer.onicecandidate = (event) => {
		if (generation !== connectionGeneration) return;
		if (event.candidate) {
			ws.send(
				JSON.stringify({
					action: 'webrtc-ice',
					candidate: event.candidate.candidate,
					sdpMLineIndex: event.candidate.sdpMLineIndex ?? 0,
				}),
			);
		}
	};
	peer.ontrack = (event) => {
		if (generation !== connectionGeneration) return;
		const v = videoEl;
		if (!v) return;
		v.srcObject = event.streams[0] ?? new MediaStream([event.track]);
		v.onloadeddata = () => onWebrtcFrameRendered();
		// Standard muted-autoplay: the <video> is muted+playsinline, so play() is
		// permitted without a gesture; ignore a transient rejection (and a jsdom
		// environment where play() is unimplemented).
		try {
			void v.play?.()?.catch(() => {
				// transient autoplay rejection
			});
		} catch {
			// play() unsupported in this environment
		}
	};
	peer.oniceconnectionstatechange = () => {
		if (generation !== connectionGeneration || !pc) return;
		const iceState = pc.iceConnectionState;
		if (iceState === 'connected' || iceState === 'completed') {
			if (webrtcPhase !== 'playing') webrtcPhase = 'connected';
		} else if (iceState === 'failed') {
			fallbackFromWebrtc('ice-failure');
		}
	};
	armWebrtcWatchdog();
}

// The engine offers; the browser answers (recvonly). setRemoteDescription →
// createAnswer → setLocalDescription → send the answer over the WS.
async function handleWebrtcOffer(
	sdp: string,
	generation: number,
): Promise<void> {
	const peer = pc;
	if (!peer) return;
	try {
		await peer.setRemoteDescription({ type: 'offer', sdp });
		const answer = await peer.createAnswer();
		await peer.setLocalDescription(answer);
		if (generation !== connectionGeneration || !socket) return;
		if (webrtcPhase === 'offer-wait') webrtcPhase = 'answered';
		socket.send(JSON.stringify({ action: 'webrtc-answer', sdp: answer.sdp }));
	} catch {
		fallbackFromWebrtc('ice-failure');
	}
}

async function handleWebrtcIce(candidate: string, mline: number): Promise<void> {
	const peer = pc;
	// An empty candidate is the advisory end-of-candidates marker (§3) — ignore it.
	if (!peer || !candidate) return;
	try {
		await peer.addIceCandidate({ candidate, sdpMLineIndex: mline });
	} catch {
		// Candidate arrived before the remote description or after teardown.
	}
}

function onWebrtcFrameRendered(): void {
	clearWebrtcWatchdog();
	webrtcPhase = 'playing';
	everProgressed = true;
	status = 'live';
}

// Single WebRTC establishment deadline: fires at the signaling budget; if ICE is
// connected but no frame has painted it re-arms for the remaining no-frame budget.
// The trigger reason (signaling-timeout vs no-frame-deadline) is the pure decision
// `evaluateWebrtcDeadline`.
function armWebrtcWatchdog(): void {
	clearWebrtcWatchdog();
	webrtcStartMs = Date.now();
	webrtcWatchdog = setTimeout(onWebrtcDeadline, DEFAULT_WEBRTC_SIGNALING_TIMEOUT_MS);
}

function clearWebrtcWatchdog(): void {
	if (webrtcWatchdog) {
		clearTimeout(webrtcWatchdog);
		webrtcWatchdog = null;
	}
}

function onWebrtcDeadline(): void {
	webrtcWatchdog = null;
	if (destroyed || !enabled) return;
	const elapsedMs = Date.now() - webrtcStartMs;
	const trigger = evaluateWebrtcDeadline({ phase: webrtcPhase, elapsedMs });
	if (trigger) {
		fallbackFromWebrtc(trigger);
		return;
	}
	const remaining = DEFAULT_WEBRTC_NO_FRAME_DEADLINE_MS - elapsedMs;
	webrtcWatchdog = setTimeout(onWebrtcDeadline, Math.max(0, remaining));
}

// Descend the ladder one rung and restart the session at the new tier. At the
// floor (no lower rung) a WebRTC drop surfaces the terminal band instead.
function fallbackFromWebrtc(trigger: LadderFallbackTrigger): void {
	if (destroyed) return;
	const next = descend(ladder, trigger);
	teardownWebrtc();
	if (!next.fellBack) {
		closeReason = everProgressed ? 'interrupted' : 'engineOffline';
		return;
	}
	ladder = next.state;
	stop();
	start();
}

function teardownWebrtc(): void {
	clearWebrtcWatchdog();
	webrtcPhase = 'offer-wait';
	if (pc) {
		pc.onicecandidate = null;
		pc.ontrack = null;
		pc.oniceconnectionstatechange = null;
		try {
			pc.close();
		} catch {
			// already closed
		}
		pc = null;
	}
	if (videoEl) {
		try {
			videoEl.srcObject = null;
		} catch {
			// video element detached
		}
	}
}

function handleWebrtcFrame(type: string, msg: Record<string, unknown>): void {
	// Signaling is only meaningful while the ladder is on the WebRTC rung.
	if (activeTier !== 'webrtc') return;
	switch (type) {
		case 'webrtc-offer':
			if (typeof msg.sdp === 'string') {
				void handleWebrtcOffer(msg.sdp, connectionGeneration);
			}
			return;
		case 'webrtc-ice':
			if (typeof msg.candidate === 'string') {
				void handleWebrtcIce(
					msg.candidate,
					typeof msg.sdpMLineIndex === 'number' ? msg.sdpMLineIndex : 0,
				);
			}
			return;
		case 'webrtc-connected':
			if (webrtcPhase !== 'playing') webrtcPhase = 'connected';
			return;
		case 'webrtc-failed':
			fallbackFromWebrtc('webrtc-failed');
			return;
	}
}

// Map a proxy close (code + reason) to the calm availability band (or a bounded
// reconnect). 4401 re-mints ONCE (the token expired between mint and dial); a
// second 4401 surfaces the tokenRejected band. 4502 carries the reason string so
// a backpressure teardown renders its own band instead of engineOffline.
function handleSocketClose(code: number | undefined, reason?: string): void {
	clearMediaWatchdog();
	if (destroyed || !enabled) return;
	switch (code) {
		case PREVIEW_CLOSE_UPSTREAM_DOWN:
			closeReason =
				reason === PREVIEW_CLOSE_REASON_BACKPRESSURE ? 'backpressure' : 'engineOffline';
			return;
		case PREVIEW_CLOSE_UPSTREAM_UNAVAILABLE:
			closeReason = 'previewUnavailable';
			return;
		case PREVIEW_CLOSE_UNAUTHORIZED:
			if (!remintAttempted) {
				remintAttempted = true;
				resetMedia();
				status = 'connecting';
				void connect();
				return;
			}
			closeReason = 'tokenRejected';
			return;
		default:
			scheduleReconnect();
	}
}

function scheduleReconnect(): void {
	resetMedia();
	// Reconnect budget exhausted: stop spinning the backoff loop forever. A session
	// that had gone live/waiting surfaces the terminal `interrupted` band; one that
	// never connected surfaces `engineOffline` (the engine never answered).
	if (reconnectAttempt >= PREVIEW_MAX_RECONNECT_ATTEMPTS) {
		closeReason = everProgressed ? 'interrupted' : 'engineOffline';
		return;
	}
	status = 'reconnecting';
	const delay = backoffDelay(reconnectAttempt);
	reconnectAttempt += 1;
	reconnectTimer = setTimeout(() => {
		if (destroyed || !enabled) return;
		void connect();
	}, delay);
}

function resetMedia(): void {
	teardownWebrtc();
	sawKeyframe = false;
	rmsDb = [];
	peakDb = [];
	pendingSegments.length = 0;
	try {
		if (decoder && decoder.state !== 'closed') decoder.close();
	} catch {
		/* decoder already torn down */
	}
	decoder = null;
	if (sourceBuffer) sourceBuffer.removeEventListener('updateend', flushSegments);
	sourceBuffer = null;
	mediaSource = null;
	if (mediaObjectUrl) {
		URL.revokeObjectURL(mediaObjectUrl);
		mediaObjectUrl = null;
	}
	if (videoEl) videoEl.removeAttribute('src');
}

function start(): void {
	if (activeTier === undefined) {
		status = 'unsupported';
		return;
	}
	// New attempt generation — supersedes any in-flight connect (double-dial guard).
	connectionGeneration += 1;
	reconnectAttempt = 0;
	everProgressed = false;
	// Enter the connecting state immediately (before the async mint) so a rapid
	// source-change restart still observes a live-ish status and chains correctly;
	// connect() re-affirms it after the socket is created.
	status = 'connecting';
	void connect();
}

// Single owner of connection cleanup: the ONLY place that clears the reconnect
// timer and nulls the socket. Invoked from every close path (`stop`) and from
// `onDestroy`, so no cleanup logic is duplicated across call sites.
function teardown(): void {
	clearMediaWatchdog();
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	if (socket) {
		socket.onopen = null;
		socket.onmessage = null;
		socket.onerror = null;
		socket.onclose = null;
		try {
			socket.close();
		} catch {
			/* socket already closing */
		}
		socket = null;
	}
}

function stop(): void {
	// Bump the generation so any in-flight connect for this session aborts.
	connectionGeneration += 1;
	teardown();
	resetMedia();
	reconnectAttempt = 0;
	if (status !== 'unsupported') status = 'idle';
}

function toggle(): void {
	enabled = !enabled;
	// A fresh enable clears a prior close-code band (and the paused latch) so the
	// dial is re-attempted.
	if (enabled) {
		closeReason = null;
		remintAttempted = false;
		paused = false;
		// A fresh enable retries from the top of the ladder (WebRTC first).
		resetLadder();
	}
}

// Resume from the pausedHidden auto-stop: clear the latch so the availability
// effect redials. Called by the resume affordance and on re-view.
function resume(): void {
	paused = false;
	closeReason = null;
}

// Engine-aware availability: the pre-dial snapshot gate decides whether there is
// anything to dial; the client-owned `pausedHidden` latch and a post-dial close
// code (`closeReason`) override it. `pausedHidden` wins so a stale close code can
// never mask the calm resume affordance. The frontend dials only the backend
// `/preview` proxy, so dev and prod share one path. See `preview-availability.ts`.
const availability = $derived(
	paused ? 'pausedHidden' : (closeReason ?? derivePreviewAvailability(getCapabilities())),
);
const previewUnavailable = $derived(availability !== 'available');
const reconnectAttemptText = $derived(cappedAttemptText(reconnectAttempt));

$effect(() => {
	// Never dial while the engine reports the preview unavailable, or while the
	// viewer-liveness auto-stop has paused it — render the calm band instead of
	// reconnecting forever. A `pausedHidden` latch flips `previewUnavailable` true,
	// so this effect's cleanup cleanly closes the socket (single-owner teardown).
	if (!enabled || previewUnavailable) return;
	start();
	return () => stop();
});

// ── Viewer-liveness: the client OWNS the 30s idle-preview auto-stop ──────────────
// "Viewed" = the tab is visible AND the preview card is on-screen AND the host
// (IdleCockpit's `<details>`) is open. Losing any of the three starts the window.
const viewerActive = $derived(enabled && hostActive && !documentHidden && intersecting);

// Track tab visibility. A single non-reactive setup effect (runs once, browser only).
$effect(() => {
	if (!hasWindow) return;
	const sync = () => {
		documentHidden = document.visibilityState === 'hidden';
	};
	sync();
	document.addEventListener('visibilitychange', sync);
	return () => document.removeEventListener('visibilitychange', sync);
});

// Track whether the preview card is on-screen. Absent IntersectionObserver (jsdom)
// leaves `intersecting` at its permissive default so the auto-stop is driven by tab
// visibility + host-open alone.
$effect(() => {
	const el = sectionEl;
	if (!el || typeof IntersectionObserver === 'undefined') return;
	const observer = new IntersectionObserver((entries) => {
		const entry = entries[entries.length - 1];
		if (entry) intersecting = entry.isIntersecting;
	});
	observer.observe(el);
	return () => observer.disconnect();
});

// Arm the 30s window whenever an active, non-banded session goes unwatched. Re-view
// (or any teardown) clears the timer via this effect's cleanup — a <30s blip never
// tears down. On expiry the socket is closed cleanly through the `pausedHidden` latch.
$effect(() => {
	if (paused || !enabled || previewUnavailable || viewerActive) return;
	viewerIdleTimer = setTimeout(() => {
		viewerIdleTimer = null;
		if (!destroyed) paused = true;
	}, VIEWER_IDLE_TIMEOUT_MS);
	return () => {
		if (viewerIdleTimer) {
			clearTimeout(viewerIdleTimer);
			viewerIdleTimer = null;
		}
	};
});

// Auto-resume: once the operator looks again, redial without a manual click.
$effect(() => {
	if (paused && viewerActive) resume();
});

// The preview is "actively dialing/showing" in these states; an applied-source
// change while idle/unsupported/error has nothing to follow (the availability
// effect above starts a fresh dial when appropriate).
function isSessionActive(s: PreviewStatus): boolean {
	return s === 'connecting' || s === 'reconnecting' || s === 'waiting' || s === 'live';
}

// Baseline for the applied-source follow effect: only a genuine CHANGE to the
// broadcast-confirmed config.source (never the initial value) restarts the dial.
let appliedSource: string | undefined;
let appliedSourceTracked = false;

// Follow the APPLIED (broadcast-confirmed) config.source. When the operator's
// source selection is acknowledged by the backend AND the preview is actively
// running, tear the dial down and redial with a fresh token so the preview shows
// the newly applied input. `getConfig()` is the settled edge (the field-sync lock
// releases to the applied value), so no extra debounce is needed here. We deliberately
// watch ONLY the applied source — never an optimistic local edit — so the preview
// never redials on the field-sync pending phase. Disabled or idle → no-op.
$effect(() => {
	const source = getConfig()?.source;
	untrack(() => {
		if (!appliedSourceTracked) {
			appliedSourceTracked = true;
			appliedSource = source;
			return;
		}
		if (source === appliedSource) return;
		appliedSource = source;
		if (!enabled || !isSessionActive(status)) return;
		// A new source retries from the top of the ladder (WebRTC first).
		resetLadder();
		// stop()/start() each bump the connection generation, so an in-flight mint
		// for the previous source is aborted before it can open a socket.
		stop();
		start();
	});
});

// Final unmount guard: latch `destroyed` so any in-flight reconnect timer is
// inert, then route the connection cleanup through the single `teardown` owner.
onDestroy(() => {
	destroyed = true;
	teardown();
});

const unavailableBand = $derived.by(() => {
	const bands = $LL.live.preview.unavailable;
	switch (availability) {
		case 'engineStarting':
			return { title: bands.engineStarting.title(), body: bands.engineStarting.body() };
		case 'engineOffline':
			return { title: bands.engineOffline.title(), body: bands.engineOffline.body() };
		case 'noVideo':
			return { title: bands.noVideo.title(), body: bands.noVideo.body() };
		case 'tokenRejected':
			return { title: bands.tokenRejected.title(), body: bands.tokenRejected.body() };
		case 'mintFailed':
			return { title: bands.mintFailed.title(), body: bands.mintFailed.body() };
		case 'interrupted':
			return { title: bands.interrupted.title(), body: bands.interrupted.body() };
		case 'backpressure':
			return { title: bands.backpressure.title(), body: bands.backpressure.body() };
		case 'noSourceApplied':
			return { title: bands.noSourceApplied.title(), body: bands.noSourceApplied.body() };
		case 'sourceUnavailable':
			return { title: bands.sourceUnavailable.title(), body: bands.sourceUnavailable.body() };
		case 'deviceBusy':
			return { title: bands.deviceBusy.title(), body: bands.deviceBusy.body() };
		case 'pipelineFailed':
			return { title: bands.pipelineFailed.title(), body: bands.pipelineFailed.body() };
		case 'passthroughActive':
			return { title: bands.passthroughActive.title(), body: bands.passthroughActive.body() };
		case 'pausedHidden':
			return { title: bands.pausedHidden.title(), body: bands.pausedHidden.body() };
		default:
			return { title: bands.previewUnavailable.title(), body: bands.previewUnavailable.body() };
	}
});

const overlayText = $derived.by(() => {
	switch (status) {
		case 'unsupported':
			return $LL.live.preview.unsupported();
		case 'error':
			return $LL.live.preview.error();
		case 'connecting':
			return $LL.live.preview.connecting();
		case 'reconnecting':
			return $LL.live.preview.reconnecting();
		case 'waiting':
			return $LL.live.preview.waiting();
		default:
			return '';
	}
});

// Human label for the active delivery-tier badge (WebRTC / WebCodecs / MSE).
const tierLabel = $derived.by(() => {
	switch (activeTier) {
		case 'webrtc':
			return $LL.live.preview.tierWebrtc();
		case 'webcodecs':
			return $LL.live.preview.tierWebcodecs();
		case 'mse':
			return $LL.live.preview.tierMse();
		default:
			return '';
	}
});
</script>

<section
	bind:this={sectionEl}
	data-testid="preview"
	data-status={status}
	data-tier={activeTier ?? 'none'}
	data-compact={compact ? 'true' : 'false'}
	class={cn(compact ? undefined : 'bg-card rounded-xl border p-4 sm:p-5', className)}
>
	<div class="mb-3 flex items-center gap-2">
		<Eye aria-hidden="true" class="text-primary size-4 shrink-0" />
		<h2 class="text-sm font-semibold tracking-tight">{$LL.live.preview.title()}</h2>
		<Button
			class="ms-auto gap-1.5"
			data-testid="preview-toggle"
			aria-pressed={enabled}
			aria-label={$LL.live.preview.toggleAria()}
			onclick={toggle}
			size="sm"
			variant={enabled ? 'secondary' : 'default'}
		>
			{#if enabled}
				<EyeOff aria-hidden="true" class="size-3.5" />
				{$LL.live.preview.stop()}
			{:else}
				<Eye aria-hidden="true" class="size-3.5" />
				{$LL.live.preview.start()}
			{/if}
		</Button>
	</div>

	{#if enabled}
		{#if previewUnavailable}
			<!-- Calm engine-aware band (never an error toast); nothing to dial. -->
			<div
				data-testid="preview-unavailable"
				data-reason={availability}
				role="status"
				class="border-border bg-muted/40 flex items-start gap-3 rounded-lg border px-4 py-3"
			>
				{#if availability === 'engineStarting'}
					<LoaderCircle
						aria-hidden="true"
						class="text-primary mt-0.5 size-5 shrink-0 animate-spin motion-reduce:animate-none"
					/>
				{:else if availability === 'pausedHidden'}
					<Eye aria-hidden="true" class="text-muted-foreground mt-0.5 size-5 shrink-0" />
				{:else}
					<ServerOff aria-hidden="true" class="text-muted-foreground mt-0.5 size-5 shrink-0" />
				{/if}
				<div class="min-w-0 flex-1 space-y-1">
					<p class="text-sm font-semibold">{unavailableBand.title}</p>
					<p class="text-muted-foreground text-sm">{unavailableBand.body}</p>
					{#if availability === 'pausedHidden'}
						<Button
							class="mt-1 gap-1.5"
							data-testid="preview-resume"
							onclick={resume}
							size="sm"
							variant="secondary"
						>
							<Play aria-hidden="true" class="size-3.5" />
							{$LL.live.preview.resume()}
						</Button>
					{/if}
				</div>
			</div>
		{:else}
			<div class="bg-muted/40 relative aspect-video w-full overflow-hidden rounded-lg">
				{#if activeTier === 'webcodecs'}
					<canvas
						bind:this={canvasEl}
						data-testid="preview-canvas"
						aria-label={$LL.live.preview.canvasAria()}
						class="h-full w-full object-contain"
					></canvas>
				{:else if activeTier === 'mse' || activeTier === 'webrtc'}
					<!-- svelte-ignore a11y_media_has_caption -->
					<video
						bind:this={videoEl}
						data-testid="preview-video"
						class="h-full w-full object-contain"
						autoplay
						muted
						playsinline
					></video>
				{/if}

				{#if activeTier}
					<span
						data-testid="preview-tier-badge"
						data-tier={activeTier}
						aria-label={$LL.live.preview.tierBadgeAria()}
						class="bg-background/70 text-muted-foreground absolute bottom-2 left-2 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide backdrop-blur-sm"
					>
						{tierLabel}
					</span>
				{/if}

				{#if status === 'reconnecting'}
					<div
						data-testid="preview-reconnecting"
						role="status"
						class="bg-status-standby/15 text-status-standby absolute top-2 left-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium backdrop-blur-sm"
					>
						<Loader aria-hidden="true" class="size-3 animate-spin motion-reduce:animate-none" />
						{#if reconnectAttemptText}
							{$LL.live.preview.reconnectingAttempt({ attempt: reconnectAttemptText })}
						{:else}
							{$LL.live.preview.reconnecting()}
						{/if}
					</div>
				{/if}

				{#if activeTier === 'mse'}
					<span
						data-testid="preview-compat"
						class="bg-background/70 text-muted-foreground absolute top-2 right-2 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide"
					>
						{$LL.live.preview.compatBadge()}
					</span>
				{/if}

				{#if status !== 'live' && status !== 'reconnecting' && overlayText}
					<div
						class="text-muted-foreground absolute inset-0 grid place-items-center p-4 text-center text-sm"
						role="status"
					>
						{overlayText}
					</div>
				{/if}
			</div>

			<div class="mt-3">
				<AudioLevelMeter {rmsDb} {peakDb} />
			</div>
		{/if}
	{:else}
		<p data-testid="preview-off" class="text-muted-foreground text-sm">
			{$LL.live.preview.off()}
		</p>
	{/if}
</section>
