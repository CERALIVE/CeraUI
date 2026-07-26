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

// `engine_bitrate` status source — the APPLIED encode rate beside the CONFIGURED
// ceiling.
//
// cerastream's adaptive controller emits a `bitrate` event whenever it moves the
// encode rate, and `cerastream-backend.ts` handleEvent has always folded it into
// backend telemetry as `{bitrate: {current, max}}`. Nothing ever published it, so
// every operator surface fell back to `config.max_br` — the ceiling the operator
// ASKED for — and a link that could only sustain 3 Mbps of a 5 Mbps request still
// read "5 Mbps" everywhere. This module is the single resolver each status
// snapshot builder (`sendStatus`, `getStatusProcedure`, `buildInitialStatus`)
// routes through so the applied rate reaches the wire.
//
// It mirrors `active-encode-status.ts` exactly: a registered mock provider
// short-circuits the real read in dev/e2e (a non-null return wins), production
// reads engine telemetry through the frozen `getStreamingBackend()` seam, and a
// null return means "the engine never told us" — never a fabricated zero.

import type { EngineBitrate } from "@ceraui/rpc/schemas";
import { getStreamingBackend } from "./streaming-engine.ts";

type MockEngineBitrateProvider = () => EngineBitrate | null;

let mockEngineBitrateProvider: MockEngineBitrateProvider | null = null;

/** Register (or clear with null) the dev/e2e mock engine-bitrate provider. */
export function setMockEngineBitrateProvider(
	fn: MockEngineBitrateProvider | null,
): void {
	mockEngineBitrateProvider = fn;
}

/** The engine telemetry shape written by `CerastreamBackend.handleEvent`. */
type BitrateTelemetry = { bitrate?: { current?: unknown; max?: unknown } };

/**
 * Project engine telemetry onto the wire pair. Null unless BOTH halves are
 * present and finite: a half-reading cannot separate applied from configured,
 * which is the exact confusion this field exists to remove, and inventing the
 * missing half would resurrect it.
 */
export function extractEngineBitrate(
	telemetry: BitrateTelemetry | null | undefined,
): EngineBitrate | null {
	const applied = telemetry?.bitrate?.current;
	const ceiling = telemetry?.bitrate?.max;
	if (typeof applied !== "number" || !Number.isFinite(applied)) return null;
	if (typeof ceiling !== "number" || !Number.isFinite(ceiling)) return null;
	return { applied_kbps: applied, ceiling_kbps: ceiling };
}

/**
 * The engine's live bitrate reading for a status snapshot: the mock provider's
 * value in dev/e2e, else the real engine telemetry. Null when there is no live
 * session or the engine predates the `bitrate` event.
 */
export function getEngineBitrateStatus(): EngineBitrate | null {
	const mock = mockEngineBitrateProvider?.();
	if (mock) return mock;
	return extractEngineBitrate(
		getStreamingBackend().getTelemetry?.() as BitrateTelemetry | null,
	);
}
