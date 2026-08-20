/**
 * sim-unlock-outcome.ts — pure classifiers for SIM PIN / PUK unlock results.
 *
 * Unlike scan/configure, the SIM unlock RPCs are SYNCHRONOUS: `rpc.modems.unlockSim`
 * and `rpc.modems.unlockSimPuk` await mmcli and return the REAL terminal result
 * in the RPC body — there is no follow-up broadcast to confirm against. So the
 * dialog dispatches them through `osCommand` with `confirmOnResolve: true` and
 * uses these classifiers to map the result onto the inline UI transition:
 *
 *   PIN:  success → ok          wrong-pin → inline error (+ attempts)
 *         puk-required → PUK sub-form          no-locked-modem → close
 *   PUK:  success → ok          wrong-puk → inline error (+ attempts)
 *         locked → terminal lockout            no-locked-modem → close
 *   PIN2: success → ok          wrong-pin2 → inline error (+ attempts)
 *         puk2-required → terminal             no-pin2-lock → close
 *         unsupported → terminal (no PIN2 route on this modem)
 *
 * `ok` is the DOMAIN verdict ("was the SIM unlocked?"). `reason` names the
 * non-ok terminal so the dialog can branch; the only reason that should surface
 * a generic failure toast is `"error"` — every other reason is handled inline.
 * Kept rune-free and side-effect-free so it is unit-tested directly.
 */

import type {
	SimPin2UnlockOutput,
	SimPukUnlockOutput,
	SimUnlockOutput,
} from "@ceraui/rpc/schemas";

/** A SIM unlock domain verdict: unlocked, or a named non-ok terminal. */
export interface SimUnlockClassification {
	ok: boolean;
	reason?: string;
}

/** Map a SIM PIN unlock result onto its domain verdict. */
export function classifySimPinResult(
	result: SimUnlockOutput,
): SimUnlockClassification {
	switch (result.state) {
		case "success":
			return { ok: true };
		case "wrong-pin":
			return { ok: false, reason: "wrong-pin" };
		case "puk-required":
			return { ok: false, reason: "puk-required" };
		case "no-locked-modem":
			return { ok: false, reason: "no-locked-modem" };
		default:
			return { ok: false, reason: "error" };
	}
}

/**
 * Map a SIM PIN2 verification result onto its domain verdict.
 *
 * `unsupported` is classified NON-ok but is deliberately NOT `"error"`: it is a
 * settled fact about the modem (no QMI route to PIN2 on this device), so the
 * dialog states it inline and withdraws the form instead of surfacing a failure
 * toast that invites a retry which can only fail the same way.
 */
export function classifySimPin2Result(
	result: SimPin2UnlockOutput,
): SimUnlockClassification {
	switch (result.state) {
		case "success":
			return { ok: true };
		case "wrong-pin2":
			return { ok: false, reason: "wrong-pin2" };
		case "puk2-required":
			return { ok: false, reason: "puk2-required" };
		case "no-pin2-lock":
			return { ok: false, reason: "no-pin2-lock" };
		case "unsupported":
			return { ok: false, reason: "unsupported" };
		default:
			return { ok: false, reason: "error" };
	}
}

/** Map a SIM PUK unlock result onto its domain verdict. */
export function classifySimPukResult(
	result: SimPukUnlockOutput,
): SimUnlockClassification {
	if (result.success) {
		return { ok: true };
	}
	switch (result.error) {
		case "wrong-puk":
			return { ok: false, reason: "wrong-puk" };
		case "locked":
			return { ok: false, reason: "locked" };
		case "no-locked-modem":
			return { ok: false, reason: "no-locked-modem" };
		default:
			return { ok: false, reason: "error" };
	}
}
