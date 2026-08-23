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
 * THE FIVE-STATE DONGLE LOCK, AS AN OPERATOR SURFACE — pure and rune-free.
 *
 * Todo 10 put `modem.lock_state` on the wire with EXACTLY five members. This
 * module is the render rule for them, and the two decisions it exists to make
 * are the ones a component would otherwise re-derive per branch and get wrong in
 * one of them:
 *
 *  1. **MAY A PASSWORD BE ASKED FOR AT ALL?** Only where presenting one could
 *     help. `open` is the COMMON case on this fleet — every bench dialect
 *     answered unauthenticated — so a password prompt there is precisely the
 *     dishonesty this effort removes. `unlocked` has nothing to ask for.
 *     `locked-out` must not spend an attempt the operator cannot get back. And a
 *     `locked` row carrying `sub_reason: "unsupported-profile"` is the subtlest
 *     one: the dialect asked for a login shape this build ships no proven
 *     implementation for, so a password would NEVER be sent — offering the field
 *     invites an operator to blame their own typing for a device limitation.
 *  2. **WHICH SENTENCE DOES THE OPERATOR READ?** Six, one per reachable
 *     situation, and the THREE failure causes are three of them:
 *
 *       wrong password        → `auth-failed`
 *       unsupported firmware  → `locked` + `sub_reason: unsupported-profile`
 *       device lockout        → `locked-out`
 *
 *     They call for three different actions — retype it, stop and use the
 *     vendor's page, wait — so folding any pair into one message is a lie about
 *     what to do next.
 *
 * `lockWithholdsCapabilities` is the third rule, and it is not cosmetic. The
 * device's `gateRouterAdminByLock` withholds `router_admin.capabilities` and
 * `router_admin.controls` while a lock stands, so the dialog's existing
 * "nothing here is provably settable" band would otherwise be printed over a
 * device that simply has not been signed in to — a true sentence about the wrong
 * device, which is the same class of defect one layer up.
 *
 * NOTHING HERE HOLDS A CREDENTIAL. There is no password in any type in this
 * file, so a projection cannot leak one by omission and a memoisation cannot
 * retain one by accident.
 */

import type {
	Modem,
	ModemCredentialsRefusal,
	ModemLockDetail,
	ModemLockState,
	ModemLockSubReason,
} from "@ceraui/rpc/schemas";

import { modemRefusalCopyKey } from "./refusal-taxonomy";

/** The i18n stem every key on this surface hangs off. */
export const LOCK_COPY_PREFIX = "network.routerCellular.lock";

/**
 * What the operator is looking at, and what may be offered.
 *
 * `messageKey` is TOTAL over the reachable situations — every state resolves one
 * — because a lock surface that renders nothing for a state is a surface that
 * renders nothing at the exact moment somebody needs to know why.
 */
export interface LockView {
	readonly state: ModemLockState;
	/** The device has a stored login, whether or not it has been accepted. */
	readonly credentialConfigured: boolean;
	readonly subReason?: ModemLockSubReason;
	/** Epoch ms the device's own lockout window is expected to clear. */
	readonly lockoutUntil?: number;
	/** May a password be typed and submitted here? */
	readonly offersEntry: boolean;
	/** May the stored login be removed? A REMOVAL is never a retry — see below. */
	readonly offersClear: boolean;
	/** The one sentence this situation reads as. */
	readonly messageKey: string;
	/** True for the three FAILURE causes, so the band can take the warning tone. */
	readonly isFailure: boolean;
}

/**
 * The lock as this dongle currently reports it, or `undefined` when the device
 * has no admin-auth surface at all.
 *
 * Absence is the MM-managed fleet's answer and the `router_admin`-less answer
 * alike: todo 10 emits both fields only for a row that HAS an admin API, so a
 * missing `lock_state` means "there is no login here to talk about" rather than
 * "we could not read one". Rendering a section for it would put a login control
 * on every cellular modem in the roster.
 */
export function deriveLockView(modem: Modem | undefined): LockView | undefined {
	const state = modem?.lock_state;
	if (state === undefined) return undefined;
	const detail: ModemLockDetail | undefined = modem?.lock_detail;
	const subReason = detail?.sub_reason;
	const configured = detail?.credential_configured === true;

	return {
		state,
		credentialConfigured: configured,
		...(subReason === undefined ? {} : { subReason }),
		...(detail?.lockout_until === undefined
			? {}
			: { lockoutUntil: detail.lockout_until }),
		offersEntry: offersEntryFor(state, subReason),
		// A REMOVAL IS NOT A RETRY. Clearing performs zero device requests, so it
		// spends no attempt against a lockout counter — and while locked out it is
		// the one useful thing an operator can do, because it stops the rejected
		// credential from being presented again on the next cycle. It is offered
		// wherever a credential is actually stored, `locked-out` included; what is
		// withheld there is the ENTRY and its submit, which is what a retry is.
		offersClear: configured,
		messageKey: lockMessageKey(state, subReason),
		isFailure: isFailureState(state, subReason),
	};
}

/**
 * Whether a password field may be rendered.
 *
 * Exported separately from {@link deriveLockView} so the rule can be asserted as
 * a table over all five states rather than only through a rendered component.
 */
export function offersEntryFor(
	state: ModemLockState,
	subReason?: ModemLockSubReason,
): boolean {
	if (state === "open" || state === "unlocked" || state === "locked-out") {
		return false;
	}
	// `locked` + `auth-failed` are the two states a credential can still change —
	// unless the dialect already told us the shape is one we cannot perform.
	return subReason !== "unsupported-profile";
}

/** The one sentence, keyed. Six reachable situations, six keys. */
export function lockMessageKey(
	state: ModemLockState,
	subReason?: ModemLockSubReason,
): string {
	if (state === "locked" && subReason === "unsupported-profile") {
		return `${LOCK_COPY_PREFIX}.cause.unsupportedProfile`;
	}
	switch (state) {
		case "auth-failed":
			return `${LOCK_COPY_PREFIX}.cause.authFailed`;
		case "locked-out":
			return `${LOCK_COPY_PREFIX}.cause.lockedOut`;
		default:
			return `${LOCK_COPY_PREFIX}.state.${state}`;
	}
}

/** The three failure causes, and nothing else. */
export function isFailureState(
	state: ModemLockState,
	subReason?: ModemLockSubReason,
): boolean {
	return (
		state === "auth-failed" ||
		state === "locked-out" ||
		(state === "locked" && subReason === "unsupported-profile")
	);
}

/**
 * Whether this lock is why the dongle's capability and control blocks are
 * absent.
 *
 * `open` and `unlocked` are the two states the device serves them in; every
 * other state means `gateRouterAdminByLock` withheld them, so the surface must
 * say THAT rather than "nothing here is provably settable".
 */
export function lockWithholdsCapabilities(
	view: LockView | undefined,
): view is LockView {
	if (view === undefined) return false;
	return view.state !== "open" && view.state !== "unlocked";
}

/**
 * Minutes left on the device's own lockout window, rounded UP, or `undefined`
 * when the device did not say.
 *
 * Rounded up and floored at 1 because a wait rendered as "0 min" reads as "try
 * now", which is the one thing this state exists to stop. A window that has
 * already elapsed answers `undefined` too — the device has not re-reported yet,
 * and inventing "it is over" from our own clock would be a claim about a counter
 * only the dongle can see.
 */
export function lockoutRemainingMinutes(
	lockoutUntil: number | undefined,
	now: number,
): number | undefined {
	if (lockoutUntil === undefined || !Number.isFinite(lockoutUntil)) {
		return undefined;
	}
	const remainingMs = lockoutUntil - now;
	if (remainingMs <= 0) return undefined;
	return Math.max(1, Math.ceil(remainingMs / 60_000));
}

/**
 * Keyed copy for a typed credential refusal — never the raw wire token.
 *
 * The nine typed refusals resolve through the shared taxonomy, which is a total
 * table rather than the interpolation this used to be: a tenth
 * `modemCredentialsRefusalSchema` member now fails the build instead of
 * rendering its own dotted path at an operator.
 *
 * `undefined` deliberately keeps a LOCAL key. It is reached when the transport
 * gave out before the device answered anything, so it is OUR fallback and must
 * not borrow a device claim from the shared table.
 */
export function lockErrorKey(
	error: ModemCredentialsRefusal | undefined,
): string {
	return error === undefined
		? `${LOCK_COPY_PREFIX}.error.generic`
		: modemRefusalCopyKey(error);
}
