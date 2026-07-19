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
// `get-capabilities` is the additive method #9 on the published
// `CerastreamClient` surface. A `schema_version` skew is informational only
// (additive within `cerastream-ipc/1`, mirroring `probeEngine`): it warns and
// flags the response, never throws.

import {
	type CaptureCap,
	type CerastreamClient,
	type ConnectOptions,
	connect,
	type GetCapabilitiesResult,
	getCapabilitiesResultSchema,
	type ListDevicesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import {
	type DeviceMode,
	type DeviceModeGroup,
	normalizeBitrateRangeToKbps,
	normalizeFramerateToRung,
} from "@ceraui/rpc/schemas";

import { logger as defaultLogger } from "../../helpers/logger.ts";

/**
 * The capability snapshot the UI consumes. It is the engine's
 * {@link GetCapabilitiesResult} plus the freshness flags the UI renders:
 *  - `engineUnavailable` — the snapshot is NOT live (cached or minimal).
 *  - `engineStarting` — there has been no live snapshot this run (minimal only).
 *  - `schemaVersionMismatch` — the engine reported a different `schema_version`
 *    than the bindings; additive-only, the data is still served.
 */
export type CapabilitiesResult = Omit<
	GetCapabilitiesResult,
	"network_embedded_audio"
> & {
	engineUnavailable: boolean;
	engineStarting?: boolean;
	schemaVersionMismatch?: boolean;
	/** Relay transports the engine can honor; always includes "srtla". */
	transports: string[];
	/** Per-device capture modes (keyed by `list-devices` input_id); present only
	 *  on a LIVE snapshot with non-empty caps, absent on every fallback rung. */
	device_modes?: Record<string, DeviceModeGroup>;
	/** Engine can route embedded (muxed) network-ingest audio (Task 21/13). Read
	 *  from the raw response before the frozen schema strips it, like `transports`,
	 *  and re-added via the single conditional spread below. Absent/false on a
	 *  legacy engine → the selectable-ALSA path (Task 13 gate). Overrides the base
	 *  `GetCapabilitiesResult` field (cerastream >= 2026.7.1 retains it in the
	 *  frozen schema) to accept `| undefined`, so a `...caps` / `...lastKnownGood`
	 *  spread stays assignable under `exactOptionalPropertyTypes`. */
	network_embedded_audio?: boolean | undefined;
};

/** A live engine snapshot plus the `schema_version` it was negotiated under. */
export interface EngineCapabilitiesSnapshot {
	caps: GetCapabilitiesResult;
	schemaVersion: string;
	/** Relay transports advertised by the engine (additive; "srtla" implied). */
	transports?: string[];
	/** Embedded network-ingest audio capability (additive; read before the strip). */
	network_embedded_audio?: boolean;
}

/** SRTLA is always available; promoted transports (e.g. "rist") are additive. */
const BASE_TRANSPORTS = ["srtla"] as const;

/** Merge engine-advertised transports onto the always-present SRTLA base. */
function deriveTransports(advertised: string[] | undefined): string[] {
	const out = new Set<string>(BASE_TRANSPORTS);
	for (const t of advertised ?? []) {
		if (typeof t === "string" && t.length > 0) out.add(t);
	}
	return [...out];
}

/** Last-known transport set; sync source for the streaming resolver gate. */
let lastTransports: string[] = [...BASE_TRANSPORTS];

/** Last-known embedded-audio capability, persisted across a transient outage
 *  like `lastTransports` (it is a static build capability, Task 21). */
let lastNetworkEmbeddedAudio: boolean | undefined;

/** The transports the engine last advertised (always includes "srtla"). */
export function getSupportedTransports(): string[] {
	return [...lastTransports];
}

/** Last full capability snapshot; sync source for the post-login broadcast. */
let lastCapabilities: CapabilitiesResult | undefined;

/** The last resolved capability snapshot, or `undefined` before the first fetch. */
export function getLastCapabilities(): CapabilitiesResult | undefined {
	return lastCapabilities;
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
	/** Fetch the engine's `list-devices` result over a short-lived probe (never
	 *  the streaming backend's active-stream connection). A failure never blocks
	 *  the capability broadcast — the caller logs and omits `device_modes`. */
	fetchEngineDevices: () => Promise<ListDevicesResult>;
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
		const raw = await client.getCapabilities();
		const caps = getCapabilitiesResultSchema.parse(raw);
		// `transports` is additive and not on the frozen result schema (which
		// strips unknowns), so read it from the raw response before the parse drop.
		const rawTransports = (raw as { transports?: unknown }).transports;
		const transports = Array.isArray(rawTransports)
			? rawTransports.filter((t): t is string => typeof t === "string")
			: undefined;
		const rawEmbeddedAudio = (raw as { network_embedded_audio?: unknown })
			.network_embedded_audio;
		const network_embedded_audio =
			typeof rawEmbeddedAudio === "boolean" ? rawEmbeddedAudio : undefined;
		return {
			caps,
			schemaVersion,
			...(transports !== undefined ? { transports } : {}),
			...(network_embedded_audio !== undefined
				? { network_embedded_audio }
				: {}),
		};
	} finally {
		try {
			await client?.close();
		} catch {
			// Best-effort disconnect of a probe connection; never respawns the engine.
		}
	}
}

/**
 * Default device fetch: open the SAME kind of short-lived probe connection the
 * capability fetch uses, call `list-devices`, and disconnect. This deliberately
 * does NOT route through `getStreamingBackend()` — the frozen `StreamingBackend`
 * seam has no `listDevices`, and the concrete backend's passthrough throws when
 * no stream is active, so a fresh probe is the only idle-safe path.
 */
export async function defaultFetchEngineDevices(): Promise<ListDevicesResult> {
	const { setup } = await import("../setup.ts");
	const connectOptions: ConnectOptions = setup.cerastream_socket
		? { socketPath: setup.cerastream_socket }
		: {};

	let client: CerastreamClient | undefined;
	try {
		client = await connect(connectOptions);
		return await client.listDevices();
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
		fetchEngineDevices: defaultFetchEngineDevices,
		bindingsSchemaVersion: SCHEMA_VERSION,
		logger: defaultLogger,
	};
}

/**
 * Group one device's raw `caps[]` into `{width,height,framerates[]}` modes,
 * collapsing the engine's per-mode framerate cross-product. Keyed by
 * (width, height, media_type) so a resolution offered under two media types
 * stays distinct; framerates are normalized to legal rungs (non-rungs dropped,
 * fail-closed) and de-duplicated in first-seen order.
 */
export function groupDeviceCaps(caps: readonly CaptureCap[]): DeviceMode[] {
	const modes: DeviceMode[] = [];
	const byKey = new Map<string, DeviceMode>();
	for (const cap of caps) {
		if (cap.width === undefined || cap.height === undefined) continue;
		const key = `${cap.width}x${cap.height}|${cap.media_type ?? ""}`;
		let mode = byKey.get(key);
		if (mode === undefined) {
			mode = {
				width: cap.width,
				height: cap.height,
				framerates: [],
				...(cap.media_type !== undefined ? { media_type: cap.media_type } : {}),
			};
			byKey.set(key, mode);
			modes.push(mode);
		}
		if (cap.framerate !== undefined) {
			const rung = normalizeFramerateToRung(cap.framerate);
			if (rung !== undefined && !mode.framerates.includes(rung)) {
				mode.framerates.push(rung);
			}
		}
	}
	return modes;
}

/**
 * Fold a `list-devices` result into the broadcast `device_modes` map keyed by
 * device `input_id`, carrying each device `kind` (the bridge to a pipeline id).
 * Devices with no/empty caps are skipped; returns `undefined` when nothing folds
 * so the caller omits the field entirely (the UI then falls back to coarse caps).
 */
function foldDeviceModes(
	result: ListDevicesResult,
): Record<string, DeviceModeGroup> | undefined {
	const out: Record<string, DeviceModeGroup> = {};
	for (const device of result.devices) {
		if (device.caps === undefined || device.caps.length === 0) continue;
		const modes = groupDeviceCaps(device.caps);
		if (modes.length === 0) continue;
		out[device.input_id] = {
			...(device.kind !== undefined ? { kind: device.kind } : {}),
			modes,
		};
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Best-effort `device_modes` resolution: a failed/throwing `list-devices` NEVER
 * blocks the capability broadcast — it is logged and `device_modes` is omitted.
 */
async function resolveDeviceModes(
	deps: CapabilitiesServiceDeps,
): Promise<Record<string, DeviceModeGroup> | undefined> {
	try {
		return foldDeviceModes(await deps.fetchEngineDevices());
	} catch (err) {
		deps.logger.warn(
			"capabilities: list-devices failed; broadcasting capabilities without device_modes",
			{ err },
		);
		return undefined;
	}
}

// In-memory last-known-good snapshot. Populated on every successful live fetch;
// process-wide so a later engine outage serves the most recent good caps.
let lastKnownGood: GetCapabilitiesResult | undefined;

/** Drop the cached snapshot. Test seam + a hook for an engine-incompatible boot. */
export function clearCapabilitiesCache(): void {
	lastKnownGood = undefined;
	lastTransports = [...BASE_TRANSPORTS];
	lastNetworkEmbeddedAudio = undefined;
	lastCapabilities = undefined;
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
		const {
			caps: rawCaps,
			schemaVersion,
			transports,
			network_embedded_audio: networkEmbeddedAudio,
		} = await deps.fetchEngineCapabilities();
		const mismatch = schemaVersion !== deps.bindingsSchemaVersion;
		if (mismatch) {
			// Additive-only within the protocol major (ADR-0002): warn + flag, but
			// still serve — degrading, never crashing, on version skew.
			deps.logger.warn(
				"capabilities: engine schema_version differs from bindings; degrading (additive-only, informational)",
				{ engine: schemaVersion, bindings: deps.bindingsSchemaVersion },
			);
		}
		// Speak kbps everywhere downstream: the engine may report the bitrate range
		// in bps, so normalize it once here — the single unit-conversion seam.
		const caps: GetCapabilitiesResult = {
			...rawCaps,
			encoder: {
				...rawCaps.encoder,
				bitrate_range: normalizeBitrateRangeToKbps(
					rawCaps.encoder.bitrate_range,
				),
			},
		};
		const deviceModes = await resolveDeviceModes(deps);
		lastKnownGood = caps;
		lastTransports = deriveTransports(transports);
		lastNetworkEmbeddedAudio = networkEmbeddedAudio;
		lastCapabilities = {
			...caps,
			engineUnavailable: false,
			...(mismatch ? { schemaVersionMismatch: true } : {}),
			...(deviceModes ? { device_modes: deviceModes } : {}),
			transports: [...lastTransports],
			...(lastNetworkEmbeddedAudio !== undefined
				? { network_embedded_audio: lastNetworkEmbeddedAudio }
				: {}),
		};
		return lastCapabilities;
	} catch (err) {
		if (lastKnownGood) {
			deps.logger.warn(
				"capabilities: engine unavailable; serving last-known-good snapshot",
				{ err },
			);
			lastCapabilities = {
				...lastKnownGood,
				engineUnavailable: true,
				transports: [...lastTransports],
				...(lastNetworkEmbeddedAudio !== undefined
					? { network_embedded_audio: lastNetworkEmbeddedAudio }
					: {}),
			};
			return lastCapabilities;
		}
		deps.logger.warn(
			"capabilities: engine unavailable and no cached snapshot; serving minimal safe set",
			{ err },
		);
		lastTransports = [...BASE_TRANSPORTS];
		lastNetworkEmbeddedAudio = undefined;
		lastCapabilities = {
			...structuredClone(MINIMAL_SAFE_CAPABILITIES),
			engineUnavailable: true,
			engineStarting: true,
			transports: [...lastTransports],
		};
		return lastCapabilities;
	}
}
