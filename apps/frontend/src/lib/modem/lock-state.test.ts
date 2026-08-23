/**
 * THE FIVE-STATE LOCK, AS A TABLE.
 *
 * `modem-lock.ts` makes three decisions a component would otherwise re-derive
 * per branch, and the whole point of extracting them is that all five states —
 * plus the `unsupported-profile` sub-reason, which is a SIXTH situation inside
 * `locked` — can be swept here rather than only through a rendered dialog:
 *
 *   1. may a password be asked for at all;
 *   2. which of the six sentences the operator reads (and the THREE failure
 *      causes are three DISTINCT ones);
 *   3. whether this lock is why the dongle's capability/control blocks are gone.
 *
 * The state list is DERIVED from `MODEM_LOCK_STATES`, never re-typed, so a sixth
 * wire state reddens this file until it has been dispositioned rather than
 * silently falling through a `default`.
 */

import {
	MODEM_LOCK_STATES,
	type Modem,
	type ModemLockState,
	modemCredentialsRefusalSchema,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	deriveLockView,
	isFailureState,
	lockErrorKey,
	lockMessageKey,
	lockoutRemainingMinutes,
	lockWithholdsCapabilities,
	offersEntryFor,
} from "./lock-state";

function modem(
	lock_state: ModemLockState,
	detail?: Modem["lock_detail"],
): Modem {
	return {
		ifname: "eth1",
		name: "Huawei E3372",
		lock_state,
		...(detail === undefined ? {} : { lock_detail: detail }),
	} as unknown as Modem;
}

describe("a device with no admin-auth surface renders nothing at all", () => {
	it("answers undefined when the wire carries no lock state", () => {
		expect(
			deriveLockView({ ifname: "wwan0" } as unknown as Modem),
		).toBeUndefined();
		expect(deriveLockView(undefined)).toBeUndefined();
	});

	it("…and that absence is NOT a withheld capability", () => {
		// The MM-managed fleet has no login to talk about, so the dongle dialog's
		// "signed out" band must never be printed over one.
		expect(lockWithholdsCapabilities(undefined)).toBe(false);
	});
});

describe("a password may be asked for ONLY where presenting one could help", () => {
	const OFFERS: Record<ModemLockState, boolean> = {
		open: false,
		locked: true,
		unlocked: false,
		"auth-failed": true,
		"locked-out": false,
	};

	it.each(MODEM_LOCK_STATES)("%s", (state) => {
		expect(offersEntryFor(state)).toBe(OFFERS[state]);
	});

	it("`open` is the COMMON case, and it never prompts", () => {
		// Every bench dialect answered unauthenticated. A prompt at one of them is
		// the exact dishonesty this surface exists to remove.
		const view = deriveLockView(
			modem("open", { credential_configured: false }),
		);
		expect(view?.offersEntry).toBe(false);
	});

	it("`unsupported-profile` withholds the field even though the state is `locked`", () => {
		// The dialect asked for a login shape this build cannot perform, so a
		// password would never be sent — offering the field invites an operator to
		// blame their own typing for a limitation of this build.
		expect(offersEntryFor("locked", "unsupported-profile")).toBe(false);
		expect(
			deriveLockView(
				modem("locked", {
					credential_configured: false,
					sub_reason: "unsupported-profile",
				}),
			)?.offersEntry,
		).toBe(false);
	});

	it("an `auth-failed` row still offers the field — a retry is exactly what is wanted", () => {
		expect(
			deriveLockView(modem("auth-failed", { credential_configured: true }))
				?.offersEntry,
		).toBe(true);
	});
});

describe("the three failure causes are three DISTINCT messages", () => {
	it("wrong password, unsupported firmware and lockout never share a key", () => {
		const wrongPassword = lockMessageKey("auth-failed");
		const unsupported = lockMessageKey("locked", "unsupported-profile");
		const lockedOut = lockMessageKey("locked-out");
		expect(new Set([wrongPassword, unsupported, lockedOut]).size).toBe(3);
	});

	it("every reachable situation resolves its OWN key", () => {
		const keys = [
			...MODEM_LOCK_STATES.map((state) => lockMessageKey(state)),
			lockMessageKey("locked", "unsupported-profile"),
		];
		expect(new Set(keys).size).toBe(6);
		for (const key of keys) {
			expect(key.startsWith("network.routerCellular.lock.")).toBe(true);
		}
	});

	it("`auth-failed` and `locked-out` are never folded together", () => {
		// The first invites a re-entry, the second forbids one — the wire schema
		// says so in as many words, and the render rule must not undo it.
		expect(lockMessageKey("auth-failed")).not.toBe(
			lockMessageKey("locked-out"),
		);
	});

	it("only the three failure causes take the warning register", () => {
		expect(isFailureState("open")).toBe(false);
		expect(isFailureState("locked")).toBe(false);
		expect(isFailureState("unlocked")).toBe(false);
		expect(isFailureState("auth-failed")).toBe(true);
		expect(isFailureState("locked-out")).toBe(true);
		expect(isFailureState("locked", "unsupported-profile")).toBe(true);
	});
});

describe("a REMOVAL is offered wherever a credential is stored — it is not a retry", () => {
	it.each(MODEM_LOCK_STATES)("%s follows credential_configured", (state) => {
		expect(
			deriveLockView(modem(state, { credential_configured: true }))
				?.offersClear,
		).toBe(true);
		expect(
			deriveLockView(modem(state, { credential_configured: false }))
				?.offersClear,
		).toBe(false);
	});

	it("a missing detail block reads as NO stored credential", () => {
		// `credential_configured` is required on the wire, so an absent detail block
		// is an older producer — and claiming a stored login it never reported would
		// offer a removal for something that does not exist.
		expect(deriveLockView(modem("locked"))?.credentialConfigured).toBe(false);
	});
});

describe("`locked-out` renders the WAIT the device stated, and nothing it did not", () => {
	it("rounds UP, so a wait never reads as `0 min`", () => {
		const now = 1_000_000;
		expect(lockoutRemainingMinutes(now + 1, now)).toBe(1);
		expect(lockoutRemainingMinutes(now + 60_000, now)).toBe(1);
		expect(lockoutRemainingMinutes(now + 61_000, now)).toBe(2);
		expect(lockoutRemainingMinutes(now + 300_000, now)).toBe(5);
	});

	it("answers nothing when the device named no window", () => {
		expect(lockoutRemainingMinutes(undefined, 1_000_000)).toBeUndefined();
	});

	it("answers nothing once the window has elapsed on OUR clock", () => {
		// The dongle owns that counter. Declaring it over from this host's clock
		// would be a claim about something only the device can see.
		const now = 1_000_000;
		expect(lockoutRemainingMinutes(now, now)).toBeUndefined();
		expect(lockoutRemainingMinutes(now - 1, now)).toBeUndefined();
	});

	it("refuses a non-finite window rather than rendering NaN", () => {
		expect(lockoutRemainingMinutes(Number.NaN, 0)).toBeUndefined();
		expect(
			lockoutRemainingMinutes(Number.POSITIVE_INFINITY, 0),
		).toBeUndefined();
	});

	it("carries the device's own `lockout_until` onto the view", () => {
		const view = deriveLockView(
			modem("locked-out", {
				credential_configured: true,
				lockout_until: 1_700_000_000_000,
			}),
		);
		expect(view?.lockoutUntil).toBe(1_700_000_000_000);
	});
});

describe("the lock is why the operation blocks are absent — in exactly three states", () => {
	const WITHHOLDS: Record<ModemLockState, boolean> = {
		open: false,
		locked: true,
		unlocked: false,
		"auth-failed": true,
		"locked-out": true,
	};

	it.each(MODEM_LOCK_STATES)("%s", (state) => {
		const view = deriveLockView(modem(state, { credential_configured: false }));
		expect(lockWithholdsCapabilities(view)).toBe(WITHHOLDS[state]);
	});

	it("mirrors the device's own gate — `open` and `unlocked` are the served states", () => {
		// `gateRouterAdminByLock` withholds `capabilities` + `controls` below those
		// two, so any other verdict here would print "nothing is provably settable"
		// over a device we simply have not signed in to.
		const served = MODEM_LOCK_STATES.filter(
			(state) =>
				!lockWithholdsCapabilities(
					deriveLockView(modem(state, { credential_configured: false })),
				),
		);
		expect([...served].sort()).toEqual(["open", "unlocked"]);
	});
});

describe("a typed refusal is keyed copy, never a raw wire token", () => {
	it("every refusal in the wire enum maps to its own key", () => {
		const keys = modemCredentialsRefusalSchema.options.map((token) =>
			lockErrorKey(token),
		);
		expect(new Set(keys).size).toBe(
			modemCredentialsRefusalSchema.options.length,
		);
		for (const key of keys) {
			expect(key.startsWith("network.routerCellular.lock.error.")).toBe(true);
		}
	});

	it("a thrown transport falls back to its OWN key rather than a device claim", () => {
		expect(lockErrorKey(undefined)).toBe(
			"network.routerCellular.lock.error.generic",
		);
		expect(keysAreDisjoint()).toBe(true);
	});
});

/** The generic key must not collide with any device-stated refusal. */
function keysAreDisjoint(): boolean {
	const generic = lockErrorKey(undefined);
	return modemCredentialsRefusalSchema.options.every(
		(token) => lockErrorKey(token) !== generic,
	);
}
