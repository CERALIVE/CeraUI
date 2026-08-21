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
 * BOUNDED CONFIRMATION FOR A ROUTER-DONGLE WRITE — a PURE, rune-free machine,
 * the sibling of `usb-mode-flow.ts` and built on the same three rules.
 *
 * `RouterDongleDialog` is PESSIMISTIC by construction: nothing on screen moves
 * when the operator taps a control, because the whole reason that surface exists
 * is that this class of device accepts requests it does not apply. The switch
 * moves only when the backend has re-read the dongle and broadcast the new
 * value.
 *
 * That is the right posture and it had one hole: **the wait had no bound**. If
 * the confirming broadcast never arrived — the poll cycle missed it, the session
 * expired mid-cycle, the socket dropped and re-seeded from a snapshot taken
 * before the write — the dialog simply stopped spinning and presented a surface
 * indistinguishable from one where nothing had ever been attempted. The outcome
 * itself was a TOAST, so by the time an operator looked back at the unmoved
 * switch the only record of the attempt had already expired.
 *
 * ── THE THREE RULES ─────────────────────────────────────────────────────────
 *
 * 1. **THE OBSERVATION IS THE AUTHORITY, NOT THE REPLY.** `setRouterControl`
 *    resolves `success` only after the backend re-read the device, so the reply
 *    is honest — but it is not what the operator is looking at. This flow
 *    therefore confirms on the BROADCAST value alone, which keeps the band and
 *    the switch in lockstep: "applied" appears exactly when the control moves,
 *    never a beat before it. Deliberately, `result.controls` is NOT consumed as
 *    a confirming read; doing so would let the band claim applied while the
 *    switch still showed the old value, which is the contradiction the
 *    pessimistic design exists to prevent.
 *
 * 2. **A MATCH IS ACCEPTED AT ANY POINT AFTER DISPATCH.** The backend
 *    re-broadcasts as soon as it has verified, and that frame can legally beat
 *    the RPC reply back to the browser. A match seen while the RPC is still
 *    pending is BUFFERED and consumed at resolution — drop it and the next
 *    chance is the periodic poll, i.e. an "unknown outcome" reported for a write
 *    that demonstrably landed.
 *
 * 3. **THE BOUND STARTS AT RPC RESOLUTION.** The RPC awaits a live HTTP round
 *    trip to a device on the far side of a USB link plus the backend's own
 *    read-back, so the post-resolve window covers only broadcast latency.
 *    Arming it at dispatch would time out healthy writes.
 *
 * The window expiring is NOT a failure. It produces `unconfirmed`, which the
 * dialog renders as the reconciliation-pending outcome — never as a success, and
 * never as a refusal, because neither is known to be true.
 */

import type {
	RouterAdmin,
	RouterAdminControls,
	SetRouterControlOutput,
	SetRouterNetModeOutput,
} from "@ceraui/rpc/schemas";

/**
 * How long a RESOLVED write waits for the confirming `modems` broadcast.
 *
 * Shorter than the USB-mode window (20 s) because nothing re-enumerates here —
 * this covers broadcast latency over an already-verified write, not a device
 * transition. Long enough to clear the backend's own re-discovery, short enough
 * that an operator is not left watching a control that will never move.
 */
export const ROUTER_WRITE_CONFIRM_WINDOW_MS = 15_000;

export type RouterControlId = keyof RouterAdminControls;

export type RouterWriteTarget =
	| {
			readonly kind: "control";
			readonly control: RouterControlId;
			readonly value: boolean;
	  }
	| { readonly kind: "net-mode"; readonly mode: string };

export type RouterWritePhase =
	/** RPC in flight — the HTTP round trip and the backend's read-back. */
	| "dispatching"
	/** RPC succeeded; waiting for the confirming broadcast within the window. */
	| "awaiting"
	/** A broadcast proved the DEVICE now reports the requested value. */
	| "applied"
	/** The device said no. Nothing changed, and we know that. */
	| "refused"
	/** The window elapsed with no confirming broadcast. Never a success claim. */
	| "unconfirmed";

export interface RouterWriteFlow {
	readonly phase: RouterWritePhase;
	readonly target: RouterWriteTarget;
	/** A match seen while the RPC was still pending, consumed at resolution. */
	readonly bufferedMatch: boolean;
	readonly deadlineAt: number | undefined;
	/** The device's own typed refusal, resolved to copy by the render site. */
	readonly error: string | undefined;
	/** The vendor's own error code, where the refusal carried one. */
	readonly code: string | undefined;
}

/** The flow is busy exactly while the row's spinner/lockout should be held. */
export function isRouterWriteBusy(flow: RouterWriteFlow | undefined): boolean {
	return flow?.phase === "dispatching" || flow?.phase === "awaiting";
}

/** Whether two targets name the same control or the same mode selection. */
export function isSameRouterWriteTarget(
	a: RouterWriteTarget,
	b: RouterWriteTarget,
): boolean {
	if (a.kind === "control" && b.kind === "control") {
		return a.control === b.control && a.value === b.value;
	}
	if (a.kind === "net-mode" && b.kind === "net-mode") return a.mode === b.mode;
	return false;
}

/**
 * Does the device, as most recently observed, report the requested value?
 *
 * Absence is never a match. A dongle that stopped publishing `controls`, or
 * whose capability read came back `unavailable`, has told us nothing about the
 * write — and reading "nothing" as "applied" is the whole defect class.
 */
export function routerWriteObserved(
	admin: RouterAdmin | undefined,
	target: RouterWriteTarget,
): boolean {
	if (admin === undefined) return false;
	if (target.kind === "control") {
		return admin.controls?.[target.control] === target.value;
	}
	const capability = admin.capabilities?.net_mode;
	if (capability === undefined || capability.state !== "reported") return false;
	return capability.current === target.mode;
}

export function beginRouterWrite(target: RouterWriteTarget): RouterWriteFlow {
	return {
		phase: "dispatching",
		target,
		bufferedMatch: false,
		deadlineAt: undefined,
		error: undefined,
		code: undefined,
	};
}

/**
 * Fold an observation into the flow.
 *
 * Every settled phase is inert, so a late broadcast can neither resurrect a
 * refused write nor silently upgrade an `unconfirmed` one into a success — once
 * the operator has been told the outcome is unknown, the honest repair is a
 * fresh read, not a retroactive edit of what they were told.
 */
export function observeRouterWrite(
	flow: RouterWriteFlow,
	admin: RouterAdmin | undefined,
): RouterWriteFlow {
	if (flow.phase !== "dispatching" && flow.phase !== "awaiting") return flow;
	if (!routerWriteObserved(admin, flow.target)) return flow;

	if (flow.phase === "awaiting") {
		return { ...flow, phase: "applied", deadlineAt: undefined };
	}
	// Identity on a repeat observation, so a reactive consumer that writes the
	// result back cannot re-trigger itself on an unchanged snapshot.
	return flow.bufferedMatch ? flow : { ...flow, bufferedMatch: true };
}

/**
 * The RPC resolved. Success does NOT confirm — it opens the window in which the
 * confirming broadcast is accepted, or consumes a match that already arrived.
 */
export function resolveRouterWrite(
	flow: RouterWriteFlow,
	result: SetRouterControlOutput | SetRouterNetModeOutput | undefined,
	now: number,
): RouterWriteFlow {
	if (flow.phase !== "dispatching") return flow;

	if (result === undefined || result.success !== true) {
		return {
			...flow,
			phase: "refused",
			deadlineAt: undefined,
			error: result?.error ?? result?.mutationRefusal,
			code: result !== undefined && "code" in result ? result.code : undefined,
		};
	}

	if (flow.bufferedMatch) {
		return { ...flow, phase: "applied", deadlineAt: undefined };
	}
	return {
		...flow,
		phase: "awaiting",
		deadlineAt: now + ROUTER_WRITE_CONFIRM_WINDOW_MS,
	};
}

/** The RPC threw. The dongle's web interface never answered us. */
export function failRouterWrite(flow: RouterWriteFlow): RouterWriteFlow {
	if (flow.phase !== "dispatching") return flow;
	return {
		...flow,
		phase: "refused",
		deadlineAt: undefined,
		error: "unreachable",
		code: undefined,
	};
}

/** Expire the post-resolve window. Reports "not confirmed", never success. */
export function tickRouterWrite(
	flow: RouterWriteFlow,
	now: number,
): RouterWriteFlow {
	if (flow.phase !== "awaiting" || flow.deadlineAt === undefined) return flow;
	return now >= flow.deadlineAt
		? { ...flow, phase: "unconfirmed", deadlineAt: undefined }
		: flow;
}
