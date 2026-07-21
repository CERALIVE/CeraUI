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

// active_encode status source (T14). The cerastream bridge stores the RESOLVED
// runtime encode (`active_encode`, incl. the network-leg `input_codec`) in the
// backend telemetry (`cerastream-backend.ts` handleEvent), but the default
// on-change `broadcastStatus()` nudge carries only `{is_streaming}` — so before
// this seam the field never rode the production `status` snapshot at all (only
// mocks delivered it). This module is the SINGLE resolver every status snapshot
// builder (`sendStatus`, `getStatusProcedure`, `buildInitialStatus`) routes
// through so `active_encode` actually reaches the wire.
//
// It mirrors `link-telemetry.ts`'s mock-provider seam exactly: a registered mock
// provider short-circuits the real telemetry read in dev/e2e (a non-null return
// wins), and production (no provider registered) reads the real engine telemetry
// via the frozen `getStreamingBackend()` seam — never the singleton directly.

import type { ActiveEncode } from "@ceraui/rpc/schemas";
import { getActivePassthrough } from "./active-passthrough.ts";
import { getStreamingBackend } from "./streaming-engine.ts";

// Dev/e2e seam: with no real cerastream session the engine telemetry is empty, so
// a registered mock provider surfaces a plausible `active_encode` (incl.
// `input_codec` for a network-ingest source) through the EXISTING status flow.
type MockActiveEncodeProvider = () => ActiveEncode | null;

let mockActiveEncodeProvider: MockActiveEncodeProvider | null = null;

/** Register (or clear with null) the dev/e2e mock active-encode provider. */
export function setMockActiveEncodeProvider(
	fn: MockActiveEncodeProvider | null,
): void {
	mockActiveEncodeProvider = fn;
}

/**
 * The RESOLVED runtime encode for the status snapshot: the mock provider's value
 * in dev/e2e, else the real engine telemetry's `active_encode` (null-safe: no
 * live session / older engine / no reported field → `null`). Null-safe end to
 * end so an idle device or an engine that never reports the field simply omits it.
 */
export function getActiveEncodeStatus(): ActiveEncode | null {
	const mock = mockActiveEncodeProvider?.();
	if (mock) return mock;
	const telemetry = getStreamingBackend().getTelemetry?.() as
		| { active_encode?: ActiveEncode }
		| null
		| undefined;
	const active = telemetry?.active_encode;
	if (!active) return null;
	// The typed binding strips `active_encode.passthrough`; overlay the raw-bridge
	// value so the wire snapshot carries the authoritative live passthrough state.
	const rawPassthrough = getActivePassthrough();
	return rawPassthrough === undefined
		? active
		: { ...active, passthrough: rawPassthrough };
}
