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
 * client's buffered amount exceeds a bounded high-water mark, upstream frames are
 * held and forwarding pauses, resuming on `drain` — never drop-oldest.
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
import { consumePreviewToken } from "./preview-token.ts";

type PreviewSocket = ServerWebSocket<PreviewSocketData>;
type Frame = string | ArrayBuffer;

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
 * Hard cap on frames held while forwarding is paused. Exceeding it means the
 * downstream is not draining at all; the socket is torn down (a controlled close,
 * NOT drop-oldest) so the proxy never buffers without bound.
 */
export const PREVIEW_MAX_PENDING_FRAMES = 512;

interface PreviewProxyState {
	upstream: WebSocket;
	upstreamOpen: boolean;
	paused: boolean;
	downClosed: boolean;
	pending: Frame[];
	outbox: Frame[];
}

const states = new Map<PreviewSocket, PreviewProxyState>();

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

function closeDown(
	ws: PreviewSocket,
	state: PreviewProxyState,
	code: number,
	reason: string,
): void {
	if (state.downClosed) {
		return;
	}
	state.downClosed = true;
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

function forward(
	ws: PreviewSocket,
	state: PreviewProxyState,
	data: Frame,
): void {
	if (state.downClosed) {
		return;
	}
	if (state.paused) {
		state.pending.push(data);
		if (state.pending.length > PREVIEW_MAX_PENDING_FRAMES) {
			closeDown(
				ws,
				state,
				PREVIEW_CLOSE_UPSTREAM_DOWN,
				"backpressure_overflow",
			);
		}
		return;
	}
	ws.send(data);
	if (ws.getBufferedAmount() > PREVIEW_BACKPRESSURE_HWM_BYTES) {
		state.paused = true;
	}
}

function resume(ws: PreviewSocket, state: PreviewProxyState): void {
	while (
		state.pending.length > 0 &&
		ws.getBufferedAmount() <= PREVIEW_BACKPRESSURE_HWM_BYTES
	) {
		const next = state.pending.shift();
		if (next !== undefined) {
			ws.send(next);
		}
	}
	if (
		state.pending.length === 0 &&
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
				pending: [],
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
			state.downClosed = true;
			try {
				state.upstream.close();
			} catch {
				// upstream already closing
			}
		},
	};
}

/** Test seam: number of live proxied preview pairs (0 == fully torn down). */
export function getActivePreviewProxyCount(): number {
	return states.size;
}
