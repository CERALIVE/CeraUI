/*
    CeraUI - web UI for the CERALIVE project
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

// Capability service. Resolves the shared capability contract (Option A: the
// cerastream engine emits, CeraUI consumes) the UI needs to render only the
// pipelines/encoder/sources the device can actually honor.
//
// The engine is systemd-owned (ADR-0005) and may not be up at boot, so the
// service NEVER lets a transient engine outage collapse the UI to an empty
// pipeline list. It applies a strict fallback ladder:
//
//   1. live   — fresh `get-capabilities` from the engine; cached as last-known-good
//   2. cached — the last-known-good snapshot, flagged `engineUnavailable`
//   3. minimal — a TestPattern-only safe set, flagged `engineUnavailable` +
//                `engineStarting` (the engine has never been reachable this run)
//
// `get-capabilities` is the additive method #9 (post-V1, not on the frozen
// `CerastreamClient` surface yet), so the default fetch probes for it on the
// connected client and degrades down the ladder when a stub binding has not
// implemented it. A `schema_version` skew is informational only (additive within
// `cerastream-ipc/1`, mirroring `probeEngine`): it warns and flags the response,
// never throws.

import {
	type CerastreamClient,
	type ConnectOptions,
	connect,
	type GetCapabilitiesResult,
	getCapabilitiesResultSchema,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";

import { logger as defaultLogger } from "../../helpers/logger.ts";

/**
 * The capability snapshot the UI consumes. It is the engine's
 * {@link GetCapabilitiesResult} plus the freshness flags the UI renders:
 *  - `engineUnavailable` — the snapshot is NOT live (cached or minimal).
 *  - `engineStarting` — there has been no live snapshot this run (minimal only).
 *  - `schemaVersionMismatch` — the engine reported a different `schema_version`
 *    than the bindings; additive-only, the data is still served.
 */
export type CapabilitiesResult = GetCapabilitiesResult & {
	engineUnavailable: boolean;
	engineStarting?: boolean;
	schemaVersionMismatch?: boolean;
};

/** A live engine snapshot plus the `schema_version` it was negotiated under. */
export interface EngineCapabilitiesSnapshot {
	caps: GetCapabilitiesResult;
	schemaVersion: string;
}

/** Minimal logger surface (winston satisfies it; tests pass a silent stub). */
export interface CapabilitiesLogger {
	debug(message: string, meta?: unknown): void;
	info(message: string, meta?: unknown): void;
	warn(message: string, meta?: unknown): void;
	error(message: string, meta?: unknown): void;
}

/** Injected collaborators; defaults wire the real engine + logger. */
export interface CapabilitiesServiceDeps {
	/** Fetch a live snapshot from the engine. Throws when the engine is down. */
	fetchEngineCapabilities: () => Promise<EngineCapabilitiesSnapshot>;
	/** The bindings' compiled-in `schema_version`, compared against the engine. */
	bindingsSchemaVersion: string;
	logger: CapabilitiesLogger;
}

/**
 * The minimal safe set: a single TestPattern source plus a conservative
 * software-only encoder/platform profile. This is the floor the UI falls back to
 * when the engine has never been reachable — it is intentionally NEVER empty so a
 * supported board can still render and start a test stream while the engine boots.
 */
export const MINIMAL_SAFE_CAPABILITIES: GetCapabilitiesResult = {
	platform: {
		supports_h265: false,
		hardware_accelerated: false,
		max_resolution: "1920x1080",
	},
	encoder: {
		codecs: ["H264"],
		bitrate_range: { min: 500, max: 6000, unit: "kbps" },
	},
	sources: [
		{
			id: "test",
			supports_audio: false,
			supports_resolution_override: false,
			supports_framerate_override: false,
			default_resolution: "1920x1080",
			default_framerate: 30,
		},
	],
};

/**
 * Client surface for the additive `get-capabilities` method (#9). The published
 * {@link CerastreamClient} interface does not expose it yet (it is post-V1 and
 * additive), so the default fetch probes for it and falls down the ladder when a
 * stub binding has not implemented it — the typed contract still ships ahead.
 */
interface CapabilitiesCapableClient extends CerastreamClient {
	getCapabilities?: () => Promise<unknown>;
}

/**
 * Default engine fetch: connect, read the negotiated `schema_version`, call
 * `get-capabilities`, and validate the result against the frozen Zod contract.
 * The connection is a short-lived probe — `close()` only drops our socket; it
 * never spawns or stops the systemd-owned engine.
 */
async function defaultFetchEngineCapabilities(): Promise<EngineCapabilitiesSnapshot> {
	// Lazy import keeps the setup graph out of this module's load path; the
	// socket override is only needed for the real on-device fetch.
	const { setup } = await import("../setup.ts");
	const connectOptions: ConnectOptions = setup.cerastream_socket
		? { socketPath: setup.cerastream_socket }
		: {};

	let client: CerastreamClient | undefined;
	try {
		client = await connect(connectOptions);
		const schemaVersion = client.hello.schema_version;
		const capable = client as CapabilitiesCapableClient;
		if (typeof capable.getCapabilities !== "function") {
			throw new Error(
				"cerastream client does not expose get-capabilities (additive method #9)",
			);
		}
		const raw = await capable.getCapabilities();
		const caps = getCapabilitiesResultSchema.parse(raw);
		return { caps, schemaVersion };
	} finally {
		try {
			await client?.close();
		} catch {
			// Best-effort disconnect of a probe connection; never respawns the engine.
		}
	}
}

function defaultDeps(): CapabilitiesServiceDeps {
	return {
		fetchEngineCapabilities: defaultFetchEngineCapabilities,
		bindingsSchemaVersion: SCHEMA_VERSION,
		logger: defaultLogger,
	};
}

// In-memory last-known-good snapshot. Populated on every successful live fetch;
// process-wide so a later engine outage serves the most recent good caps.
let lastKnownGood: GetCapabilitiesResult | undefined;

/** Drop the cached snapshot. Test seam + a hook for an engine-incompatible boot. */
export function clearCapabilitiesCache(): void {
	lastKnownGood = undefined;
}

/** The cached last-known-good snapshot, or `undefined` if none yet. */
export function getCachedCapabilities(): GetCapabilitiesResult | undefined {
	return lastKnownGood;
}

/**
 * Resolve the device capability contract, applying the live → cached → minimal
 * fallback ladder. Always resolves with a usable, non-empty
 * {@link CapabilitiesResult}; it never rejects on an engine outage or a
 * `schema_version` skew.
 */
export async function getCapabilities(
	overrides: Partial<CapabilitiesServiceDeps> = {},
): Promise<CapabilitiesResult> {
	const deps: CapabilitiesServiceDeps = { ...defaultDeps(), ...overrides };

	try {
		const { caps, schemaVersion } = await deps.fetchEngineCapabilities();
		const mismatch = schemaVersion !== deps.bindingsSchemaVersion;
		if (mismatch) {
			// Additive-only within the protocol major (ADR-0002): warn + flag, but
			// still serve — degrading, never crashing, on version skew.
			deps.logger.warn(
				"capabilities: engine schema_version differs from bindings; degrading (additive-only, informational)",
				{ engine: schemaVersion, bindings: deps.bindingsSchemaVersion },
			);
		}
		lastKnownGood = caps;
		return {
			...caps,
			engineUnavailable: false,
			...(mismatch ? { schemaVersionMismatch: true } : {}),
		};
	} catch (err) {
		if (lastKnownGood) {
			deps.logger.warn(
				"capabilities: engine unavailable; serving last-known-good snapshot",
				{ err },
			);
			return { ...lastKnownGood, engineUnavailable: true };
		}
		deps.logger.warn(
			"capabilities: engine unavailable and no cached snapshot; serving minimal safe set",
			{ err },
		);
		return {
			...structuredClone(MINIMAL_SAFE_CAPABILITIES),
			engineUnavailable: true,
			engineStarting: true,
		};
	}
}
