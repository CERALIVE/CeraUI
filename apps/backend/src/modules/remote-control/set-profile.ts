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
 * Remote Control Plane v2.0 — platform-pushed SRT receive profile (Todo 28).
 *
 * The platform resolver pushes a resolved {@link SetProfileConfig} + `commandId`
 * via the `device.setProfile` INTERNAL command (spec §5, cloud Todo 14). This
 * module owns the device-side application of that push:
 *
 *  1. Intersect the pushed config against the device's engine capabilities — an
 *     unsupported preset or an FEC request the engine can't honour is REJECTED
 *     (never applied), latency is clamped to the receiver window.
 *  2. Persist the resolved config to `config.json` (so it is applied on the next
 *     connect — apply-on-reconnect, never a live mid-stream mutation).
 *  3. When a stream is active, RECONNECT (stop→start) so the new latency / FEC /
 *     profile takes effect; latency/profile cannot change live (the engine
 *     reload-config has no latency arm).
 *  4. Emit an ack `{ commandId, status, reason?, effectiveActiveProfile,
 *     effectiveLatencyMs }` back up the control channel.
 *
 * Idempotent: re-applying the SAME `commandId` returns the cached ack without
 * re-persisting or re-reconnecting (the platform retries the same frame, so the
 * device dedupes on commandId). Every effectful collaborator is injected
 * ({@link SetProfileDeps}) so the apply pipeline is unit-testable without disk,
 * the engine, or a live stream — mirroring `ingest-slots.ts`.
 */

import {
	PRESET_CONFIGS,
	type SetProfileAck,
	SRTLA_MIN_LATENCY_MS,
	type StreamProfileId,
	type StreamProfilePreset,
	type StreamRecoveryPreference,
	setProfilePayloadSchema,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";

/**
 * The device capabilities the intersection reads, projected from the engine
 * capability snapshot. `supportedProfiles` undefined/empty = the engine did not
 * advertise a profile list (no live snapshot yet) → the preset is NOT gated (the
 * platform already resolved it; the device can't prove it unsupported).
 */
export interface SetProfileCaps {
	supportedProfiles: readonly string[] | undefined;
	supportsFec: boolean;
	latencyRange: { min: number; max: number } | undefined;
}

/** The resolved, caps-safe config the device persists + applies. */
export interface ResolvedProfileConfig {
	presetId: StreamProfileId;
	latencyMs: number;
	fecEnabled: boolean;
	recoveryMode: StreamRecoveryPreference;
	/** Resolver provenance the push carried (operator/auto = cloud override). */
	decidedBy?: string;
}

/** Injected collaborators so the apply pipeline runs without disk/engine in tests. */
export interface SetProfileDeps {
	getCaps: () => SetProfileCaps;
	/** The profile + latency the device currently runs under (for a reject ack). */
	readActive: () => { profile: StreamProfileId; latencyMs: number };
	persist: (config: ResolvedProfileConfig) => void;
	isStreaming: () => boolean;
	/** Stop→start re-enters connect so the persisted config applies (never live). */
	reconnect: () => void | Promise<void>;
}

interface SetProfileState {
	deps: SetProfileDeps;
	/** commandId → emitted ack, so a re-send is a no-op returning the same ack. */
	acks: Map<string, SetProfileAck>;
}

const DEFAULT_PRESETS: readonly string[] = Object.keys(PRESET_CONFIGS);

function defaultDeps(): SetProfileDeps {
	return {
		getCaps: () => ({
			supportedProfiles: undefined,
			supportsFec: false,
			latencyRange: undefined,
		}),
		readActive: () => ({ profile: "custom", latencyMs: 0 }),
		persist: () => {
			/* no-op default; real deps injected by wireSetProfile() */
		},
		isStreaming: () => false,
		reconnect: () => {
			/* no-op default; real deps injected by wireSetProfile() */
		},
	};
}

let state: SetProfileState = { deps: defaultDeps(), acks: new Map() };

function isKnownPreset(presetId: string): presetId is StreamProfilePreset {
	return DEFAULT_PRESETS.includes(presetId);
}

function clampLatency(
	latencyMs: number,
	range: { min: number; max: number } | undefined,
): { value: number; clamped: boolean } {
	// Effective floor is the SRTLA minimum (T2), or the engine's own min when it
	// advertises a higher one. A pushed low-latency preset can never drop the
	// SRTLA path below 2 s.
	const min =
		range === undefined
			? SRTLA_MIN_LATENCY_MS
			: Math.max(range.min, SRTLA_MIN_LATENCY_MS);
	let value = Math.max(latencyMs, min);
	if (range !== undefined) value = Math.min(value, Math.max(range.max, min));
	return { value, clamped: value !== latencyMs };
}

function reject(
	commandId: string,
	reason: string,
	active: { profile: StreamProfileId; latencyMs: number },
): SetProfileAck {
	return {
		commandId,
		status: "rejected",
		reason,
		effectiveActiveProfile: active.profile,
		effectiveLatencyMs: active.latencyMs,
	};
}

/**
 * Apply an inbound `device.setProfile` payload. Returns the ack to emit, or `null`
 * when the payload is malformed (no `commandId`/config to ack — the router emits a
 * generic error result echoing the envelope `cid`). Idempotent on `commandId`.
 */
export async function handleSetProfile(
	payload: unknown,
): Promise<SetProfileAck | null> {
	const parsed = setProfilePayloadSchema.safeParse(payload);
	if (!parsed.success) {
		logger.debug("set-profile: dropped malformed device.setProfile payload");
		return null;
	}

	const { commandId, config } = parsed.data;

	const cached = state.acks.get(commandId);
	if (cached !== undefined) return cached;

	const caps = state.deps.getCaps();
	const active = state.deps.readActive();

	if (
		config.presetId !== "custom" &&
		caps.supportedProfiles !== undefined &&
		caps.supportedProfiles.length > 0 &&
		!caps.supportedProfiles.includes(config.presetId)
	) {
		const ack = reject(commandId, "profile_unsupported", active);
		state.acks.set(commandId, ack);
		return ack;
	}

	if (config.fecEnabled && !caps.supportsFec) {
		const ack = reject(commandId, "fec_unsupported", active);
		state.acks.set(commandId, ack);
		return ack;
	}

	const { value: latencyMs, clamped } = clampLatency(
		config.latencyMs,
		caps.latencyRange,
	);
	const presetId: StreamProfileId = isKnownPreset(config.presetId)
		? config.presetId
		: "custom";

	state.deps.persist({
		presetId,
		latencyMs,
		fecEnabled: config.fecEnabled,
		recoveryMode: config.recoveryMode,
		...(parsed.data.decidedBy !== undefined
			? { decidedBy: parsed.data.decidedBy }
			: {}),
	});

	if (state.deps.isStreaming()) {
		try {
			await state.deps.reconnect();
		} catch (err) {
			logger.warn(
				`set-profile: reconnect failed after applying ${presetId}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	const ack: SetProfileAck = {
		commandId,
		status: "applied",
		...(clamped ? { reason: "latency_clamped" } : {}),
		effectiveActiveProfile: presetId,
		effectiveLatencyMs: latencyMs,
	};
	state.acks.set(commandId, ack);
	return ack;
}

/** Test seam: override the injected collaborators. */
export function configureSetProfile(overrides: Partial<SetProfileDeps>): void {
	state.deps = { ...state.deps, ...overrides };
}

/** Test seam: reset deps + the idempotency ack cache to a clean floor. */
export function resetSetProfile(): void {
	state = { deps: defaultDeps(), acks: new Map() };
}
