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
 * The gated USSD module.
 *
 * A USSD SESSION IS A NETWORK-SIDE RESOURCE, which is what every rule here is
 * about. The subscriber gets one at a time, so a session left open by an
 * operator who navigated away fails the NEXT dialogue busy for reasons nothing
 * on screen explains. Three mechanisms cover that: the state machine refuses an
 * illegal verb without dispatching anything, an unanswered session is closed at
 * a bound and the network's side is released best-effort, and a session that
 * reaches a terminal state resets to idle so the next dialogue starts fresh.
 *
 * LEASE-ONLY, NOT JOURNALED, and that classification is enforced by the type
 * system rather than by this comment: `ussd` is absent from
 * `JOURNALED_CAPABILITY_MODULES`, so the request arm taken below cannot carry a
 * `preState`. A USSD dialogue touches no bearer — there is no bond link a
 * rollback would have to restore.
 *
 * THE CARRIER'S TEXT NEVER REACHES A LOG. It is threaded through `ussdReply` /
 * `ussdCommand` / `ussdResponse`, whose NAMES are what the logger's key-based
 * redactor masks on, and no line in this module or in `mmcli-ussd.ts` logs one.
 *
 * THE CAPABILITY CACHE EXISTS BECAUSE THE WIRE BUILD IS SYNCHRONOUS —
 * `buildModemsWireMessage` cannot await an mmcli read, so this follows the
 * `gps.ts` / `band-capability.ts` precedent: an async read writes a snapshot and
 * a sync getter serves it.
 */

import type {
	CapabilityEvidence,
	ModemUssdOutput,
	UssdRefusal,
	UssdSessionSnapshot,
} from "@ceraui/rpc/schemas";

import { IMPLEMENTED_MODEM_CAPABILITY_MODULES } from "./capability-evidence.ts";
import { withCapabilityModuleMutation } from "./capability-mutation.ts";
import {
	cancelUssd,
	initiateUssd,
	readUssdStatus,
	respondUssd,
	type UssdCliRunner,
	type UssdTurnResult,
} from "./mmcli-ussd.ts";
import { defaultResolveIdentity } from "./usb-mode-identity.ts";
import {
	IDLE_USSD_SESSION,
	reduceUssdSession,
	type UssdSessionEvent,
} from "./ussd-session.ts";

/**
 * How long a session may sit open with nobody answering before it is closed.
 *
 * Deliberately shorter than the ~2 minutes a network typically allows: the point
 * is to release OUR claim (and the modem's) before the network drops it out from
 * under us, so the next `initiate` is not refused busy by a session neither side
 * is still tracking.
 */
export const USSD_SESSION_IDLE_TIMEOUT_MS = 90_000;

export type UssdTimerHandle = { cancel(): void };
export type UssdScheduler = (
	delayMs: number,
	run: () => void,
) => UssdTimerHandle;

const defaultScheduler: UssdScheduler = (delayMs, run) => {
	const timer = setTimeout(run, delayMs);
	timer.unref?.();
	return {
		cancel: () => {
			clearTimeout(timer);
		},
	};
};

/**
 * `resolveIdentity` is injected for the same reason `runCli` is: the default
 * reaches a live USB enumerator, and every rule worth pinning here is about the
 * SESSION and the GATE rather than about how a modem id becomes a stable key.
 */
export type ModemUssdDeps = {
	readonly runCli?: UssdCliRunner;
	readonly scheduler?: UssdScheduler;
	readonly resolveIdentity?: (
		deviceId: string,
	) => Promise<{ readonly stableKey: string } | undefined>;
};

const capabilityCache = new Map<string, CapabilityEvidence>();
const sessions = new Map<string, UssdSessionSnapshot>();
const timers = new Map<string, UssdTimerHandle>();

export function resetModemUssdState(): void {
	for (const timer of timers.values()) timer.cancel();
	timers.clear();
	capabilityCache.clear();
	sessions.clear();
}

/** The capability half of the evidence, for `capability-evidence.ts`. */
export function ussdEvidence(
	stableKey: string | undefined,
): CapabilityEvidence {
	if (stableKey === undefined) return "unknown";
	return capabilityCache.get(stableKey) ?? "unknown";
}

function clearTimer(stableKey: string): void {
	timers.get(stableKey)?.cancel();
	timers.delete(stableKey);
}

/**
 * A session reaching `closed` is REPORTED as closed and STORED as idle, so the
 * next `initiate` starts from a fresh machine rather than the terminal one.
 */
function store(stableKey: string, snapshot: UssdSessionSnapshot): void {
	clearTimer(stableKey);
	if (snapshot.state === "closed") {
		sessions.delete(stableKey);
	} else {
		sessions.set(stableKey, snapshot);
	}
}

function currentSession(stableKey: string): UssdSessionSnapshot {
	return sessions.get(stableKey) ?? IDLE_USSD_SESSION;
}

function apply(
	stableKey: string,
	event: UssdSessionEvent,
):
	| { ok: true; snapshot: UssdSessionSnapshot }
	| { ok: false; refusal: UssdRefusal } {
	const transition = reduceUssdSession(currentSession(stableKey), event);
	if (!transition.ok) return { ok: false, refusal: transition.refusal };
	store(stableKey, transition.snapshot);
	return { ok: true, snapshot: transition.snapshot };
}

/**
 * Close an unanswered session at the bound and best-effort release the network's
 * side. Our machine closes FIRST — that outcome is the operator's answer whether
 * or not the release lands, and a modem that stopped answering the dialogue may
 * not answer this either.
 */
function armIdleTimeout(
	stableKey: string,
	deviceId: string,
	deps: ModemUssdDeps,
): void {
	clearTimer(stableKey);
	const scheduler = deps.scheduler ?? defaultScheduler;
	timers.set(
		stableKey,
		scheduler(USSD_SESSION_IDLE_TIMEOUT_MS, () => {
			if (!sessions.has(stableKey)) return;
			apply(stableKey, { kind: "timeout" });
			void cancelUssd(deviceId, deps.runCli).catch(() => undefined);
		}),
	);
}

function settleTurn(
	stableKey: string,
	deviceId: string,
	turn: UssdTurnResult,
	deps: ModemUssdDeps,
): ModemUssdOutput {
	if (!turn.ok) {
		const failed = apply(stableKey, { kind: "failed", reason: turn.reason });
		return {
			success: false,
			error: turn.reason,
			...(failed.ok ? { session: failed.snapshot } : {}),
		};
	}
	const settled = apply(stableKey, {
		kind: "replied",
		sessionState: turn.sessionState,
	});
	if (!settled.ok) {
		return { success: false, error: settled.refusal };
	}
	if (turn.sessionState !== "released") {
		armIdleTimeout(stableKey, deviceId, deps);
	}
	return {
		success: true,
		session: settled.snapshot,
		...(turn.ussdReply === undefined ? {} : { ussdReply: turn.ussdReply }),
	};
}

/**
 * Read the module's state: whether this modem exposes USSD, plus the session it
 * is holding. Takes NO lease — it mutates nothing.
 */
export async function readModemUssd(
	deviceId: string,
	deps: ModemUssdDeps = {},
): Promise<ModemUssdOutput> {
	const identity = await (deps.resolveIdentity ?? defaultResolveIdentity)(
		deviceId,
	);
	if (identity === undefined) {
		return { success: false, error: "unknown_modem" };
	}
	const status = await readUssdStatus(deviceId, deps.runCli);
	if (!status.ok) {
		// Only a positive `unsupported` is evidence about the DEVICE. Every other
		// refusal is a statement about the read, and the ladder stops at `enabled`
		// for `unknown` — surfaced by nothing, mutated by nothing.
		if (status.reason === "unsupported") {
			capabilityCache.set(identity.stableKey, "absent");
		}
		return { success: false, error: status.reason };
	}
	capabilityCache.set(identity.stableKey, "present");
	return { success: true, session: currentSession(identity.stableKey) };
}

type UssdVerb = "initiate" | "respond" | "cancel";

const VERB_EVENT: Readonly<Record<UssdVerb, UssdSessionEvent["kind"]>> = {
	initiate: "initiate",
	respond: "respond",
	cancel: "cancel",
};

/**
 * Run one USSD verb under the capability-module mutation lease.
 *
 * ORDER IS THE CONTRACT: the feature gate and the lease run first (inside
 * `withCapabilityModuleMutation`), then the SESSION machine gates the verb, and
 * only a verb the machine admitted reaches mmcli. A doomed verb therefore costs
 * no network round-trip and cannot disturb a live dialogue.
 */
async function runUssdVerb(
	deviceId: string,
	verb: UssdVerb,
	dispatch: (runCli: UssdCliRunner | undefined) => Promise<UssdTurnResult>,
	deps: ModemUssdDeps,
): Promise<ModemUssdOutput> {
	const identity = await (deps.resolveIdentity ?? defaultResolveIdentity)(
		deviceId,
	);
	if (identity === undefined) {
		return { success: false, error: "unknown_modem" };
	}
	const stableKey = identity.stableKey;

	const guarded = await withCapabilityModuleMutation<ModemUssdOutput>(
		{
			module: "ussd",
			stableKey,
			implemented: IMPLEMENTED_MODEM_CAPABILITY_MODULES,
		},
		async () => {
			const gate = apply(stableKey, {
				kind: VERB_EVENT[verb],
			} as UssdSessionEvent);
			if (!gate.ok) {
				return {
					confirmed: true,
					value: {
						success: false,
						error: gate.refusal,
						session: currentSession(stableKey),
					} satisfies ModemUssdOutput,
				};
			}

			if (verb === "cancel") {
				const cancelled = await cancelUssd(deviceId, deps.runCli);
				const settled = cancelled.ok
					? apply(stableKey, { kind: "cancelled" })
					: apply(stableKey, { kind: "failed", reason: cancelled.reason });
				return {
					confirmed: true,
					value: {
						success: cancelled.ok,
						...(cancelled.ok ? {} : { error: cancelled.reason }),
						...(settled.ok ? { session: settled.snapshot } : {}),
					} satisfies ModemUssdOutput,
				};
			}

			return {
				confirmed: true,
				value: settleTurn(
					stableKey,
					deviceId,
					await dispatch(deps.runCli),
					deps,
				),
			};
		},
	);

	if (!guarded.ok) {
		return { success: false, mutationRefusal: guarded.refusal };
	}
	return guarded.value;
}

export function initiateModemUssd(
	deviceId: string,
	ussdCommand: string,
	deps: ModemUssdDeps = {},
): Promise<ModemUssdOutput> {
	return runUssdVerb(
		deviceId,
		"initiate",
		(runCli) => initiateUssd(deviceId, ussdCommand, runCli),
		deps,
	);
}

export function respondModemUssd(
	deviceId: string,
	ussdResponse: string,
	deps: ModemUssdDeps = {},
): Promise<ModemUssdOutput> {
	return runUssdVerb(
		deviceId,
		"respond",
		(runCli) => respondUssd(deviceId, ussdResponse, runCli),
		deps,
	);
}

export function cancelModemUssd(
	deviceId: string,
	deps: ModemUssdDeps = {},
): Promise<ModemUssdOutput> {
	return runUssdVerb(
		deviceId,
		"cancel",
		() => Promise.resolve({ ok: true, sessionState: "released" }),
		deps,
	);
}
