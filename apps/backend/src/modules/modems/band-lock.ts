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
 * The band-lock transaction.
 *
 * A band lock is the clearest case the mutation-safety contract exists for: the
 * write itself always "succeeds", and the damage shows up seconds later as a
 * radio that never re-registers. So SUCCESS HERE IS REGISTRATION, not an mmcli
 * confirmation line, and everything below is arranged around proving it:
 *
 *   1. the feature gate + the per-device lease + the durable journal, all
 *      through `withCapabilityModuleMutation` — never a second guard beside it;
 *   2. the previous selection is persisted as `preState` BEFORE the write, so a
 *      crash at any instant leaves a record startup replay can act on;
 *   3. the write, then a READBACK — an accepted-but-ignored write is the failure
 *      mode that looks like success from the call site alone;
 *   4. registration is PROVEN within {@link BAND_REGISTRATION_BOUND_MS}, and if
 *      it is not, the previous selection is restored automatically.
 *
 * THE TIMED ROLLBACK SURVIVES A BACKEND RESTART BY CONSTRUCTION, not by a
 * persisted timer. The journal entry stays `executing` for the whole
 * registration window and is cancelled ONLY once the outcome is settled, so a
 * process that dies inside the window leaves an `executing` entry — which the
 * replay table rolls back on the next boot through the handler registered in
 * `band-rollback.ts`. A timer that had to be reconstructed after a crash would
 * be a second mechanism to keep in agreement with the journal; there is one.
 *
 * `auto_restored` is reported as its own outcome rather than as a success or a
 * failure. The operator's uplink is intact and their request did not take
 * effect, and calling that either name is a lie in one direction or the other.
 */

import type {
	CapabilityMutationRefusal,
	ModemBandsRefusal,
	SetModemBandsStatus,
} from "@ceraui/rpc/schemas";
import { BAND_ANY } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import {
	getBandCapability,
	refreshBandCapability,
	resolveBandSku,
} from "./band-capability.ts";
import {
	isRegisteredState,
	isUnlockedSelection,
	readModemBands,
	readRegistrationState,
	writeModemBands,
} from "./band-mmcli.ts";
import { IMPLEMENTED_MODEM_CAPABILITY_MODULES } from "./capability-evidence.ts";
import { withCapabilityModuleMutation } from "./capability-mutation.ts";

/**
 * How long the radio is given to attach on the new bands before the change is
 * treated as unavailable and put back.
 *
 * 45 s is a re-registration budget, not a guess at network latency: a band
 * change tears the radio down and re-runs PLMN search, which the 3GPP procedure
 * alone can spend tens of seconds on for a sparse band. Shorter, and a working
 * band on a slow network gets rolled back under an operator who was about to
 * succeed; much longer, and an operator sits on a dead uplink watching a spinner.
 */
export const BAND_REGISTRATION_BOUND_MS = 45_000;
export const BAND_REGISTRATION_POLL_MS = 3_000;

export interface BandTiming {
	now(): number;
	sleep(ms: number): Promise<void>;
}

export const defaultBandTiming: BandTiming = {
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface SetBandsOutcome {
	readonly success: boolean;
	readonly status?: SetModemBandsStatus;
	readonly bands?: string[];
	readonly error?: ModemBandsRefusal;
	readonly mutationRefusal?: CapabilityMutationRefusal;
	readonly detail?: string;
}

/**
 * Poll until the radio is attached, or the bound elapses.
 *
 * Deliberately polls rather than subscribing: the registration state rides
 * mmcli's own `-K` read, which is the same source everything else on this path
 * uses, and a subscription would introduce a second view of the one fact the
 * whole transaction turns on.
 */
export async function waitForRegistration(
	device: string,
	timing: BandTiming = defaultBandTiming,
	boundMs: number = BAND_REGISTRATION_BOUND_MS,
): Promise<boolean> {
	const deadline = timing.now() + boundMs;
	for (;;) {
		if (isRegisteredState(await readRegistrationState(device))) return true;
		if (timing.now() >= deadline) return false;
		await timing.sleep(BAND_REGISTRATION_POLL_MS);
	}
}

/** The bands the modem reports right now, or an empty list if it cannot be read. */
async function currentBands(device: string): Promise<readonly string[]> {
	const read = await readModemBands(device);
	return read.ok ? read.current : [];
}

function sameSelection(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const wanted = new Set(a);
	return b.every((band) => wanted.has(band));
}

/**
 * Apply a band selection under the full mutation-safety contract.
 *
 * `bands` of exactly `['any']` is the reset — ModemManager has no separate verb,
 * so this one path covers set, change, and release.
 */
export async function applyBandLock(
	deviceId: string,
	bands: readonly string[],
	timing: BandTiming = defaultBandTiming,
): Promise<SetBandsOutcome> {
	const identity = await resolveBandSku(deviceId);
	if (identity === undefined) {
		return { success: false, error: "unknown_modem" };
	}
	const snapshot = await refreshBandCapability(deviceId, identity.stableKey);
	if (!snapshot.certified) {
		return { success: false, error: "uncertified" };
	}
	// The catalog may narrow what is offerable below what the modem advertises;
	// a request outside that set is refused here rather than dispatched, because
	// the certification is the only evidence that a band can be left again.
	const offerable = new Set([...snapshot.offerable, BAND_ANY]);
	const unknown = bands.find((band) => !offerable.has(band));
	if (unknown !== undefined) {
		return { success: false, error: "uncertified", detail: unknown };
	}

	const preState = { bands: [...snapshot.current] };

	const guarded = await withCapabilityModuleMutation<SetBandsOutcome>(
		{
			module: "band-lock",
			stableKey: identity.stableKey,
			preState,
			implemented: IMPLEMENTED_MODEM_CAPABILITY_MODULES,
		},
		async ({ journal }) => {
			await journal?.markExecuting();

			if (!(await writeModemBands(deviceId, bands))) {
				return {
					// The write was refused, so nothing changed and there is nothing
					// outstanding — the journal entry is cancelled rather than left
					// blocking a device that is exactly as it was.
					confirmed: true,
					value: {
						success: false,
						status: "rejected" as const,
						bands: [...snapshot.current],
						detail: "the modem refused the band selection",
					},
				};
			}

			const applied = await currentBands(deviceId);
			if (!sameSelection(bands, applied)) {
				return restore(deviceId, preState.bands, "readback_failed", applied);
			}

			if (await waitForRegistration(deviceId, timing)) {
				return {
					confirmed: true,
					value: {
						success: true,
						status: "applied" as const,
						bands: [...applied],
					},
				};
			}

			logger.warn("band lock lost registration within the bound; restoring", {
				module: "modems",
				device: deviceId,
				requested: bands,
				restoring: preState.bands,
			});
			return restore(deviceId, preState.bands, "auto_restored", applied);
		},
	);

	if (!guarded.ok) {
		return { success: false, mutationRefusal: guarded.refusal };
	}
	await refreshBandCapability(deviceId, identity.stableKey).catch(
		() => undefined,
	);
	return guarded.value;
}

/**
 * Put the previous selection back.
 *
 * A restore that lands leaves NOTHING outstanding, so the journal entry is
 * cancelled — holding a device blocked that was just proven to be back at its
 * baseline would be fail-closed theatre, and it is the same rule the router
 * subnet rewrite follows for its `reverted` outcome. A restore that does not
 * land is the one case the journal exists for: the entry is left `failed` and
 * the device stays blocked until an operator acknowledges.
 */
async function restore(
	deviceId: string,
	previous: readonly string[],
	reason: "auto_restored" | "readback_failed",
	observed: readonly string[],
): Promise<{ confirmed: boolean; value: SetBandsOutcome; detail?: string }> {
	const target = previous.length > 0 ? previous : [BAND_ANY];
	const wrote = await writeModemBands(deviceId, target);
	const after = await currentBands(deviceId);
	if (wrote && sameSelection(target, after)) {
		return {
			confirmed: true,
			value: {
				success: false,
				status: reason,
				bands: [...after],
				detail:
					reason === "auto_restored"
						? "the radio did not re-register on the requested bands"
						: `the modem reported ${after.join(", ") || "nothing"} instead`,
			},
		};
	}
	return {
		confirmed: false,
		detail: "the previous band selection could not be restored",
		value: {
			success: false,
			status: "restore_failed",
			bands: [...(after.length > 0 ? after : observed)],
			detail: "the previous band selection could not be restored",
		},
	};
}

/** Whether a modem is currently unlocked, for the read surface. */
export function unlockedFrom(current: readonly string[]): boolean {
	return isUnlockedSelection(current) || current.length === 0;
}

export { getBandCapability };
