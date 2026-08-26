/**
 * The USB-composition-mode switch flow — a PURE, rune-free state machine.
 *
 * A mode switch is the one modem mutation the device cannot confirm through its
 * own RPC reply. The transition physically re-enumerates the modem: ModemManager
 * re-issues its index, the interface name changes, and the device may even cross
 * between adapter classes. So "the RPC said success" and "this modem is now in the
 * mode I asked for" are two different facts, and only the second one may move what
 * the operator sees. RPC success ALONE never flips the displayed mode.
 *
 * The mechanics that make that work, each of which exists because of a specific
 * way the naive version breaks:
 *
 * 1. BASELINE BEFORE DISPATCH. The `modems` feed is read and the pre-switch mode
 *    recorded BEFORE the RPC goes out, so the confirmation compares against what
 *    was true when the operator acted rather than against a later snapshot.
 * 2. A MATCH IS ACCEPTED AT ANY POINT AFTER DISPATCH. The backend fires ONE
 *    immediate re-discovery + broadcast the moment the transition verifies, and
 *    that broadcast can legally beat the RPC reply back to the browser. A match
 *    observed while the RPC is still pending is therefore BUFFERED and consumed at
 *    resolution — drop it and the only later broadcast may be the 30 s poll.
 * 3. THE 20 s BOUND STARTS AT RPC RESOLUTION, NOT AT DISPATCH. The RPC awaits the
 *    whole server-side transaction, which the transition engine bounds with its
 *    own deadlines (including re-enumeration). The post-resolve window therefore
 *    covers ONLY re-discovery + broadcast latency; starting it at dispatch would
 *    time out every healthy switch.
 * 4. THE DEVICE IS MATCHED BY `stable_key`, AND BY NOTHING ELSE. The legacy
 *    numeric id is the MM index the transition itself re-issues, and the ifname
 *    changes with the composition — both name a different device, or no device, by
 *    the time the confirming snapshot lands.
 *
 * The spinner is the ONLY optimistic element. A window that expires renders an
 * honest "still transitioning" band: no flip, and no silent success.
 */

import type {
	Modem,
	ModemList,
	ModemOperationOutcome,
	SetUsbModeFailureReason,
	SetUsbModeOutput,
	SetUsbModeRefusal,
	UsbCompositionMode,
} from "@ceraui/rpc/schemas";

/**
 * How long a RESOLVED switch waits for the confirming `modems` broadcast. Covers
 * re-discovery + broadcast latency only — see rule 3 above.
 */
export const USB_MODE_CONFIRM_WINDOW_MS = 20_000;

export type UsbModeFlowPhase =
	| "idle"
	/** RPC in flight; the whole server-side transaction is still running. */
	| "dispatching"
	/** RPC succeeded; waiting for the confirming broadcast within the window. */
	| "awaiting"
	/** A snapshot proved THIS device reports the target mode. */
	| "confirmed"
	/** The device refused, or the call failed. Nothing was switched. */
	| "refused"
	/** The window elapsed with no confirming snapshot. Never a success claim. */
	| "unconfirmed";

export interface UsbModeFlow {
	readonly phase: UsbModeFlowPhase;
	readonly stableKey: string;
	readonly target: UsbCompositionMode;
	/** The mode this device reported BEFORE the RPC was dispatched. */
	readonly baselineMode: UsbCompositionMode | undefined;
	/** A match seen while the RPC was still pending, consumed at resolution. */
	readonly bufferedMatch: boolean;
	readonly deadlineAt: number | undefined;
	readonly refusal: SetUsbModeRefusal | undefined;
	readonly reason: SetUsbModeFailureReason | undefined;
	/**
	 * The device's own classified outcome, where the reply carried one.
	 *
	 * Retained rather than folded into `phase` because `refused` cannot express
	 * the third answer: a transition whose reply never arrived is `unknown-outcome`
	 * and must not be rendered as a failure. The render site reads the
	 * classification to pick the band; `phase` still drives the spinner and the
	 * displayed mode exactly as before.
	 */
	readonly operation: ModemOperationOutcome | undefined;
}

/** The flow is busy exactly while the spinner should be held. */
export function isUsbModeFlowBusy(flow: UsbModeFlow | undefined): boolean {
	return flow?.phase === "dispatching" || flow?.phase === "awaiting";
}

/**
 * A modem can only take part in this flow when it publishes a `stable_key` —
 * without one there is no identifier that survives the re-enumeration, so the
 * switch could be dispatched but never honestly confirmed. Offering it anyway
 * would guarantee an "unconfirmed" band on every attempt.
 */
export function canTrackUsbModeSwitch(
	modem: Pick<Modem, "stable_key">,
): boolean {
	return typeof modem.stable_key === "string" && modem.stable_key.length > 0;
}

/** Find a modem by `stable_key`. Never by the numeric id, never by ifname. */
export function findModemByStableKey(
	modems: ModemList | undefined,
	stableKey: string,
): Modem | undefined {
	if (!modems || stableKey === "") return undefined;
	for (const modem of Object.values(modems)) {
		if (modem?.stable_key === stableKey) return modem;
	}
	return undefined;
}

export function beginUsbModeFlow(input: {
	stableKey: string;
	target: UsbCompositionMode;
	modems: ModemList | undefined;
}): UsbModeFlow {
	return {
		phase: "dispatching",
		stableKey: input.stableKey,
		target: input.target,
		baselineMode: findModemByStableKey(input.modems, input.stableKey)?.usb_mode,
		bufferedMatch: false,
		deadlineAt: undefined,
		refusal: undefined,
		reason: undefined,
		operation: undefined,
	};
}

/**
 * Fold a `modems` snapshot into the flow. A snapshot in which THIS device reports
 * the target mode confirms an already-resolved switch, and is buffered while the
 * RPC is still pending. Every other phase is inert, so a late broadcast can never
 * resurrect a settled flow.
 */
export function observeUsbModeSnapshot(
	flow: UsbModeFlow,
	modems: ModemList | undefined,
): UsbModeFlow {
	if (flow.phase !== "dispatching" && flow.phase !== "awaiting") return flow;
	const modem = findModemByStableKey(modems, flow.stableKey);
	if (modem?.usb_mode !== flow.target) return flow;

	if (flow.phase === "awaiting") {
		return { ...flow, phase: "confirmed", deadlineAt: undefined };
	}
	// Identity on a repeat observation, so a reactive consumer that writes the
	// result back cannot re-trigger itself on an unchanged snapshot.
	return flow.bufferedMatch ? flow : { ...flow, bufferedMatch: true };
}

/**
 * The RPC resolved. Success does NOT confirm — it only opens the window in which
 * the confirming broadcast is accepted, or consumes a match that already arrived.
 */
export function resolveUsbModeFlow(
	flow: UsbModeFlow,
	result: SetUsbModeOutput | undefined,
	now: number,
): UsbModeFlow {
	if (flow.phase !== "dispatching") return flow;

	if (result === undefined || result.success !== true) {
		return {
			...flow,
			phase: "refused",
			deadlineAt: undefined,
			refusal: result?.error,
			reason: result?.reason,
			operation: result?.operation,
		};
	}

	if (flow.bufferedMatch) {
		return { ...flow, phase: "confirmed", deadlineAt: undefined };
	}
	return {
		...flow,
		phase: "awaiting",
		deadlineAt: now + USB_MODE_CONFIRM_WINDOW_MS,
	};
}

/** The RPC threw (transport failure). Nothing is known to have been switched. */
export function failUsbModeFlow(flow: UsbModeFlow): UsbModeFlow {
	if (flow.phase !== "dispatching") return flow;
	return {
		...flow,
		phase: "refused",
		deadlineAt: undefined,
		refusal: "transition_failed",
		reason: "transaction_error",
		operation: undefined,
	};
}

/** Expire the post-resolve window. Reports "still transitioning", never success. */
export function tickUsbModeFlow(flow: UsbModeFlow, now: number): UsbModeFlow {
	if (flow.phase !== "awaiting" || flow.deadlineAt === undefined) return flow;
	return now >= flow.deadlineAt
		? { ...flow, phase: "unconfirmed", deadlineAt: undefined }
		: flow;
}

/**
 * The mode the card DISPLAYS. It is read from the live feed and falls back to the
 * baseline — never to `flow.target`, which is what makes RPC success alone unable
 * to move it.
 */
export function displayedUsbMode(
	modems: ModemList | undefined,
	stableKey: string,
	flow: UsbModeFlow | undefined,
): UsbCompositionMode | undefined {
	return (
		findModemByStableKey(modems, stableKey)?.usb_mode ?? flow?.baselineMode
	);
}
