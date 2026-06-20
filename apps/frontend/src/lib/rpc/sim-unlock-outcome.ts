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
 *
 * `ok` is the DOMAIN verdict ("was the SIM unlocked?"). `reason` names the
 * non-ok terminal so the dialog can branch; the only reason that should surface
 * a generic failure toast is `"error"` — every other reason is handled inline.
 * Kept rune-free and side-effect-free so it is unit-tested directly.
 */

import type { SimPukUnlockOutput, SimUnlockOutput } from "@ceraui/rpc/schemas";

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
