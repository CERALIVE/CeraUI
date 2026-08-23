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
 * WHAT THIS DEVICE CAN SAY ABOUT A RADIO'S POWER, AND WHAT IT CANNOT DO TO IT.
 *
 * The READING half of `ModemConfigDialog` lives in `modem-detail.ts`; this is
 * the POWER/RECOVERY half, and it is pure and rune-free for the same reason
 * `router-dongle-actions.ts` is: whether an operation may be offered has to be
 * assertable without mounting a dialog.
 *
 * ── THE POWER STATE IS A READING, AND THERE IS NO WRITE UNDER IT ────────────
 *
 * `@ceralive/modem-control` publishes `power` as a `ContextReadOperation<
 * RadioPower>` — a read, with no setter beside it and no concrete reset
 * operation anywhere in the package. So this module deliberately exports NO
 * dispatchable shape at all: `RadioPowerReading` is a value plus the keys used
 * to render it, and {@link PowerUnavailableOperation} is `{id, titleKey,
 * reasonKey}` and nothing else. There is no slot a control could occupy, which
 * is a stronger guarantee than a comment asking future callers not to add one.
 *
 * ── WHY THE UNAVAILABLE OPERATIONS ARE STATED RATHER THAN OMITTED ───────────
 *
 * An operator who came looking for a power switch — every phone has one, and so
 * does the vendor's own tooling — must be told this device will not offer one,
 * and why. Omitting the row leaves them hunting through a dialog that simply
 * never mentions power. This is the same argument, and the same shape, as
 * `ROUTER_UNAVAILABLE_OPERATIONS`.
 *
 * The USB hub entry is the one worth spelling out. The control package ships
 * `UhubctlPort` as a PORT — an interface with no implementation, no provider and
 * no argv builder — and the adapter that satisfies it lives in the bench CLI, not
 * on a device. Hub power-cycling is therefore a drill tool, and a customer device
 * has no guarantee of a controllable hub at all; offering the control here would
 * be an affordance that fails on click for most of the fleet.
 *
 * ── THE ONE RECOVERY THIS DEVICE REALLY PERFORMS ────────────────────────────
 *
 * `decideModemReactivation` → `applyModemConfig` re-establishes the bearer, and
 * it is reached by SAVING a connect-time setting rather than by a button of its
 * own — NetworkManager cannot hand a live bearer new gsm values, so the save IS
 * the recovery. Its destructive confirmation therefore already lives beside the
 * connection fields (`modem-reconnect-notice`), which is why this module points
 * at that path instead of minting a second one that would need its own
 * confirmation and could disagree with the first.
 */

import type { ModemConfigRefusal, ModemRadioPower } from "@ceraui/rpc/schemas";

import type { MutationOutcomeKind } from "$lib/modem/mutation-outcome";

const POWER = "network.modem.power";

/** How the radio's power state renders. There is no companion write. */
export interface RadioPowerReading {
	/** The device's own answer, verbatim. */
	readonly state: ModemRadioPower;
	/** i18n dot-path key for the operator's word for {@link state}. */
	readonly labelKey: string;
	/** i18n dot-path key stating WHERE the reading came from, and that it is read-only. */
	readonly provenanceKey: string;
}

/**
 * The radio's power state, or `undefined` when this device published none.
 *
 * ABSENCE AND `unknown` ARE DIFFERENT ANSWERS AND MUST NOT COLLAPSE. `unknown`
 * is the modem stating it does not know its own power state; absence is the
 * device reporting no power state at all, which is every `router-ethernet`
 * dongle (its embedded router hides the radio) and every backend older than the
 * field. Rendering absence as `unknown` would put a modem's words in the mouth
 * of a device that never spoke.
 */
export function radioPowerReading(
	radioPower: ModemRadioPower | undefined,
): RadioPowerReading | undefined {
	if (radioPower === undefined) return undefined;
	return {
		state: radioPower,
		labelKey: `${POWER}.state.${radioPower}`,
		provenanceKey: `${POWER}.provenance`,
	};
}

/** One power/recovery operation this build ships no write for, and why. */
export type PowerUnavailableOperation = {
	readonly id: string;
	/** i18n dot-path key — the operator's name for the operation. */
	readonly titleKey: string;
	/** i18n dot-path key — WHY it is unavailable, in the operator's own terms. */
	readonly reasonKey: string;
};

/**
 * The power/recovery operations a modem does NOT get here, stated rather than
 * omitted.
 *
 * Frozen because it describes the SHIPPED STACK, not the device in front of the
 * operator: the package exposes no radio-power write and no reset for ANY
 * modem, and `UhubctlPort` has no injected adapter on ANY device, so a
 * per-device variation would imply an evidence source that does not exist.
 *
 * Deliberately absent from this list: EDL, firmware and every other prohibited
 * recovery path. They are inert fences in the control library
 * (`ufi-himi/prohibitions.ts`) and naming them on an operator surface would
 * advertise a route this product does not have and will not grow.
 */
export const POWER_UNAVAILABLE_OPERATIONS: readonly PowerUnavailableOperation[] =
	Object.freeze([
		Object.freeze({
			id: "radio-power",
			titleKey: `${POWER}.unavailable.toggle.title`,
			reasonKey: `${POWER}.unavailable.toggle.reason`,
		}),
		Object.freeze({
			id: "modem-reset",
			titleKey: `${POWER}.unavailable.reset.title`,
			reasonKey: `${POWER}.unavailable.reset.reason`,
		}),
		Object.freeze({
			id: "hub-power",
			titleKey: `${POWER}.unavailable.hub.title`,
			reasonKey: `${POWER}.unavailable.hub.reason`,
		}),
	]);

/**
 * How a recovery attempt is reported, folded onto `MutationOutcomeBand`'s kinds.
 *
 * There is deliberately NO `applied` arm. A confirmed save closes the dialog —
 * the echo predicate proves the device stored what was sent — so a success
 * sentence here would be copy nothing can render, and an unused string is one
 * more thing for ten catalogs to drift on. The two arms that DO reach an
 * operator are the two this surface exists for.
 *
 * `unknown` is the one that carries weight: the device accepted the write and
 * never echoed it back, so nothing about the bearer can be asserted in either
 * direction. `refused` would claim the previous settings are intact and
 * `applied` would claim the new ones are.
 */
export interface RecoveryOutcomeView {
	readonly kind: MutationOutcomeKind;
	/** i18n dot-path key for the sentence. */
	readonly key: string;
	/** Whether the operator is offered a reconcile, i.e. a re-check. */
	readonly reconcilable: boolean;
}

const REFUSAL = "network.modem.saveRefused";

/**
 * Turn the save path's own answer into an outcome the band can render.
 *
 * The refusal token is keyed rather than interpolated into one generic
 * sentence: `streaming_active` ("stop the stream"), `mutation_blocked` ("resolve
 * the earlier change") and `write_failed` ("read the logs") are three different
 * things for an operator to do, and a recovery that re-establishes a bearer is
 * exactly the operation a running stream must refuse.
 */
export function recoveryOutcome(
	result:
		| { readonly status: "refused"; readonly refusal: ModemConfigRefusal }
		| { readonly status: "unconfirmed" },
): RecoveryOutcomeView {
	if (result.status === "refused") {
		return {
			kind: "refused",
			key: `${REFUSAL}.${result.refusal}`,
			reconcilable: false,
		};
	}
	return {
		kind: "unknown",
		key: "network.modem.saveUnconfirmedBody",
		reconcilable: true,
	};
}

/**
 * Whether a refusal means "a stream is in the way" rather than "the device is
 * broken".
 *
 * The streaming interlock is the reason this is worth naming separately: the
 * operator's next action is to stop the stream, which is theirs to take, and a
 * surface that folded it into a generic failure would send them looking for a
 * fault that does not exist.
 */
export function isStreamingRecoveryRefusal(
	refusal: ModemConfigRefusal | undefined,
): boolean {
	return refusal === "streaming_active";
}
