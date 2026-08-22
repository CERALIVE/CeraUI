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

/*
  THE FIVE-STATE DEVICE LOCK MODEL — pure resolution plus the session it needs.

  Todo 7 persisted a credential and the OUTCOME of the last attempt; this module
  decides what an operator is actually looking at right now, and gates which
  admin operations a row may offer while they are looking at it.

  ── `open` IS DETECTED, NEVER ASSUMED ─────────────────────────────────────

  Every dongle on this bench answered its admin API unauthenticated, so `open` is
  the COMMON case and rendering a password prompt at one of them is exactly the
  dishonesty this surface exists to remove. But "nobody refused us" is not
  evidence of "no login is required" — a refusal can also be a read that never
  happened. Only a protocol that STATES it counts:

    - HiLink publishes `/api/user/state-login`, whose `<State>` answers this
      question directly on a FRESH session: `0` means the API is already usable
      with no credential presented (open), `-1` means a login is required.
    - ZTE goform and Qualcomm HIMI publish no equivalent document, so they
      resolve `locked` rather than guessing `open`.

  ── `protocol-mismatch` IS NOT `auth-failed` ──────────────────────────────

  Todo 6's ZTE session classifies a refusal as `lockout`, `auth-rejection`,
  `protocol-mismatch` or `auth-accepted`. Three of those map onto a lock state
  directly. `protocol-mismatch` does not: the device answered a shape this build
  ships no proven login for, so the credential was never presented and calling it
  `auth-failed` would tell an operator their password is wrong. It resolves
  `locked` carrying the distinct `unsupported-profile` sub-reason instead.

  ── THE SESSION IS IN MEMORY, AND THAT IS THE DEFINITION ──────────────────

  `unlocked` means "verified THIS SESSION", so it cannot come off disk. Todo 7's
  persisted `lastOutcome` survives a reboot and is the right shape for "the last
  thing this credential did"; a boot that has presented nothing has unlocked
  nothing, so the session map starts empty exactly like `dongle-admin-session.ts`.
*/

import type {
	ModemLockDetail,
	ModemLockState,
	ModemLockSubReason,
	RouterAdmin,
} from "@ceraui/rpc/schemas";
import { MODEM_LOCK_STATES as WIRE_LOCK_STATES } from "@ceraui/rpc/schemas";
import { xmlValue } from "../network/vendor-xml.ts";
import type { ModemCredentialStatus } from "./modem-credentials.ts";
import { MODEM_LOCK_STATES } from "./modem-credentials.ts";

/**
 * The device-local store's vocabulary and the wire's must stay element-equal.
 * `packages/rpc` cannot import from `apps/`, so the two arrays are a deliberate
 * Rule-D mirror; this is the assertion that keeps them honest at import time
 * rather than at review time.
 */
if (MODEM_LOCK_STATES.join("|") !== WIRE_LOCK_STATES.join("|")) {
	throw new Error(
		"modem lock states diverged between the credential store and the wire",
	);
}

/** Todo 6's ZTE session vocabulary, which every dialect's login maps onto. */
export type AuthAttemptDetail =
	| "auth-accepted"
	| "auth-rejection"
	| "protocol-mismatch"
	| "lockout";

export interface LockClassification {
	readonly state: ModemLockState;
	readonly subReason?: ModemLockSubReason;
}

export function classifyAuthAttempt(
	detail: AuthAttemptDetail,
): LockClassification {
	switch (detail) {
		case "auth-accepted":
			return { state: "unlocked" };
		case "auth-rejection":
			return { state: "auth-failed" };
		case "lockout":
			return { state: "locked-out" };
		case "protocol-mismatch":
			return { state: "locked", subReason: "unsupported-profile" };
	}
}

/**
 * Read HiLink's `/api/user/state-login` as the open-vs-locked answer it is.
 *
 * `undefined` for anything else, including an absent or unrecognised `<State>`:
 * a document we could not read is a statement about the READ, and the caller
 * resolves `locked` for it rather than claiming a device needs no password.
 */
export function classifyHilinkLoginState(
	body: string,
): "open" | "locked" | undefined {
	const state = xmlValue(body, "State");
	if (state === "0") return "open";
	if (state === "-1") return "locked";
	return undefined;
}

/** Only these two states mean an authenticated admin operation may be offered. */
export function lockPermitsAuthenticatedOperations(
	state: ModemLockState,
): boolean {
	return state === "open" || state === "unlocked";
}

interface LockSession {
	readonly state: ModemLockState;
	readonly subReason?: ModemLockSubReason;
	readonly at: number;
	readonly lockoutUntil?: number;
}

/** How long a device-reported lockout is honoured when it named no window. */
export const DEFAULT_LOCKOUT_WINDOW_MS = 5 * 60_000;

const sessions = new Map<string, LockSession>();

export function noteLockOutcome(
	identityKey: string,
	classification: LockClassification,
	now: number = Date.now(),
	lockoutUntil?: number,
): void {
	sessions.set(identityKey, {
		state: classification.state,
		...(classification.subReason !== undefined
			? { subReason: classification.subReason }
			: {}),
		at: now,
		...(classification.state === "locked-out"
			? { lockoutUntil: lockoutUntil ?? now + DEFAULT_LOCKOUT_WINDOW_MS }
			: {}),
	});
}

export function forgetLockSession(identityKey: string): void {
	sessions.delete(identityKey);
}

/**
 * The dialect's own answer to "is a login required", keyed by INTERFACE.
 *
 * Keyed on the interface rather than the identity because that is what the read
 * cycle holds when it observes it, and it is a same-moment observation rather
 * than a durable property of the unit. An UNANSWERABLE read DROPS the entry
 * rather than retaining it: `open` is the only value that widens what a row
 * offers, so a claim we can no longer support must be withdrawn, and the floor
 * it falls back to (`locked`) withholds rather than offers.
 */
const openEvidence = new Map<string, "open" | "locked">();

export function noteLockOpenEvidence(
	ifname: string,
	evidence: "open" | "locked" | undefined,
): void {
	if (evidence === undefined) {
		openEvidence.delete(ifname);
		return;
	}
	openEvidence.set(ifname, evidence);
}

export function readLockOpenEvidence(
	ifname: string,
): "open" | "locked" | undefined {
	return openEvidence.get(ifname);
}

export function resetModemLockSessionsForTest(): void {
	sessions.clear();
	openEvidence.clear();
}

/**
 * Is this device currently inside a lockout window it reported itself?
 *
 * The verify path asks this BEFORE it opens a transport, so a locked-out device
 * costs zero requests — presenting a credential during a lockout is what spends
 * the attempts that lengthen it.
 */
export function lockoutRemainingMs(
	identityKey: string,
	now: number = Date.now(),
): number | undefined {
	const session = sessions.get(identityKey);
	if (session?.lockoutUntil === undefined) return undefined;
	const remaining = session.lockoutUntil - now;
	return remaining > 0 ? remaining : undefined;
}

export interface LockResolutionInput {
	readonly identityKey: string;
	/** What the dialect's own protocol STATED, when it can state it. */
	readonly openEvidence?: "open" | "locked" | undefined;
	readonly credential: ModemCredentialStatus;
	readonly now?: number;
}

export interface ResolvedModemLock {
	readonly state: ModemLockState;
	readonly detail: ModemLockDetail;
}

/**
 * Resolve the one state a row is in, strongest evidence first.
 *
 * The ORDER is the contract. A live lockout outranks everything because it is
 * the only state that forbids an action rather than describing one, and an
 * `open` device can never have produced a lockout record in the first place.
 * Positive open evidence then outranks any session history: a device that
 * currently states it needs no login needs none, whatever was tried at it
 * earlier. Everything below that is the session's own last word, and a device
 * that has said nothing at all is `locked` — the honest floor.
 */
export function resolveModemLock(
	input: LockResolutionInput,
): ResolvedModemLock {
	const now = input.now ?? Date.now();
	const session = sessions.get(input.identityKey);
	const configured = input.credential.configured;

	const remainingLockout = lockoutRemainingMs(input.identityKey, now);
	if (remainingLockout !== undefined && session?.lockoutUntil !== undefined) {
		return {
			state: "locked-out",
			detail: {
				credential_configured: configured,
				lockout_until: session.lockoutUntil,
			},
		};
	}

	if (input.openEvidence === "open") {
		return { state: "open", detail: { credential_configured: configured } };
	}

	const state = session?.state ?? "locked";
	const resolved: ModemLockState = state === "locked-out" ? "locked" : state;
	return {
		state: resolved,
		detail: {
			credential_configured: configured,
			...(session?.subReason !== undefined
				? { sub_reason: session.subReason }
				: {}),
			...(input.credential.lastVerifiedAt !== undefined
				? { last_verified_at: input.credential.lastVerifiedAt }
				: {}),
		},
	};
}

/**
 * Withhold the admin operations that need a session the device has not granted.
 *
 * This is the capability-expansion seam, and it runs through the EXISTING wire
 * surface rather than a new one: `capabilities` and `controls` are the two
 * blocks that describe what an operator may DO to the dongle, so a row that
 * cannot authenticate offers neither, and the same row offers both the moment a
 * verify lands. Everything else on the block — the admin URL, the model, the SIM
 * and signal readings — is untouched, because those are observations rather than
 * operations and withholding them would report a reachable device as unreadable.
 *
 * Today's fleet detects as `open`, so this returns the reading byte-unchanged
 * for every device currently on the bench.
 */
export function gateRouterAdminByLock(
	admin: RouterAdmin,
	state: ModemLockState,
): RouterAdmin {
	if (lockPermitsAuthenticatedOperations(state)) return admin;
	const { capabilities: _capabilities, controls: _controls, ...rest } = admin;
	return rest;
}
