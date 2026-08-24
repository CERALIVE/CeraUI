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
 * EVERY ASYNCHRONOUS MODEM SURFACE NAMES ITS BOUND AND ITS TERMINAL STATE.
 *
 * Three separate defects share one shape, and this module is the one answer to
 * all three:
 *
 * 1. **A wait with no bound.** `ModemCapabilitiesDialog` dispatched
 *    `modems.getCapabilities` on every open and rendered NOTHING while it was in
 *    flight — so "still reading" and "this build ships no cellular features"
 *    were the same screen, and a read that never answered stayed that way for as
 *    long as the dialog was open. The SMS inbox had the mirror form: a spinner
 *    with a `finally` that only runs if the promise settles.
 * 2. **A terminal nobody can reach.** The sibling machines in
 *    `lib/rpc/usb-mode-flow.ts` (20 s) and `lib/rpc/router-write-flow.ts` (15 s)
 *    already got this right for WRITES — a window armed at RPC resolution, and
 *    an expiry that reports an honest unknown outcome rather than a success.
 *    Reads had no equivalent, so their only terminal was the transport's own
 *    30 s rejection, which is a fact about `client.ts` and not a bound any
 *    surface had declared.
 * 3. **Absence rendered as a verdict.** `undefined` (not loaded), `null` /
 *    `[]` (loaded and empty) and a measured `0` are three different facts, and a
 *    render site that only asks `if (value)` collapses all three into "nothing
 *    here". {@link readingPresence} is the tri-state the whole modem surface
 *    already claims to preserve, written down once.
 *
 * The registry below is the artifact that keeps it from rotting:
 * `src/tests/modem-async-surface-sweep.test.ts` derives the set of
 * `rpc.modems.*` procedures the shipped frontend actually calls and holds it to
 * SET EQUALITY against {@link MODEM_ASYNC_SURFACES}. A new modem procedure
 * therefore fails the gate until somebody states what bounds it and where the
 * wait ends.
 *
 * This module is rune-free on purpose: a rule stated in a `.ts` file can be
 * driven against a never-resolving fixture for every surface at once, which is
 * exactly the proof the bound is worth having.
 */

/**
 * How a wait on this procedure is bounded.
 *
 * Not every surface uses the same mechanism, and flattening them would hide
 * which ones are load-bearing here versus already owned elsewhere:
 *
 * - `read-bound` — this module's own {@link loadWithinBound}. Reads only.
 * - `usb-mode-flow` / `router-write-flow` — the two pre-existing confirmation
 *   machines, whose windows are armed at RPC resolution and expire to an
 *   explicitly-unconfirmed phase.
 * - `async-op-ttl` — `lib/rpc/async-operation.svelte.ts`, whose sweep flips a
 *   stale `pending` to `timed_out` at `ASYNC_OP_TTL_MS`.
 * - `scan-lifecycle` — the same keyed operation store with the modem scan's
 *   device-declared 240 s work budget plus transport/broadcast grace.
 * - `ussd-session` — the dialogue's own machine, which folds the device's
 *   `timed-out` state onto the `unknown` outcome band.
 * - `reply-bounded` — the reply CARRIES the device's own re-read, so there is
 *   nothing left to confirm on a later broadcast and no second window to open.
 *   The bound is then the surface's own {@link loadWithinBound} race, which
 *   turns a write nobody answered into an unknown outcome rather than a
 *   spinner.
 */
export type ModemBoundKind =
	| "read-bound"
	| "usb-mode-flow"
	| "router-write-flow"
	| "async-op-ttl"
	| "scan-lifecycle"
	| "ussd-session"
	| "reply-bounded";

/**
 * The phases a bounded wait can END in.
 *
 * `timed-out` is present in every entry by construction — the sweep asserts it —
 * because an expiry that has no name is an expiry no render site can show.
 */
export type ModemTerminalPhase =
	/** The device answered, and the answer carried data. */
	| "loaded"
	/** The device answered, and the answer was empty. NOT the same as absent. */
	| "empty"
	/** The device answered no. */
	| "refused"
	/** The call itself failed — transport, parse, or a thrown handler. */
	| "failed"
	/** The declared bound elapsed first. Never a success, never a refusal. */
	| "timed-out"
	/** A write the device confirmed. */
	| "applied";

export interface ModemAsyncSurface {
	/** Why an operator is waiting, in one line. */
	readonly what: string;
	/** How the wait is bounded. */
	readonly bound: ModemBoundKind;
	/** The declared bound, in milliseconds. Always > 0. */
	readonly boundMs: number;
	/** Every phase this wait can end in. Always contains `timed-out`. */
	readonly terminal: readonly ModemTerminalPhase[];
	/**
	 * When a SETTLED reading is marked stale on screen, or `undefined` for a
	 * surface whose answer cannot age inside one dialog session (a write's
	 * outcome is a record of an event, not a reading of a value).
	 */
	readonly staleAfterMs: number | undefined;
}

/**
 * The default read bound, and why it is 15 s rather than the transport's 30 s.
 *
 * `client.ts` rejects an unanswered call at 30 s, which IS a bound — but it is a
 * bound on the transport, not on the surface, and 30 s of unexplained skeleton
 * is indistinguishable from a hang to the operator in front of it. 15 s matches
 * `ASYNC_OP_TTL_MS`, so a read and a write on the same dialog give up on the
 * same schedule, and it leaves the transport rejection as the slower fallback
 * rather than the only answer.
 */
export const MODEM_READ_BOUND_MS = 15_000;

/**
 * The SMS inbox gets its own, longer bound because its cost is not one call.
 *
 * `modems.getSms` spends up to one `mmcli` invocation PER stored message, capped
 * at `SMS_INBOX_CAP` (50). A full inbox on a slow modem legitimately outruns the
 * ordinary read bound, and timing out a read that was going to answer is its own
 * dishonesty. It stays under the transport's 30 s so the surface's own terminal
 * is still the one an operator meets.
 */
export const MODEM_SMS_BOUND_MS = 25_000;

/**
 * How long a settled reading stays unmarked.
 *
 * Every read here happens ONCE per dialog open, and a dialog can stay open for
 * as long as an operator leaves it open — so the figure on screen is as old as
 * the session. A minute is long enough that a normal look-and-close never sees
 * the marker, and short enough that a value left on screen while somebody works
 * on the device is not passed off as current.
 */
export const MODEM_READING_STALE_AFTER_MS = 60_000;
export const MODEM_NETWORK_SCAN_BOUND_MS = 270_000;

/**
 * Every `rpc.modems.*` procedure the shipped frontend calls, and what bounds it.
 *
 * Keyed on the wire procedure NAME rather than on a UI concept, because that is
 * the thing the sweep can derive from source — a surface renamed in the UI still
 * calls the same procedure, and a new procedure cannot be added without showing
 * up here.
 */
export const MODEM_ASYNC_SURFACES = {
	getCapabilities: {
		what: "the device-wide capability gates, read on every open",
		bound: "read-bound",
		boundMs: MODEM_READ_BOUND_MS,
		terminal: ["loaded", "empty", "failed", "timed-out"],
		staleAfterMs: MODEM_READING_STALE_AFTER_MS,
	},
	setCapabilities: {
		what: "arming or disarming one capability gate",
		bound: "async-op-ttl",
		boundMs: 15_000,
		terminal: ["applied", "refused", "failed", "timed-out"],
		staleAfterMs: undefined,
	},
	configure: {
		what: "saving a modem's APN / roaming / network-type settings",
		bound: "async-op-ttl",
		boundMs: 15_000,
		terminal: ["applied", "refused", "failed", "timed-out"],
		staleAfterMs: undefined,
	},
	scan: {
		what: "the operator-initiated network scan",
		bound: "scan-lifecycle",
		boundMs: MODEM_NETWORK_SCAN_BOUND_MS,
		terminal: ["applied", "refused", "failed", "timed-out"],
		staleAfterMs: undefined,
	},
	getUsbModeOptions: {
		what: "which USB compositions this device certifies as reachable",
		bound: "read-bound",
		boundMs: MODEM_READ_BOUND_MS,
		terminal: ["loaded", "empty", "failed", "timed-out"],
		staleAfterMs: MODEM_READING_STALE_AFTER_MS,
	},
	setUsbMode: {
		what: "switching the USB composition, confirmed by re-enumeration",
		bound: "usb-mode-flow",
		boundMs: 20_000,
		terminal: ["applied", "refused", "timed-out"],
		staleAfterMs: undefined,
	},
	getFccUnlock: {
		what: "the FCC auto-unlock coverage answer and the persisted opt-in",
		bound: "read-bound",
		boundMs: MODEM_READ_BOUND_MS,
		terminal: ["loaded", "empty", "failed", "timed-out"],
		staleAfterMs: MODEM_READING_STALE_AFTER_MS,
	},
	setFccUnlock: {
		what: "arming the FCC auto-unlock routine",
		bound: "reply-bounded",
		boundMs: MODEM_READ_BOUND_MS,
		terminal: ["applied", "refused", "failed", "timed-out"],
		staleAfterMs: undefined,
	},
	getBands: {
		what: "the band catalog this modem offers and the bands in force",
		bound: "read-bound",
		boundMs: MODEM_READ_BOUND_MS,
		terminal: ["loaded", "empty", "failed", "timed-out"],
		staleAfterMs: MODEM_READING_STALE_AFTER_MS,
	},
	setBands: {
		what: "applying a band lock, verdict read back from the device",
		bound: "reply-bounded",
		boundMs: MODEM_READ_BOUND_MS,
		terminal: ["applied", "refused", "failed", "timed-out"],
		staleAfterMs: undefined,
	},
	setFiveGPreference: {
		what: "ranking 5G against 4G, verdict read back from the device",
		bound: "reply-bounded",
		boundMs: MODEM_READ_BOUND_MS,
		terminal: ["applied", "refused", "failed", "timed-out"],
		staleAfterMs: undefined,
	},
	getSms: {
		what: "the read-only SMS inbox, up to one mmcli read per message",
		bound: "read-bound",
		boundMs: MODEM_SMS_BOUND_MS,
		terminal: ["loaded", "empty", "refused", "failed", "timed-out"],
		staleAfterMs: MODEM_READING_STALE_AFTER_MS,
	},
	getGps: {
		what: "the GNSS receiver's state and, if it has one, its fix",
		bound: "read-bound",
		boundMs: MODEM_READ_BOUND_MS,
		terminal: ["loaded", "empty", "failed", "timed-out"],
		staleAfterMs: MODEM_READING_STALE_AFTER_MS,
	},
	setGps: {
		what: "switching the GNSS receiver on or off",
		bound: "reply-bounded",
		boundMs: MODEM_READ_BOUND_MS,
		terminal: ["applied", "refused", "failed", "timed-out"],
		staleAfterMs: undefined,
	},
	getUssd: {
		what: "whether this modem can open a USSD dialogue at all",
		bound: "read-bound",
		boundMs: MODEM_READ_BOUND_MS,
		terminal: ["loaded", "empty", "failed", "timed-out"],
		staleAfterMs: MODEM_READING_STALE_AFTER_MS,
	},
	ussdInitiate: {
		what: "opening a USSD dialogue with the carrier",
		bound: "ussd-session",
		boundMs: MODEM_READ_BOUND_MS,
		terminal: ["applied", "refused", "failed", "timed-out"],
		staleAfterMs: undefined,
	},
	ussdRespond: {
		what: "answering the carrier's prompt in a live dialogue",
		bound: "ussd-session",
		boundMs: MODEM_READ_BOUND_MS,
		terminal: ["applied", "refused", "failed", "timed-out"],
		staleAfterMs: undefined,
	},
	ussdCancel: {
		what: "closing a live USSD dialogue",
		bound: "ussd-session",
		boundMs: MODEM_READ_BOUND_MS,
		terminal: ["applied", "refused", "failed", "timed-out"],
		staleAfterMs: undefined,
	},
	setCredentials: {
		what: "storing a router dongle's admin login",
		bound: "reply-bounded",
		boundMs: MODEM_READ_BOUND_MS,
		terminal: ["applied", "refused", "failed", "timed-out"],
		staleAfterMs: undefined,
	},
	verifyCredentials: {
		what: "one bounded login attempt against the dongle",
		bound: "reply-bounded",
		boundMs: MODEM_READ_BOUND_MS,
		terminal: ["applied", "refused", "failed", "timed-out"],
		staleAfterMs: undefined,
	},
	clearCredentials: {
		what: "forgetting a stored dongle login (no device request)",
		bound: "reply-bounded",
		boundMs: MODEM_READ_BOUND_MS,
		terminal: ["applied", "refused", "failed", "timed-out"],
		staleAfterMs: undefined,
	},
	setRouterControl: {
		what: "a router-dongle control write, confirmed by broadcast",
		bound: "router-write-flow",
		boundMs: 15_000,
		terminal: ["applied", "refused", "timed-out"],
		staleAfterMs: undefined,
	},
	setRouterNetMode: {
		what: "a router-dongle network-mode write, confirmed by broadcast",
		bound: "router-write-flow",
		boundMs: 15_000,
		terminal: ["applied", "refused", "timed-out"],
		staleAfterMs: undefined,
	},
	setRouterSubnet: {
		what: "the confirmed LAN-subnet rewrite",
		bound: "reply-bounded",
		boundMs: MODEM_READ_BOUND_MS,
		terminal: ["applied", "refused", "failed", "timed-out"],
		staleAfterMs: undefined,
	},
	openRouterAdmin: {
		what: "minting a session for the dongle's own admin page",
		bound: "reply-bounded",
		boundMs: MODEM_READ_BOUND_MS,
		terminal: ["applied", "refused", "failed", "timed-out"],
		staleAfterMs: undefined,
	},
	unlockSim: {
		what: "submitting a SIM PIN",
		bound: "async-op-ttl",
		boundMs: 15_000,
		terminal: ["applied", "refused", "failed", "timed-out"],
		staleAfterMs: undefined,
	},
	unlockSimPuk: {
		what: "submitting a SIM PUK and a new PIN",
		bound: "async-op-ttl",
		boundMs: 15_000,
		terminal: ["applied", "refused", "failed", "timed-out"],
		staleAfterMs: undefined,
	},
	unlockSimPin2: {
		what: "submitting a PIN2",
		bound: "async-op-ttl",
		boundMs: 15_000,
		terminal: ["applied", "refused", "failed", "timed-out"],
		staleAfterMs: undefined,
	},
} as const satisfies Record<string, ModemAsyncSurface>;

export type ModemAsyncSurfaceId = keyof typeof MODEM_ASYNC_SURFACES;

/** The declared bound for one surface. Throws on an unregistered id by typing. */
export function modemBoundMs(surface: ModemAsyncSurfaceId): number {
	return MODEM_ASYNC_SURFACES[surface].boundMs;
}

/* ── the bounded read ─────────────────────────────────────────────────────── */

/**
 * What a bounded read ended as.
 *
 * `timed-out` carries no value and no error on purpose: nothing is known about
 * the device, and handing the caller a partial shape would invite it to render
 * one.
 */
export type LoadOutcome<T> =
	| { readonly phase: "loaded"; readonly value: T }
	| { readonly phase: "failed"; readonly error: unknown }
	| { readonly phase: "timed-out"; readonly boundMs: number };

/** The timer seam, so a test can drive the bound without a real clock. */
export interface LoadTimerSeam {
	readonly setTimeout: (fn: () => void, ms: number) => unknown;
	readonly clearTimeout: (handle: unknown) => void;
}

const DEFAULT_TIMERS: LoadTimerSeam = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (handle) => {
		clearTimeout(handle as ReturnType<typeof setTimeout>);
	},
};

/**
 * Run one modem read against its declared bound.
 *
 * Three properties are load-bearing, and each of them is a way the obvious
 * version leaks:
 *
 * 1. **The timer is CLEARED when the call settles first.** A `Promise.race` that
 *    leaves its loser armed holds a handle per read, and on a dialog opened
 *    repeatedly that is a timer per open.
 * 2. **The losing call's late rejection is SWALLOWED, not dropped.** A promise
 *    that rejects after the race has been decided is an unhandled rejection —
 *    which in a browser reaches the console and in a test reaches the reporter.
 *    Attaching a no-op `catch` is what makes the bound safe to apply to a call
 *    that fails slowly.
 * 3. **A late SUCCESS is not adopted either.** The caller has already been told
 *    the read did not answer; quietly replacing that with data would edit
 *    something an operator has read. The honest repair is a fresh read, which is
 *    why every timed-out surface renders a retry rather than waiting in silence
 *    — the same rule `router-write-flow.ts` applies to a settled write.
 */
export function loadWithinBound<T>(
	surface: ModemAsyncSurfaceId,
	run: () => Promise<T>,
	timers: LoadTimerSeam = DEFAULT_TIMERS,
): Promise<LoadOutcome<T>> {
	const boundMs = modemBoundMs(surface);

	// ONE promise settled by whichever of the two arms gets there first, rather
	// than `Promise.race` over a mapped call inside an `async` function. That is
	// a latency decision, not a style one: each `async` hop and each `.then`
	// costs a microtask, and this helper sits between a surface's `$effect` and
	// its first render. The obvious shape spent ~6 microtasks where the bare
	// `await` it replaced spent 1, which is imperceptible on a device and moves
	// the settle past the first paint that a mounted test observes. This shape
	// costs exactly one extra tick. Do not "simplify" it back into a race.
	return new Promise<LoadOutcome<T>>((resolve) => {
		let settled = false;
		let handle: unknown;

		const finish = (outcome: LoadOutcome<T>): void => {
			// Property 3: the first arm home wins, permanently. A late answer after
			// the bound elapsed is DROPPED — the caller has already been told the
			// read did not answer, and quietly replacing that with data edits
			// something an operator has read. The honest repair is a fresh read,
			// which is why every timed-out surface renders a retry.
			if (settled) return;
			settled = true;
			// Property 1: a bound that stays armed after the call answers holds one
			// timer per dialog open.
			timers.clearTimeout(handle);
			resolve(outcome);
		};

		handle = timers.setTimeout(
			() => finish({ phase: "timed-out", boundMs }),
			boundMs,
		);

		let pending: Promise<T>;
		try {
			pending = run();
		} catch (error) {
			// Property 2: `rpc.modems.<x>` being undefined throws on the CALL, before
			// any promise exists. The `try/catch` this helper replaced absorbed that;
			// without this arm a partially-mocked surface raises an unhandled
			// rejection where its caller expects a terminal state.
			finish({ phase: "failed", error });
			return;
		}

		pending.then(
			(value) => finish({ phase: "loaded", value }),
			(error: unknown) => finish({ phase: "failed", error }),
		);
	});
}

/* ── the tri-state ────────────────────────────────────────────────────────── */

/**
 * NOT LOADED, LOADED-AND-EMPTY, and A READING are three different facts.
 *
 * The convention this preserves is the one the modem surface already documents:
 * `undefined` = nothing has been read, `null` = the device answered with
 * nothing, a value = the device answered with something. An empty array or Map
 * is the collection form of `null` — the read succeeded and there was nothing in
 * it.
 *
 * **A measured `0` is `present`, and that is the whole point.** Zero throughput,
 * zero stored messages reported as a count, zero bars: each is a reading the
 * device took, and rendering it the same way as "we never asked" is the defect
 * this function exists to make unrepresentable. `false` and `""` are readings
 * for the same reason.
 */
export type ReadingPresence = "unloaded" | "empty" | "present";

export function readingPresence(value: unknown): ReadingPresence {
	if (value === undefined) return "unloaded";
	if (value === null) return "empty";
	if (Array.isArray(value)) return value.length === 0 ? "empty" : "present";
	if (value instanceof Map || value instanceof Set) {
		return value.size === 0 ? "empty" : "present";
	}
	return "present";
}

/* ── freshness ────────────────────────────────────────────────────────────── */

/**
 * How old the value on screen is.
 *
 * `unknown` is NOT a synonym for fresh. A surface that never recorded when it
 * read has told us nothing about the age of what it is showing, and stamping
 * "Stale" on that is as much a fabrication as presenting it as current — so the
 * marker is withheld and the caller renders the value plain, exactly as
 * `router-signal.ts` does for an `unknown` freshness.
 *
 * The clock here is the BROWSER's on both sides: `observedAt` is stamped when
 * this surface received the answer, never taken from a device timestamp, so
 * there is no skew to correct for. (A device-stamped window needs the
 * duration-not-instant treatment `modem-gps.ts` documents; nothing in this
 * module reads one.)
 */
export type ReadingFreshness = "unknown" | "fresh" | "stale";

export function readingFreshness(
	observedAt: number | undefined,
	now: number,
	staleAfterMs: number | undefined,
): ReadingFreshness {
	if (observedAt === undefined || staleAfterMs === undefined) return "unknown";
	return now - observedAt >= staleAfterMs ? "stale" : "fresh";
}

/**
 * When to re-evaluate freshness, or `undefined` once there is nothing left to
 * wait for. Mirrors `gnssAcquirePollDelay`: one armed deadline, never a poll.
 */
export function readingStaleDelay(
	observedAt: number | undefined,
	now: number,
	staleAfterMs: number | undefined,
): number | undefined {
	if (observedAt === undefined || staleAfterMs === undefined) return undefined;
	const remaining = staleAfterMs - (now - observedAt);
	return remaining > 0 ? remaining : undefined;
}
