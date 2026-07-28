/**
 * Device-truth guards for the encode target (device-quality-wave3 todo 11).
 *
 * cerastream ADR-0008 §10 settles the contract this module enforces: a device's
 * per-`media_type` mode ladder is the ONLY truth, the engine reports it VERBATIM,
 * and "the UI and the save path may never invent or union". The RULE itself lives
 * once in `@ceraui/rpc` (`capabilities/device-mode-truth.ts`) and is shared with
 * the frontend `ValidationAdapter` — an offering the save path would reject is a
 * lie told to the operator, and a save the offering would have disabled is a
 * bypass of the very rule. This module is only the BACKEND BINDING of that rule:
 * it resolves which source is governing and hands its ladder to the shared
 * evaluator.
 *
 * Two entry points, one rule:
 *
 *   - {@link verifySaveDeviceMode} — the SAVE-TIME refusal (11a). It runs at the
 *     RPC procedure, not the dialog, because the guarantee has to hold for a
 *     direct RPC call too.
 *   - {@link clampPersistedDeviceMode} — the LOAD-TIME clamp (11b), for a config
 *     persisted against different hardware before the save guard existed.
 *
 * NONE-CAP POLICY, inherited from the shared rule: an unknown never subtracts. A
 * source with no reported ladder, a coarse/virtual/network source, and an
 * un-normalizable payload all pass. Refusing on an unknown would block a save the
 * hardware can honour, which is the same dishonesty in the other direction.
 */

import {
	type DeviceMode,
	type DeviceModeVerdict,
	evaluateDeviceMode,
	type Framerate,
	nearestDeliverableMode,
	type Resolution,
	type SourceModeCeiling,
	type StreamSource,
} from "@ceraui/rpc";

import type { LastSeenDevice } from "../../helpers/config-schemas.ts";
import { getSourcesMessage, resolveSourceIdentity } from "./sources.ts";

/**
 * The typed refusal `streaming.setConfig` returns for an encode target the
 * SELECTED source cannot deliver. It is a stable wire value — the frontend keys
 * its honest rejection copy on it.
 */
export const DEVICE_MODE_UNSUPPORTED_ERROR = "device_mode_unsupported";

/** The governing ladder for a source id, or `undefined` when there is none. */
interface GoverningLadder {
	modes: readonly DeviceMode[];
	kind: string | undefined;
}

/**
 * The source whose ladder governs an encode target, resolved through the SAME
 * stable-identity rule the routing seam uses — so a persisted id that went stale
 * across a replug still finds its device instead of silently failing open.
 */
function governingLadder(
	sourceId: string | undefined,
	sources: readonly StreamSource[],
	lastSeenDevices: readonly LastSeenDevice[] | undefined,
): GoverningLadder | undefined {
	if (sourceId === undefined) return undefined;
	const effectiveId = resolveSourceIdentity(sourceId, sources, lastSeenDevices);
	const source = sources.find((entry) => entry.id === effectiveId);
	if (source === undefined || source.modes.length === 0) return undefined;
	return {
		modes: source.modes,
		kind: source.origin === "capture" ? source.kind : undefined,
	};
}

/** The encode target being checked, as the caller knows it. */
export interface DeviceModeTarget {
	/** The source the target applies to — the one being SAVED, not the persisted one. */
	sourceId: string | undefined;
	resolution: Resolution | undefined;
	framerate: Framerate | undefined;
}

/** Injected state, so the load-time clamp can be driven without the singletons. */
export interface DeviceModeGuardDeps {
	sources?: readonly StreamSource[];
	lastSeenDevices?: readonly LastSeenDevice[] | undefined;
}

function resolveDeps(deps: DeviceModeGuardDeps | undefined): {
	sources: readonly StreamSource[];
	lastSeenDevices: readonly LastSeenDevice[] | undefined;
} {
	return {
		sources: deps?.sources ?? getSourcesMessage().sources,
		lastSeenDevices: deps?.lastSeenDevices,
	};
}

/**
 * Whether an encode target is one the SELECTED source can actually deliver.
 *
 * The caller MUST pass the source being saved (`input.source ?? config.source`)
 * and the EFFECTIVE axes (`input.resolution ?? config.resolution`, same for
 * framerate) — a half-save that changes only the framerate is still a full
 * {resolution, framerate} pairing against the device, and checking the axes
 * independently is precisely the cross-product lie the contract forbids.
 */
export function verifySaveDeviceMode(
	target: DeviceModeTarget,
	deps?: DeviceModeGuardDeps,
): DeviceModeVerdict {
	const { sources, lastSeenDevices } = resolveDeps(deps);
	const ladder = governingLadder(target.sourceId, sources, lastSeenDevices);
	if (ladder === undefined) return { supported: true };
	return evaluateDeviceMode({
		modes: ladder.modes,
		kind: ladder.kind,
		resolution: target.resolution,
		framerate: target.framerate,
	});
}

/**
 * The nearest mode the selected source CAN deliver, for a persisted target it
 * cannot. `undefined` when the target is already deliverable, when no ladder is
 * reported, or when nothing truthful exists to clamp TO — in every one of those
 * cases the persisted value must be left exactly as it is.
 */
export function clampPersistedDeviceMode(
	target: DeviceModeTarget,
	deps?: DeviceModeGuardDeps,
): SourceModeCeiling | undefined {
	const { sources, lastSeenDevices } = resolveDeps(deps);
	const ladder = governingLadder(target.sourceId, sources, lastSeenDevices);
	if (ladder === undefined) return undefined;
	const query = {
		modes: ladder.modes,
		kind: ladder.kind,
		resolution: target.resolution,
		framerate: target.framerate,
	};
	if (evaluateDeviceMode(query).supported) return undefined;
	const nearest = nearestDeliverableMode(query);
	if (nearest === undefined) return undefined;
	// A "clamp" that changes nothing is not a clamp — never notify on a no-op.
	if (
		nearest.resolution === target.resolution &&
		nearest.framerate === target.framerate
	) {
		return undefined;
	}
	return nearest;
}
