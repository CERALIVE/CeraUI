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
import { LL } from '@ceraui/i18n/svelte';
import type { StreamingEngineKind } from '@ceraui/rpc/schemas';
import { Eye, EyeOff, Loader } from '@lucide/svelte';

import AudioLevelMeter from '$lib/components/preview/AudioLevelMeter.svelte';
import { Button } from '$lib/components/ui/button';
import { getPreviewSocketUrl } from '$lib/env';
import { cn } from '$lib/utils';

interface Props {
	engine?: StreamingEngineKind;
	class?: string;
}

const { engine = 'cerastream', class: className = undefined }: Props = $props();

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
let reconnectAttempt = 0;

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
			if (!mediaSource || mediaSource.readyState !== 'open') return;
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
	if (!decoder || decoder.state !== 'configured') return;
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

function connect(): void {
	if (typeof WebSocket === 'undefined') {
		status = 'error';
		return;
	}
	try {
		socket = new WebSocket(getPreviewSocketUrl());
	} catch {
		scheduleReconnect();
		return;
	}
	socket.binaryType = 'arraybuffer';
	status = reconnectAttempt > 0 ? 'reconnecting' : 'connecting';
	socket.onopen = () => {
		reconnectAttempt = 0;
		status = 'connecting';
		socket?.send(JSON.stringify({ action: 'start', tier }));
	};
	socket.onmessage = handleMessage;
	socket.onerror = () => {
		socket?.close();
	};
	socket.onclose = () => {
		if (enabled) scheduleReconnect();
	};
}

function scheduleReconnect(): void {
	resetMedia();
	status = 'reconnecting';
	const delay = backoffDelay(reconnectAttempt);
	reconnectAttempt += 1;
	reconnectTimer = setTimeout(() => {
		if (enabled) connect();
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
	reconnectAttempt = 0;
	connect();
}

function stop(): void {
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
	resetMedia();
	reconnectAttempt = 0;
	if (status !== 'unsupported') status = 'idle';
}

function toggle(): void {
	enabled = !enabled;
}

$effect(() => {
	if (!enabled) return;
	start();
	return () => stop();
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

{#if engine === 'cerastream'}
	<section
		data-testid="preview"
		data-status={status}
		data-tier={tier}
		class={cn('bg-card rounded-xl border p-4 sm:p-5', className)}
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
						<Loader aria-hidden="true" class="size-3 animate-spin" />
						{$LL.live.preview.reconnecting()}
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
		{:else}
			<p class="text-muted-foreground text-sm">{$LL.live.preview.noSignal()}</p>
		{/if}
	</section>
{/if}
