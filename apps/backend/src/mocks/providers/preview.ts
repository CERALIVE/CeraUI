/*
	CeraUI - Mock Preview WebSocket Server (DEV-ONLY)

	A Bun WebSocket server that reproduces cerastream's committed preview-ws wire
	contract (cerastream Todo 15) so the Live-view / EncoderDialog `PreviewCanvas`
	component works end-to-end in dev WITHOUT a real engine. cerastream serves the
	real preview socket as a loopback upstream (commonly port 9997). On a dev host
	that upstream is absent, so without this the backend `/preview` proxy would only
	report an unavailable upstream and the component would remain `reconnecting`.

	INERT WHEN MOCKS ARE OFF. `startMockPreviewServer()` gates FIRST on
	`shouldUseMocks()` and returns immediately — no port is bound, no listener is
	created, no timer is scheduled — so wiring it unconditionally into the boot
	sequence (behind `guardNonCritical`) has zero effect in production.

	Wire contract (WebCodecs tier), matched byte-for-byte against
	`apps/frontend/src/lib/components/preview/PreviewCanvas.svelte`:
	  1. Client sends one text frame `{ action:"start", tier:"webcodecs"|"mse" }`.
	  2. Server replies ONE `codec-config` JSON text frame FIRST:
	     `{ type:"codec-config", tier:"webcodecs", codec, description:<base64 avcC>,
	        coded_width, coded_height }`.
	  3. Server loops the bundled fixture as binary access units, KEYFRAME-FIRST,
	     each framed as a 9-byte header `[flags:u8][pts_us:i64 BE]` + the AU bytes
	     (`flags` bit 0 = keyframe).
	  4. Server interleaves `audio-level` JSON text frames at <=10 Hz:
	     `{ type:"audio-level", seq, pts_us, rms_db:[…], peak_db:[…] }`.

	MSE tier is not simulated (the bundled fixture is an H.264 elementary stream,
	not fragmented MP4) — the server always serves the WebCodecs framing, which is
	the tier every WebCodecs-capable browser selects. An MSE-only browser sees no
	preview in dev; this is a documented dev-only limitation.
*/

import type { ServerWebSocket } from "bun";
import { logger } from "../../helpers/logger.ts";
import { shouldUseMocks } from "../mock-service.ts";
import { PREVIEW_FIXTURE } from "./preview-fixture.ts";

type PreviewServer = ReturnType<typeof Bun.serve<PreviewConn>>;

/** Loopback port used by the dev mock preview upstream. The browser always dials
 *  the backend-origin `/preview` route; the backend proxy reaches this port.
 *  Overridable via `PREVIEW_PORT`. */
const DEFAULT_PREVIEW_PORT = 9997;

/** `audio-level` cadence — 200 ms = 5 Hz, comfortably within the <=10 Hz
 *  (>=100 000 µs spacing) ceiling the contract mandates. */
const AUDIO_LEVEL_INTERVAL_MS = 200;

const AU_HEADER_LEN = 9;
const FLAG_KEYFRAME = 0x01;

/** Decode the base64 fixture frames ONCE at module load (dev-only cost). */
interface DecodedFrame {
	readonly keyframe: boolean;
	readonly bytes: Uint8Array;
}
const DECODED_FRAMES: readonly DecodedFrame[] = PREVIEW_FIXTURE.frames.map(
	(frame) => ({
		keyframe: frame.keyframe,
		bytes: Uint8Array.from(Buffer.from(frame.data, "base64")),
	}),
);

/** Per-connection state carried on the socket. All timers are owned here so a
 *  disconnect (`close`) clears them — no leaked intervals. */
interface PreviewConn {
	started: boolean;
	videoTimer: ReturnType<typeof setInterval> | null;
	audioTimer: ReturnType<typeof setInterval> | null;
	frameIdx: number;
	ptsUs: number;
	audioSeq: number;
}

function initConn(): PreviewConn {
	return {
		started: false,
		videoTimer: null,
		audioTimer: null,
		frameIdx: 0,
		ptsUs: 0,
		audioSeq: 0,
	};
}

/** Frame one access unit: 9-byte header `[flags:u8][pts_us:i64 BE]` + AU bytes. */
function frameAccessUnit(frame: DecodedFrame, ptsUs: number): Uint8Array {
	const out = new Uint8Array(AU_HEADER_LEN + frame.bytes.length);
	const view = new DataView(out.buffer);
	view.setUint8(0, frame.keyframe ? FLAG_KEYFRAME : 0);
	view.setBigInt64(1, BigInt(ptsUs), false); // big-endian i64 microseconds
	out.set(frame.bytes, AU_HEADER_LEN);
	return out;
}

function sendCodecConfig(ws: ServerWebSocket<PreviewConn>): void {
	ws.send(
		JSON.stringify({
			type: "codec-config",
			tier: "webcodecs",
			codec: PREVIEW_FIXTURE.codec,
			description: PREVIEW_FIXTURE.description,
			coded_width: PREVIEW_FIXTURE.codedWidth,
			coded_height: PREVIEW_FIXTURE.codedHeight,
		}),
	);
}

function sendNextFrame(ws: ServerWebSocket<PreviewConn>): void {
	const conn = ws.data;
	const frame = DECODED_FRAMES[conn.frameIdx];
	if (!frame) return;
	ws.send(frameAccessUnit(frame, conn.ptsUs));
	conn.ptsUs += PREVIEW_FIXTURE.frameDurationUs;
	conn.frameIdx = (conn.frameIdx + 1) % DECODED_FRAMES.length;
}

function sendAudioLevel(ws: ServerWebSocket<PreviewConn>): void {
	const conn = ws.data;
	// Two-channel synthetic levels: a gentle oscillation in the [-48, -6] dBFS
	// band so the AudioLevelMeter renders active, moving bars.
	const phase = conn.audioSeq;
	const wobble = (offset: number) =>
		Math.round((-24 + 12 * Math.sin((phase + offset) / 3)) * 10) / 10;
	ws.send(
		JSON.stringify({
			type: "audio-level",
			seq: conn.audioSeq,
			pts_us: conn.ptsUs,
			rms_db: [wobble(0), wobble(1)],
			peak_db: [wobble(0) + 3, wobble(1) + 3],
		}),
	);
	conn.audioSeq += 1;
}

/** Streaming connections with live timers; drops to 0 as `close` clears them. */
let activeStreamingConns = 0;

function startStreaming(ws: ServerWebSocket<PreviewConn>): void {
	const conn = ws.data;
	if (conn.started) return; // idempotent — a repeated `start` is ignored
	conn.started = true;
	activeStreamingConns += 1;

	// codec-config MUST arrive before any binary AU (the parser gates decode on
	// it). Send it, then the first (keyframe) frame immediately so the canvas
	// paints fast, then loop the rest on the fixture cadence.
	sendCodecConfig(ws);
	sendNextFrame(ws);

	const frameIntervalMs = Math.max(
		1,
		Math.round(PREVIEW_FIXTURE.frameDurationUs / 1000),
	);
	conn.videoTimer = setInterval(() => sendNextFrame(ws), frameIntervalMs);
	conn.audioTimer = setInterval(
		() => sendAudioLevel(ws),
		AUDIO_LEVEL_INTERVAL_MS,
	);
}

function clearConnTimers(conn: PreviewConn): void {
	if (conn.videoTimer) {
		clearInterval(conn.videoTimer);
		conn.videoTimer = null;
	}
	if (conn.audioTimer) {
		clearInterval(conn.audioTimer);
		conn.audioTimer = null;
	}
}

function handleClientMessage(
	ws: ServerWebSocket<PreviewConn>,
	raw: string | Buffer,
): void {
	if (typeof raw !== "string") return; // preview clients only send text control frames
	let msg: unknown;
	try {
		msg = JSON.parse(raw);
	} catch {
		return; // ignore malformed frames — never crash the connection
	}
	if (
		typeof msg === "object" &&
		msg !== null &&
		(msg as { action?: unknown }).action === "start"
	) {
		startStreaming(ws);
		return;
	}
	// Unknown/unsupported action: ignored, no crash (contract-tested).
}

let previewServer: PreviewServer | null = null;

/**
 * Bind the dev preview WebSocket server. No-op (returns null) unless
 * `shouldUseMocks()` — so this is always safe to wire into the boot sequence.
 * `portOverride` is a test seam (bind an ephemeral port); normal mock development
 * uses `PREVIEW_PORT` or the 9997 default as the backend proxy's upstream.
 */
export function startMockPreviewServer(
	portOverride?: number,
): PreviewServer | null {
	if (!shouldUseMocks()) return null;
	if (previewServer) return previewServer;

	const port =
		portOverride ?? (Number(process.env.PREVIEW_PORT) || DEFAULT_PREVIEW_PORT);

	try {
		previewServer = Bun.serve<PreviewConn>({
			port,
			fetch(req, server) {
				if (server.upgrade(req, { data: initConn() })) {
					return undefined as unknown as Response;
				}
				return new Response("CeraUI dev preview WebSocket", { status: 426 });
			},
			websocket: {
				message(ws, message) {
					handleClientMessage(ws, message);
				},
				close(ws) {
					clearConnTimers(ws.data);
					if (ws.data.started) {
						ws.data.started = false;
						activeStreamingConns = Math.max(0, activeStreamingConns - 1);
					}
				},
			},
			error(error) {
				logger.error(`🎭 mock preview server error: ${error}`);
				return new Response("preview error", { status: 500 });
			},
		});
		logger.info(
			`🎭 Mock preview WebSocket server on ws://localhost:${previewServer.port} (dev-only)`,
		);
		return previewServer;
	} catch (error) {
		logger.warn(`🎭 mock preview server failed to bind on ${port}: ${error}`);
		previewServer = null;
		return null;
	}
}

/** Stop the dev preview server and release the port. Idempotent. */
export function stopMockPreviewServer(): void {
	if (!previewServer) return;
	previewServer.stop(true);
	previewServer = null;
}

/** Test/introspection accessor — the bound server, or null when inert. */
export function getMockPreviewServer(): PreviewServer | null {
	return previewServer;
}

/**
 * The port the mock preview upstream is reachable on. The backend `/preview`
 * proxy dials this under `shouldUseMocks()` so dev shares the prod URL/token flow.
 * Prefers the actually-bound port (handles the ephemeral test-seam port), falling
 * back to the configured `PREVIEW_PORT` / the 9997 default before the server binds.
 */
export function getMockPreviewPort(): number {
	return (
		previewServer?.port ??
		(Number(process.env.PREVIEW_PORT) || DEFAULT_PREVIEW_PORT)
	);
}

/** Test seam: count of connections still streaming (0 == all timers cleared). */
export function getActivePreviewConnCount(): number {
	return activeStreamingConns;
}
