/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * Backend preview-proxy WebSocket handler (Task 20).
 *
 * The browser NEVER dials the cerastream engine's loopback preview socket
 * directly — it dials the CeraUI backend origin at `PREVIEW_WS_PATH`, and this
 * handler proxies frames to/from the engine's loopback socket. Single-origin:
 * the preview travels the same authenticated path as the RPC socket, so a remote
 * operator behind a reverse proxy needs no second port exposed.
 *
 * Auth is resolved AFTER the upgrade (a browser cannot observe a pre-upgrade HTTP
 * refusal): the socket carries a single-use token, and `open` consumes it, closing
 * with `PREVIEW_CLOSE_UNAUTHORIZED` when it is invalid/expired/already used.
 *
 * Frames are a transparent passthrough (text control frames + binary access units)
 * in BOTH directions. The downstream (browser) leg is backpressure-aware: when the
 * client's buffered amount exceeds a bounded high-water mark forwarding pauses and
 * upstream frames are held in a BOUNDED drop-oldest queue (`preview-frame-queue.ts`)
 * — the newest MSE init segment is pinned and the latest fragments are kept, the
 * oldest media is evicted once the queue exceeds its frame/byte cap. A permanently
 * slow consumer therefore plateaus the proxy's memory instead of tearing the
 * preview down, and the browser resumes at the freshest media (a live-edge
 * skip-on-lag, paired with the frontend's live-edge seek policy).
 *
 * WebRTC signaling / preview-error text frames (Todo 16, ADR-0006:
 * `webrtc-offer`/`webrtc-ice`/`webrtc-connected`/`webrtc-failed`/`preview-error`)
 * ride the SAME socket. They are relayed transparently like every other frame, but
 * classified into the queue's never-dropped CONTROL lane so a backpressure
 * eviction can never drop a handshake frame and break the WebRTC session — they
 * are forwarded ahead of any queued media, in arrival order.
 */

import {
	PREVIEW_CLOSE_UNAUTHORIZED,
	PREVIEW_CLOSE_UPSTREAM_DOWN,
	PREVIEW_CLOSE_UPSTREAM_UNAVAILABLE,
} from "@ceraui/rpc/schemas";
import type { ServerWebSocket } from "bun";

import { logger } from "../../helpers/logger.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { getMockPreviewPort } from "../../mocks/providers/preview.ts";
import type { PreviewSocketData, ServerSocketData } from "../../rpc/types.ts";
import { getLastCapabilities } from "../streaming/capabilities.ts";
import { BoundedDropOldestQueue } from "./preview-frame-queue.ts";
import { consumePreviewToken } from "./preview-token.ts";

type PreviewSocket = ServerWebSocket<PreviewSocketData>;
type Frame = string | ArrayBuffer;

/**
 * The minimal downstream-socket surface the pause/resume pipe needs. Bun's
 * `ServerWebSocket` satisfies it structurally; a fake satisfies it in tests so the
 * drop-oldest + teardown behaviour is drivable without a live socket.
 */
export interface PreviewDownSocket {
	send(data: Frame): number | void;
	getBufferedAmount(): number;
	close(code?: number, reason?: string): void;
}

/** Copy a Bun `message` Buffer into a standalone ArrayBuffer for passthrough. */
function toFrame(data: string | Buffer): Frame {
	if (typeof data === "string") {
		return data;
	}
	return data.buffer.slice(
		data.byteOffset,
		data.byteOffset + data.byteLength,
	) as ArrayBuffer;
}

/**
 * Downstream (browser) buffered-bytes ceiling. Forwarding pauses when the client
 * socket's `getBufferedAmount()` climbs above this, and resumes on `drain`. 1 MiB
 * absorbs several preview access units on a briefly-slow link without unbounded
 * growth.
 */
export const PREVIEW_BACKPRESSURE_HWM_BYTES = 1_048_576;

/**
 * Frame-count cap on the held (paused) queue. Above it the OLDEST media frame is
 * evicted (drop-oldest) — the queue plateaus, the socket stays open. 256 slots
 * absorb a burst of preview access units on a briefly-slow link.
 */
export const PREVIEW_MAX_PENDING_FRAMES = 256;

/** Byte cap on the held (paused) queue — the oldest media is evicted above it. */
export const PREVIEW_MAX_PENDING_BYTES = 1_048_576;

interface PreviewProxyState {
	upstream: WebSocket;
	upstreamOpen: boolean;
	paused: boolean;
	downClosed: boolean;
	queue: BoundedDropOldestQueue<Frame>;
	outbox: Frame[];
}

const states = new Map<PreviewSocket, PreviewProxyState>();

function frameByteLength(frame: Frame): number {
	return typeof frame === "string"
		? Buffer.byteLength(frame)
		: frame.byteLength;
}

// The MSE init segment the fragments depend on rides a text codec-config frame;
// pin it so an eviction never drops it (the latest fragments stay decodable).
function isInitFrame(frame: Frame): boolean {
	if (typeof frame !== "string") {
		return false;
	}
	try {
		const msg = JSON.parse(frame) as { type?: unknown };
		return msg?.type === "codec-config" || msg?.type === "config";
	} catch {
		return false;
	}
}

// Server→client WebRTC signaling / preview-error control frames (Todo 16,
// ADR-0006). They ride the same preview WS as the media, but a handshake frame
// dropped under backpressure breaks the WebRTC session — so they go in the
// queue's never-dropped control lane, forwarded ahead of any media.
const PREVIEW_CONTROL_FRAME_TYPES = new Set([
	"webrtc-offer",
	"webrtc-ice",
	"webrtc-connected",
	"webrtc-failed",
	"preview-error",
]);

export function isPreviewControlFrame(frame: Frame): boolean {
	if (typeof frame !== "string") {
		return false;
	}
	try {
		const msg = JSON.parse(frame) as { type?: unknown };
		return (
			typeof msg?.type === "string" && PREVIEW_CONTROL_FRAME_TYPES.has(msg.type)
		);
	} catch {
		return false;
	}
}

export function createPreviewQueue(): BoundedDropOldestQueue<Frame> {
	return new BoundedDropOldestQueue<Frame>({
		maxItems: PREVIEW_MAX_PENDING_FRAMES,
		maxBytes: PREVIEW_MAX_PENDING_BYTES,
		sizeOf: frameByteLength,
		isPinned: isInitFrame,
		isControl: isPreviewControlFrame,
	});
}

/** Injected collaborators so tests drive the pipe against a fake upstream. */
export interface PreviewProxyDeps {
	/** Validate + consume the presented token (single-use). */
	consumeToken: (token: string) => boolean;
	/** Resolve the engine/mock loopback preview URL, or `null` when unavailable. */
	resolveUpstreamUrl: () => string | null;
}

function defaultResolveUpstreamUrl(): string | null {
	if (shouldUseMocks()) {
		return `ws://127.0.0.1:${getMockPreviewPort()}`;
	}
	const preview = getLastCapabilities()?.preview;
	if (
		!preview ||
		preview.enabled === false ||
		preview.bound === false ||
		preview.port === undefined
	) {
		return null;
	}
	return `ws://127.0.0.1:${preview.port}`;
}

export function defaultPreviewProxyDeps(): PreviewProxyDeps {
	return {
		consumeToken: consumePreviewToken,
		resolveUpstreamUrl: defaultResolveUpstreamUrl,
	};
}

/** Initial data for a freshly upgraded `/preview` socket (token unvalidated). */
export function initPreviewSocketData(token: string): PreviewSocketData {
	return { kind: "preview", token };
}

/** Narrow a shared server socket to a preview socket by its `kind` discriminant. */
export function isPreviewSocket(
	ws: ServerWebSocket<ServerSocketData>,
): ws is PreviewSocket {
	return (ws.data as Partial<PreviewSocketData>).kind === "preview";
}

export function closeDown(
	ws: PreviewDownSocket,
	state: PreviewProxyState,
	code: number,
	reason: string,
): void {
	if (state.downClosed) {
		return;
	}
	state.downClosed = true;
	state.queue.clear();
	try {
		state.upstream.close();
	} catch {
		// upstream already closing
	}
	try {
		ws.close(code, reason);
	} catch {
		// downstream already closing
	}
}

export function forward(
	ws: PreviewDownSocket,
	state: PreviewProxyState,
	data: Frame,
): void {
	if (state.downClosed) {
		return;
	}
	if (state.paused) {
		// Held while the browser drains: bounded drop-oldest — never close on
		// overflow. The queue plateaus; the socket stays open.
		state.queue.enqueue(data);
		return;
	}
	ws.send(data);
	if (ws.getBufferedAmount() > PREVIEW_BACKPRESSURE_HWM_BYTES) {
		state.paused = true;
	}
}

export function resume(ws: PreviewDownSocket, state: PreviewProxyState): void {
	while (
		state.queue.length > 0 &&
		ws.getBufferedAmount() <= PREVIEW_BACKPRESSURE_HWM_BYTES
	) {
		const next = state.queue.dequeue();
		if (next !== undefined) {
			ws.send(next);
		}
	}
	if (
		state.queue.length === 0 &&
		ws.getBufferedAmount() <= PREVIEW_BACKPRESSURE_HWM_BYTES
	) {
		state.paused = false;
	}
}

function wireUpstream(ws: PreviewSocket, state: PreviewProxyState): void {
	const up = state.upstream;
	up.binaryType = "arraybuffer";

	up.onopen = () => {
		state.upstreamOpen = true;
		for (const frame of state.outbox) {
			try {
				up.send(frame);
			} catch {
				// upstream dropped mid-flush; the close handler surfaces it
			}
		}
		state.outbox.length = 0;
	};

	up.onmessage = (event: MessageEvent) => {
		forward(ws, state, event.data as Frame);
	};

	up.onclose = () => {
		if (state.upstreamOpen) {
			closeDown(ws, state, 1000, "upstream_closed");
		} else {
			closeDown(ws, state, PREVIEW_CLOSE_UPSTREAM_DOWN, "upstream_down");
		}
	};

	up.onerror = () => {
		if (!state.upstreamOpen) {
			closeDown(ws, state, PREVIEW_CLOSE_UPSTREAM_DOWN, "upstream_down");
		}
	};
}

/**
 * Build the Bun WebSocket handler for `/preview` sockets. All effectful
 * collaborators are injected so the pipe is testable against a fake upstream.
 */
export function createPreviewWebSocketHandler(
	deps: PreviewProxyDeps = defaultPreviewProxyDeps(),
) {
	return {
		open(ws: PreviewSocket): void {
			if (!deps.consumeToken(ws.data.token)) {
				try {
					ws.close(PREVIEW_CLOSE_UNAUTHORIZED, "unauthorized");
				} catch {
					// socket already closing
				}
				return;
			}

			const url = deps.resolveUpstreamUrl();
			if (url === null) {
				try {
					ws.close(PREVIEW_CLOSE_UPSTREAM_UNAVAILABLE, "preview_unavailable");
				} catch {
					// socket already closing
				}
				return;
			}

			let upstream: WebSocket;
			try {
				upstream = new WebSocket(url);
			} catch (error) {
				logger.debug(`preview proxy: upstream dial failed: ${error}`);
				try {
					ws.close(PREVIEW_CLOSE_UPSTREAM_DOWN, "upstream_down");
				} catch {
					// socket already closing
				}
				return;
			}

			const state: PreviewProxyState = {
				upstream,
				upstreamOpen: false,
				paused: false,
				downClosed: false,
				queue: createPreviewQueue(),
				outbox: [],
			};
			states.set(ws, state);
			wireUpstream(ws, state);
		},

		message(ws: PreviewSocket, data: string | Buffer): void {
			const state = states.get(ws);
			if (!state) {
				return;
			}
			const frame = toFrame(data);
			if (state.upstreamOpen) {
				try {
					state.upstream.send(frame);
				} catch {
					// upstream dropped; its close handler tears the pair down
				}
			} else {
				state.outbox.push(frame);
			}
		},

		drain(ws: PreviewSocket): void {
			const state = states.get(ws);
			if (state) {
				resume(ws, state);
			}
		},

		close(ws: PreviewSocket): void {
			const state = states.get(ws);
			if (!state) {
				return;
			}
			states.delete(ws);
			freePreviewProxyState(state);
		},
	};
}

/**
 * Release a torn-down pair: mark it closed, free every buffered frame/byte, and
 * close the upstream. The socket-close handler and every `closeDown` path route
 * through here so no buffer survives teardown.
 */
export function freePreviewProxyState(state: PreviewProxyState): void {
	state.downClosed = true;
	state.queue.clear();
	try {
		state.upstream.close();
	} catch {
		// upstream already closing
	}
}

/**
 * Build a proxy state around a downstream queue + `upstream`. The socket-open
 * path and tests both use it, so the pause/resume/drop-oldest/teardown behaviour
 * is drivable without a live upstream socket.
 */
export function createPreviewProxyState(
	upstream: WebSocket,
): PreviewProxyState {
	return {
		upstream,
		upstreamOpen: false,
		paused: false,
		downClosed: false,
		queue: createPreviewQueue(),
		outbox: [],
	};
}

/** Test seam: number of live proxied preview pairs (0 == fully torn down). */
export function getActivePreviewProxyCount(): number {
	return states.size;
}

export type { PreviewProxyState };
