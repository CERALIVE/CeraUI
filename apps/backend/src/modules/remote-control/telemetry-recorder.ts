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
 * Remote Control Plane v2.0 — device-side telemetry recorder
 * (remote-relay-support spec §8.1 `telemetry` status frames).
 *
 * Records per-SRTLA-link telemetry samples and emits them to the hub as BATCHED
 * `telemetry` status frames over the control channel, for durable platform
 * persistence (Todo 26). It is the second, historical telemetry surface — distinct
 * from `status.linkTelemetry`, which is the live on-change UI snapshot.
 *
 * Two hard constraints (spec §8.1):
 *   - NON-BLOCKING: every tick is synchronous, allocation-light, and wrapped so it
 *     can never throw into the streaming/heartbeat loop that drives it.
 *   - BATCHED: samples accumulate until a size OR an age boundary, then flush as a
 *     single frame, so the live loop is never stalled by per-sample I/O.
 *
 * It carries NO secret and NO bitrate (bitrate is the platform's ingest metric).
 * It is emitted directly over the control channel (relayStatusToGateway), NOT via
 * `broadcastMsg` — `telemetry` is deliberately absent from `RELAYABLE_TYPES`.
 */

import {
	buildLinkTelemetry,
	type LinkTelemetryMessage,
} from "../streaming/link-telemetry.ts";
import { nextRelaySeq, relayStatusToGateway } from "./status-relay.ts";

/** The wire status type for batched telemetry samples (spec §8.1). */
export const TELEMETRY_STATUS_TYPE = "telemetry";

/** Flush when this many buffered samples accumulate. */
export const DEFAULT_TELEMETRY_MAX_BATCH = 30;

/** Flush when the oldest buffered sample is at least this old (ms). */
export const DEFAULT_TELEMETRY_MAX_AGE_MS = 10_000;

/** One per-link telemetry sample, shaped to the spec §8.1 frame payload. */
export interface TelemetrySample {
	linkId: string;
	rttMs: number;
	nakCount: number;
	weightPercent: number;
	packetLoss: number;
	jitterMs: number;
	tsMs: number;
}

export interface TelemetryRecorderDeps {
	/** Source of the current per-link telemetry snapshot (link-telemetry.ts). */
	readLinkTelemetry: () => LinkTelemetryMessage | null;
	/** Emit a `telemetry` status frame on the control channel (best-effort). */
	relay: (type: string, payload: unknown, seq: number) => void;
	/** Next monotonic per-type relay seq. */
	nextSeq: (type: string) => number;
	now: () => number;
	maxBatch: number;
	maxAgeMs: number;
}

function defaultDeps(): TelemetryRecorderDeps {
	return {
		readLinkTelemetry: buildLinkTelemetry,
		relay: relayStatusToGateway,
		nextSeq: nextRelaySeq,
		now: Date.now,
		maxBatch: DEFAULT_TELEMETRY_MAX_BATCH,
		maxAgeMs: DEFAULT_TELEMETRY_MAX_AGE_MS,
	};
}

/**
 * Map a live link-telemetry snapshot to durable samples. STALE rows are skipped
 * (a stale tick carries no new data, so recording it would duplicate the last
 * fresh values). `packetLoss`/`jitterMs` default to 0 until srtla-send reports
 * them; `linkId` is the human interface name link-telemetry already resolved.
 */
export function samplesFromLinkTelemetry(
	msg: LinkTelemetryMessage | null,
	now: number,
): TelemetrySample[] {
	if (msg === null) return [];
	const out: TelemetrySample[] = [];
	for (const link of msg.links) {
		if (link.stale) continue;
		out.push({
			linkId: link.iface,
			rttMs: link.rtt_ms,
			nakCount: link.nak_count,
			weightPercent: link.weight_percent,
			packetLoss: 0,
			jitterMs: 0,
			tsMs: now,
		});
	}
	return out;
}

interface RecorderState {
	deps: TelemetryRecorderDeps;
	buffer: TelemetrySample[];
	oldestTsMs: number | null;
}

let state: RecorderState | undefined;

/** Start (or restart) the recorder with a clean buffer. Idempotent. */
export function startTelemetryRecorder(
	overrides: Partial<TelemetryRecorderDeps> = {},
): void {
	state = {
		deps: { ...defaultDeps(), ...overrides },
		buffer: [],
		oldestTsMs: null,
	};
}

/** Stop the recorder and discard any unflushed buffer (process/stream reset). */
export function stopTelemetryRecorder(): void {
	state = undefined;
}

export function isTelemetryRecorderActive(): boolean {
	return state !== undefined;
}

/**
 * Emit the buffered batch as one `telemetry` status frame and clear the buffer.
 * Best-effort: a missing/disconnected control channel makes `relay` a no-op, and
 * the buffer is cleared regardless so memory stays bounded (telemetry is not
 * durably queued on the device). Returns the flushed sample count (0 if empty).
 */
export function flushTelemetry(): number {
	if (state === undefined || state.buffer.length === 0) return 0;
	const samples = state.buffer;
	state.buffer = [];
	state.oldestTsMs = null;
	state.deps.relay(
		TELEMETRY_STATUS_TYPE,
		{ samples },
		state.deps.nextSeq(TELEMETRY_STATUS_TYPE),
	);
	return samples.length;
}

/**
 * One recorder tick (driven by the heartbeat): read the current snapshot, append
 * fresh samples, and flush on the size or age boundary. Fully synchronous and
 * exception-safe — it never throws into the loop that calls it.
 */
export function recordTelemetryTick(): void {
	if (state === undefined) return;
	try {
		const now = state.deps.now();
		const samples = samplesFromLinkTelemetry(
			state.deps.readLinkTelemetry(),
			now,
		);
		if (samples.length > 0) {
			if (state.oldestTsMs === null) state.oldestTsMs = now;
			state.buffer.push(...samples);
		}

		const sizeBoundary = state.buffer.length >= state.deps.maxBatch;
		const ageBoundary =
			state.oldestTsMs !== null &&
			now - state.oldestTsMs >= state.deps.maxAgeMs;
		if (state.buffer.length > 0 && (sizeBoundary || ageBoundary)) {
			flushTelemetry();
		}
	} catch {
		// Best-effort, non-blocking (spec §8.1): a recorder fault must never disturb
		// the heartbeat/streaming loop. Drop the tick; the next one recovers.
	}
}

/** Test-only: current buffered sample count (no flush). */
export function bufferedSampleCountForTest(): number {
	return state?.buffer.length ?? 0;
}
