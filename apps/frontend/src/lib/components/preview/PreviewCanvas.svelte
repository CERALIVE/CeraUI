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
import { Eye, EyeOff, Loader, LoaderCircle, ServerOff } from '@lucide/svelte';

import AudioLevelMeter from '$lib/components/preview/AudioLevelMeter.svelte';
import {
	cappedAttemptText,
	derivePreviewAvailability,
	type PreviewAvailability,
} from '$lib/components/preview/preview-availability';
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
}

const { class: className = undefined, compact = false }: Props = $props();

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

const hasWindow = typeof window !== 'undefined';
const supportsWebCodecs = hasWindow && typeof window.VideoDecoder === 'function';
const supportsMse = hasWindow && typeof window.MediaSource === 'function';
const tier: 'webcodecs' | 'mse' | 'none' = supportsWebCodecs
	? 'webcodecs'
	: supportsMse
		? 'mse'
		: 'none';

let enabled = $state(false);
let status = $state<PreviewStatus>('idle');
let rmsDb = $state<number[]>([]);
let peakDb = $state<number[]>([]);

let canvasEl = $state<HTMLCanvasElement | null>(null);
let videoEl = $state<HTMLVideoElement | null>(null);

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = $state(0);
// Post-dial availability set by a close code (4502→engineOffline,
// 4503→previewUnavailable, second 4401→engineOffline). Overrides the pre-dial
// snapshot gate and stops the reconnect loop until the operator re-toggles.
let closeReason = $state<PreviewAvailability | null>(null);
// The unauthorized (4401) close triggers exactly ONE silent token re-mint before
// the offline band is surfaced; reset on a successful open.
let remintAttempted = false;
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

function appendMseSegment(buffer: ArrayBuffer): void {
	pendingSegments.push(buffer);
	flushSegments();
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
	if (type === 'codec-config' || type === 'config') {
		if ((msg.tier ?? tier) === 'mse') configureMse(msg as Parameters<typeof configureMse>[0]);
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
		if (tier === 'webcodecs') decodeAccessUnit(event.data);
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
	// Mint a fresh single-use token over the authenticated RPC socket, then dial
	// the backend-origin `/preview` proxy. The RPC credential never rides the URL.
	let token: string;
	try {
		token = (await rpc.system.mintPreviewToken()).token;
	} catch {
		// A superseded attempt must not schedule a reconnect for a session a newer
		// start()/stop() already owns.
		if (generation !== connectionGeneration) return;
		scheduleReconnect();
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
		ws.send(JSON.stringify({ action: 'start', tier }));
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
		handleSocketClose(event.code);
	};
}

// Map a proxy close code to the calm availability band (or a bounded reconnect).
// 4401 re-mints ONCE (the token expired between mint and dial); a second 4401
// surfaces the offline band rather than looping.
function handleSocketClose(code: number | undefined): void {
	if (destroyed || !enabled) return;
	switch (code) {
		case PREVIEW_CLOSE_UPSTREAM_DOWN:
			closeReason = 'engineOffline';
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
			closeReason = 'engineOffline';
			return;
		default:
			scheduleReconnect();
	}
}

function scheduleReconnect(): void {
	resetMedia();
	status = 'reconnecting';
	const delay = backoffDelay(reconnectAttempt);
	reconnectAttempt += 1;
	reconnectTimer = setTimeout(() => {
		if (destroyed || !enabled) return;
		void connect();
	}, delay);
}

function resetMedia(): void {
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
	if (tier === 'none') {
		status = 'unsupported';
		return;
	}
	// New attempt generation — supersedes any in-flight connect (double-dial guard).
	connectionGeneration += 1;
	reconnectAttempt = 0;
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
	// A fresh enable clears a prior close-code band so the dial is re-attempted.
	if (enabled) {
		closeReason = null;
		remintAttempted = false;
	}
}

// Engine-aware availability: the pre-dial snapshot gate decides whether there is
// anything to dial; a post-dial close code (`closeReason`) overrides it with the
// state the backend proxy reported (engine offline / preview unbound). The
// frontend dials only the backend `/preview` proxy, so dev and prod share one
// path — no mock-dev exception. See `preview-availability.ts`.
const availability = $derived(closeReason ?? derivePreviewAvailability(getCapabilities()));
const previewUnavailable = $derived(availability !== 'available');
const reconnectAttemptText = $derived(cappedAttemptText(reconnectAttempt));

$effect(() => {
	// Never dial while the engine reports the preview unavailable — render the
	// calm band instead of reconnecting forever.
	if (!enabled || previewUnavailable) return;
	start();
	return () => stop();
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
	switch (availability) {
		case 'engineStarting':
			return {
				title: $LL.live.preview.unavailable.engineStarting.title(),
				body: $LL.live.preview.unavailable.engineStarting.body(),
			};
		case 'engineOffline':
			return {
				title: $LL.live.preview.unavailable.engineOffline.title(),
				body: $LL.live.preview.unavailable.engineOffline.body(),
			};
		default:
			return {
				title: $LL.live.preview.unavailable.previewUnavailable.title(),
				body: $LL.live.preview.unavailable.previewUnavailable.body(),
			};
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
</script>

<section
	data-testid="preview"
	data-status={status}
	data-tier={tier}
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
				{:else}
					<ServerOff aria-hidden="true" class="text-muted-foreground mt-0.5 size-5 shrink-0" />
				{/if}
				<div class="min-w-0 flex-1 space-y-1">
					<p class="text-sm font-semibold">{unavailableBand.title}</p>
					<p class="text-muted-foreground text-sm">{unavailableBand.body}</p>
				</div>
			</div>
		{:else}
			<div class="bg-muted/40 relative aspect-video w-full overflow-hidden rounded-lg">
				{#if tier === 'webcodecs'}
					<canvas
						bind:this={canvasEl}
						data-testid="preview-canvas"
						aria-label={$LL.live.preview.canvasAria()}
						class="h-full w-full object-contain"
					></canvas>
				{:else if tier === 'mse'}
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

				{#if tier === 'mse'}
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
