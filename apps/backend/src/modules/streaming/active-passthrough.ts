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

/*
 * Raw active_encode event bridge (Todo 18/19).
 *
 * cerastream reports several `active_encode` fields on the `status` event that the
 * published `@ceralive/cerastream` client's `activeEncodeSchema` predates, so its
 * typed `subscribeEvents` Zod-STRIPS them before the backend's `handleEvent` ever
 * sees them (the same not-republished-binding constraint the hardware-kind provider
 * works around for `platform.hardware_kind`). The typed telemetry path therefore
 * can never surface these fields.
 *
 * This module is the RAW read side of the todo-16(F) bridge: ONE persistent
 * control-socket connection that runs `hello` → `subscribe-events` and reads each
 * `status` line as raw NDJSON. It caches:
 *
 *   - `active_encode.passthrough` (Todo 18, schema 0.5.0) → `getActivePassthrough()`,
 *     overlaid onto the status snapshot so the Live UI can show "Passthrough active".
 *   - `active_encode.frames_emitted` + `pipeline_playing` (Todo 19, schema 0.7.0) →
 *     `getActiveEncodeLiveness()`, the truthful frame-advancement signal the health
 *     rollup consumes (a monotonic counter increasing across two consecutive status
 *     heartbeats = advancing; a flat counter = a stalled encode). Idle/legacy → the
 *     cache is cleared/absent so the fields simply stay undefined.
 */

import { join } from "node:path";

import { logger as defaultLogger } from "../../helpers/logger.ts";
import { setup } from "../setup.ts";

const CERASTREAM_PROTOCOL = "cerastream-ipc/1";
const DEFAULT_IPC_DIR = "/run/cerastream";
const CONTROL_SOCKET_NAME = "control.sock";
const IPC_DIR_ENV = "CERASTREAM_IPC_DIR";

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function resolveControlSocketPath(): string {
	if (setup.cerastream_socket) return setup.cerastream_socket;
	const dir = process.env[IPC_DIR_ENV];
	return join(
		dir && dir.length > 0 ? dir : DEFAULT_IPC_DIR,
		CONTROL_SOCKET_NAME,
	);
}

/**
 * Read the authoritative `active_encode.passthrough` boolean off a raw `status`
 * event notification. Returns `undefined` for a non-status frame, a heartbeat
 * without `active_encode`, or a frame whose `passthrough` is absent — so a
 * bare/legacy heartbeat never clobbers a known value with a false negative.
 */
export function readPassthroughFromEvent(msg: unknown): boolean | undefined {
	if (typeof msg !== "object" || msg === null) return undefined;
	const params = (msg as { params?: unknown }).params;
	if (typeof params !== "object" || params === null) return undefined;
	if ((params as { type?: unknown }).type !== "status") return undefined;
	const ae = (params as { active_encode?: unknown }).active_encode;
	if (typeof ae !== "object" || ae === null) return undefined;
	const pt = (ae as { passthrough?: unknown }).passthrough;
	return typeof pt === "boolean" ? pt : undefined;
}

/**
 * Whether a raw `status` event reports the stream as no longer streaming, so the
 * bridge can clear its cached passthrough value on stop.
 */
export function readStreamingFalse(msg: unknown): boolean {
	if (typeof msg !== "object" || msg === null) return false;
	const params = (msg as { params?: unknown }).params;
	if (typeof params !== "object" || params === null) return false;
	if ((params as { type?: unknown }).type !== "status") return false;
	return (params as { streaming?: unknown }).streaming === false;
}

let cachedPassthrough: boolean | undefined;

/** The live session's authoritative passthrough state, or `undefined` when unknown. */
export function getActivePassthrough(): boolean | undefined {
	return cachedPassthrough;
}

/** Test/teardown seam: drop the cached value. */
export function resetActivePassthrough(): void {
	cachedPassthrough = undefined;
}

/** The engine's frame-liveness telemetry, folded from consecutive `status` events. */
export interface ActiveEncodeLiveness {
	/** The last-reported cumulative egress-buffer counter. */
	framesEmitted: number | undefined;
	/**
	 * Whether the counter INCREASED between the two most recent `status` events
	 * carrying it. `undefined` until two such events have been observed (the
	 * single-read window at stream start).
	 */
	framesAdvancing: boolean | undefined;
	/** Whether the pipeline was in GStreamer PLAYING on the last `status` event. */
	pipelinePlaying: boolean | undefined;
	/** Wall-clock ms of the last `status` event received (the freshness clock). */
	lastStatusAtMs: number;
}

/**
 * Read the liveness pair (`frames_emitted` / `pipeline_playing`) off a raw
 * `status` event's `active_encode`. Returns `undefined` for a non-status frame or
 * one with no `active_encode`, so a bare/legacy heartbeat never clobbers a known
 * value. Each field is independently optional (a legacy engine omits both).
 */
export function readLivenessFromEvent(
	msg: unknown,
): { framesEmitted?: number; pipelinePlaying?: boolean } | undefined {
	if (typeof msg !== "object" || msg === null) return undefined;
	const params = (msg as { params?: unknown }).params;
	if (typeof params !== "object" || params === null) return undefined;
	if ((params as { type?: unknown }).type !== "status") return undefined;
	const ae = (params as { active_encode?: unknown }).active_encode;
	if (typeof ae !== "object" || ae === null) return undefined;
	const frames = (ae as { frames_emitted?: unknown }).frames_emitted;
	const playing = (ae as { pipeline_playing?: unknown }).pipeline_playing;
	const out: { framesEmitted?: number; pipelinePlaying?: boolean } = {};
	if (typeof frames === "number" && Number.isFinite(frames) && frames >= 0) {
		out.framesEmitted = frames;
	}
	if (typeof playing === "boolean") out.pipelinePlaying = playing;
	return out;
}

/**
 * Whether the frame counter advanced between two reads. `undefined` (unknown)
 * until both a previous and current count exist — never guess advancement from a
 * single read.
 */
export function framesAdvancedBetween(
	previous: number | undefined,
	current: number | undefined,
): boolean | undefined {
	if (previous === undefined || current === undefined) return undefined;
	return current > previous;
}

let cachedLiveness: ActiveEncodeLiveness | undefined;

/**
 * The live session's frame-liveness telemetry, or `undefined` when no `status`
 * heartbeat carrying it has arrived (idle, legacy engine, or not yet connected).
 * The health rollup reads this + its own freshness clock to derive
 * `frames.advancing` truthfully.
 */
export function getActiveEncodeLiveness(): ActiveEncodeLiveness | undefined {
	return cachedLiveness;
}

/** Test/teardown seam: drop the cached liveness telemetry. */
export function resetActiveEncodeLiveness(): void {
	cachedLiveness = undefined;
}

/**
 * Fold one raw `status` event into the liveness cache: refresh the timestamp,
 * compute advancement against the prior counter, and carry forward
 * `pipeline_playing`. A non-status frame (or one without `active_encode`) is
 * ignored, so a bare heartbeat never resets the freshness clock or the counter.
 */
function ingestLiveness(msg: unknown, now: number = Date.now()): void {
	const live = readLivenessFromEvent(msg);
	if (live === undefined) return;
	const previousCount = cachedLiveness?.framesEmitted;
	cachedLiveness = {
		framesEmitted: live.framesEmitted ?? previousCount,
		framesAdvancing:
			live.framesEmitted !== undefined
				? framesAdvancedBetween(previousCount, live.framesEmitted)
				: cachedLiveness?.framesAdvancing,
		pipelinePlaying: live.pipelinePlaying ?? cachedLiveness?.pipelinePlaying,
		lastStatusAtMs: now,
	};
}

/** Test seam: fold a raw `status` frame as if the socket delivered it. */
export function ingestLivenessForTest(msg: unknown, now?: number): void {
	ingestLiveness(msg, now);
}

interface BridgeDeps {
	socketPath: string;
	connect: typeof Bun.connect;
	warn: (message: string) => void;
}

function defaultDeps(): BridgeDeps {
	return {
		socketPath: resolveControlSocketPath(),
		connect: Bun.connect,
		warn: (message) => defaultLogger.warn(message),
	};
}

let running = false;
let stopRequested = false;
let activeSocket: Awaited<ReturnType<typeof Bun.connect>> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Start the persistent raw passthrough event bridge. Idempotent — a second call
 * while running is a no-op. Never throws (boot fail-soft): a connect failure just
 * schedules a bounded-backoff retry, so an engine that is not up yet is picked up
 * once it appears. `partialDeps` is a test seam.
 */
export function startActivePassthroughBridge(
	partialDeps: Partial<BridgeDeps> = {},
): void {
	if (running) return;
	running = true;
	stopRequested = false;
	const deps = { ...defaultDeps(), ...partialDeps };
	let backoff = RECONNECT_MIN_MS;

	const scheduleReconnect = (): void => {
		if (stopRequested) return;
		reconnectTimer = setTimeout(() => void connectOnce(), backoff);
		backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
	};

	const connectOnce = async (): Promise<void> => {
		if (stopRequested) return;
		let buffer = "";
		let nextId = 1;
		const onLine = (line: string): void => {
			let msg: unknown;
			try {
				msg = JSON.parse(line);
			} catch {
				return;
			}
			if (readStreamingFalse(msg)) {
				cachedPassthrough = undefined;
				cachedLiveness = undefined;
				return;
			}
			const pt = readPassthroughFromEvent(msg);
			if (pt !== undefined) cachedPassthrough = pt;
			ingestLiveness(msg);
		};
		try {
			activeSocket = await deps.connect({
				unix: deps.socketPath,
				socket: {
					data: (_s, chunk) => {
						buffer += chunk.toString("utf8");
						let nl = buffer.indexOf("\n");
						while (nl !== -1) {
							const line = buffer.slice(0, nl);
							buffer = buffer.slice(nl + 1);
							if (line.length > 0) onLine(line);
							nl = buffer.indexOf("\n");
						}
					},
					close: () => {
						cachedPassthrough = undefined;
						cachedLiveness = undefined;
						activeSocket = undefined;
						scheduleReconnect();
					},
					error: () => {
						cachedPassthrough = undefined;
						cachedLiveness = undefined;
						activeSocket = undefined;
					},
				},
			});
		} catch {
			scheduleReconnect();
			return;
		}
		// A fresh connection resets the backoff so a later drop retries fast.
		backoff = RECONNECT_MIN_MS;
		const write = (method: string, params: unknown): void => {
			activeSocket?.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params })}\n`,
			);
			activeSocket?.flush();
		};
		write("hello", {
			protocol: CERASTREAM_PROTOCOL,
			client: "@ceraui/passthrough",
		});
		write("subscribe-events", { topics: ["status"] });
	};

	void connectOnce();
}

/** Stop the bridge and drop the cached value. Idempotent. */
export function stopActivePassthroughBridge(): void {
	stopRequested = true;
	running = false;
	if (reconnectTimer) clearTimeout(reconnectTimer);
	reconnectTimer = undefined;
	try {
		activeSocket?.end();
	} catch {
		// best-effort close; the process is tearing down.
	}
	activeSocket = undefined;
	cachedPassthrough = undefined;
	cachedLiveness = undefined;
}
