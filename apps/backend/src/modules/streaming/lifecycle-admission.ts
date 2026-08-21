/**
 * LifecycleInterlock — the single mutual-exclusion guard between STREAMING
 * ADMISSION and MODEM LIFECYCLE mutations (modem-stack Phase B).
 *
 * Two operations must never run concurrently against a bonded modem link:
 *
 *  - `"streaming"` — a stream is being ADMITTED. The lease is held only across
 *    the admission window (`stream-session-orchestrator.ts` `start()`, from the
 *    moment the attempt is admitted until the launch settles), because once the
 *    stream is live the LIVE guard (`getIsStreaming()`) takes over. It is
 *    released in that admission's `finally`, so a throw mid-launch can never
 *    strand it.
 *  - `"modem-transition"` — a USB-composition-mode switch (`modems.setUsbMode`)
 *    or a future, DEFAULT-DISABLED autonomous cellular recovery / USB-reset
 *    action. Both re-enumerate a modem, tearing its bond link down mid-flight.
 *
 * Letting either start while the other is mid-flight breaks the bond math — a
 * link vanishing during admission, or an admitted stream losing a link to a
 * reset — so the two are mutually exclusive in BOTH race orders. A bare
 * `getIsStreaming()` cannot express that: it is false for the whole admission
 * window, which is precisely the window a transition must not land in.
 *
 * Acquisition is FAIL-FAST: there is no queue and no scheduler. A caller that
 * cannot acquire is refused IMMEDIATELY and maps the refusal onto its own typed
 * wire value (`leaseRefusal` below is the one table both sides read, so the two
 * refusals can never drift apart). Release is idempotent, so an outer `finally`
 * may release after the body already did, and a stale lease can never free a
 * later holder.
 *
 * SCOPE: this module is the PRIMITIVE plus its streaming-side wiring, GENERALIZED
 * from the single `"modem-transition"` holder to a PER-PHYSICAL-DEVICE mutation
 * lease that every mutating modem path takes — MM/NM config, SIM PIN/PUK/PIN2, a
 * network scan, a router-admin write, the remote `modem.reconfig` op, and the
 * USB-mode switch alike. Two devices may be mutated concurrently (their leases are
 * independent), but a stream admission is refused while ANY of them is held, and
 * every mutation is refused while an admission holds the interlock. That
 * reciprocity is why the generalization lives here rather than in a second guard
 * beside `getIsStreaming()` — a parallel lease would reopen the admission-window
 * race this module exists to close.
 */

import type { ModemMutationRefusal } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";

import { isRecoveryPending } from "./recovery-barrier.ts";

export const LIFECYCLE_HOLDERS = ["streaming", "modem-transition"] as const;
export type LifecycleHolder = (typeof LIFECYCLE_HOLDERS)[number];

/**
 * The typed refusal a caller reports when the OTHER side holds the interlock.
 * Wire-stable machine tokens, never rendered raw:
 *
 *  - `MODEM_TRANSITION_ACTIVE` — what a `streaming.start` answers when a modem
 *    transition holds the lease.
 *  - `STREAMING_ACTIVE` — what a modem transition answers when an admission
 *    holds it. Deliberately the SAME token `modems.setUsbMode` already returns
 *    for a LIVE stream (`streaming_active`), because from the operator's side
 *    "a stream is starting" and "a stream is running" call for the same action.
 */
export const MODEM_TRANSITION_ACTIVE = "MODEM_TRANSITION_ACTIVE";
export const STREAMING_ACTIVE = "streaming_active";

export type LifecycleRefusal =
	| typeof MODEM_TRANSITION_ACTIVE
	| typeof STREAMING_ACTIVE;

/**
 * The refusal a requester reports, keyed on WHO holds the interlock. One table
 * for both directions: a per-caller mapping is how the two halves of a mutual
 * exclusion drift into disagreeing about what happened.
 */
export function leaseRefusal(heldBy: LifecycleHolder): LifecycleRefusal {
	return heldBy === "streaming" ? STREAMING_ACTIVE : MODEM_TRANSITION_ACTIVE;
}

/** A held interlock. `release()` is idempotent — safe to call from a `finally`. */
export interface LifecycleLease {
	readonly holder: LifecycleHolder;
	release(): void;
}

/** The outcome of an acquisition attempt. A refusal NAMES the current holder. */
export type LifecycleAdmission =
	| { readonly admitted: true; readonly lease: LifecycleLease }
	| {
			readonly admitted: false;
			readonly heldBy: LifecycleHolder;
			readonly refusal: LifecycleRefusal;
	  };

/** The result of a guarded run: the operation's value, or a contention miss. */
export type LifecycleOutcome<T> =
	| { readonly acquired: true; readonly result: T }
	| { readonly acquired: false; readonly refusal: LifecycleRefusal };

type HeldLease = { readonly holder: LifecycleHolder; readonly token: number };

let held: HeldLease | undefined;
let nextToken = 0;

/**
 * Try to acquire the interlock for `who`. NEVER blocks: a held interlock is
 * refused on the spot, naming its holder and the caller's typed refusal.
 *
 * The lease is EXCLUSIVE, not re-entrant — a second `"streaming"` acquisition
 * while one is outstanding is refused exactly like a cross-holder one. Callers
 * that have their own concurrency guard (the orchestrator's `state !== "idle"`
 * duplicate-start rejection) run it FIRST, so a genuine duplicate keeps its own
 * specific error instead of decaying into a generic lease-busy one.
 */
export function tryAcquireLifecycle(who: LifecycleHolder): LifecycleAdmission {
	// A per-device mutation lease is the SAME exclusion as the legacy
	// `"modem-transition"` holder, so it has to refuse a requester here too —
	// otherwise a stream admission could slip past a mutation that took the
	// generalized path.
	if (activeMutations.size > 0) {
		logger.debug("lifecycle interlock refused: a modem mutation is held", {
			module: "streaming",
			requested: who,
			devices: activeMutations.size,
		});
		return {
			admitted: false,
			heldBy: "modem-transition",
			refusal: leaseRefusal("modem-transition"),
		};
	}
	const current = held;
	if (current !== undefined) {
		logger.debug("lifecycle interlock refused a concurrent operation", {
			module: "streaming",
			heldBy: current.holder,
			requested: who,
		});
		return {
			admitted: false,
			heldBy: current.holder,
			refusal: leaseRefusal(current.holder),
		};
	}

	nextToken += 1;
	const token = nextToken;
	held = { holder: who, token };
	return {
		admitted: true,
		lease: {
			holder: who,
			release: () => releaseToken(token),
		},
	};
}

/**
 * Release by TOKEN, not by holder. A lease that has already been released (or
 * superseded by a later acquisition) frees nothing, so a double-release and a
 * stale `finally` are both no-ops rather than a way to steal the interlock from
 * whoever holds it now.
 */
function releaseToken(token: number): void {
	if (held?.token !== token) return;
	held = undefined;
}

/**
 * Run `operation` while holding the interlock for `who`, releasing in a
 * `finally` on ANY exit — return OR throw. A throw propagates to the caller
 * AFTER the release, which is the no-deadlock guarantee. When the other side
 * holds the interlock, `operation` is NOT run and the typed refusal is returned.
 */
export async function withLifecycleLock<T>(
	who: LifecycleHolder,
	operation: () => Promise<T>,
): Promise<LifecycleOutcome<T>> {
	const admission = tryAcquireLifecycle(who);
	if (!admission.admitted) {
		return { acquired: false, refusal: admission.refusal };
	}
	try {
		return { acquired: true, result: await operation() };
	} finally {
		admission.lease.release();
	}
}

/** True while either lifecycle operation holds the interlock. */
export function isLifecycleHeld(): boolean {
	return held !== undefined;
}

/** The current holder, or `undefined` when the interlock is free (diagnostics). */
export function currentLifecycleHolder(): LifecycleHolder | undefined {
	return held?.holder;
}

/**
 * Test-only: force-release the interlock so a suite starts from a free state.
 * NEVER call this from production code — it would free a lease its holder is
 * still relying on.
 */
export function resetLifecycleInterlock(): void {
	held = undefined;
	activeMutations.clear();
	mutationBlocks.clear();
}

/** A held per-physical-device mutation lease. `release()` is idempotent. */
export interface ModemMutationLease {
	readonly stableKey: string;
	release(): void;
}

export type ModemMutationAdmission =
	| { readonly admitted: true; readonly lease: ModemMutationLease }
	| { readonly admitted: false; readonly refusal: ModemMutationRefusal };

/** Why one physical identity is currently refusing mutations, from the journal. */
export interface MutationBlock {
	readonly stableKey: string;
	readonly refusal: ModemMutationRefusal;
	/** Whether it ALSO holds global stream autostart (a decommission does not). */
	readonly blocksStreaming: boolean;
}

const activeMutations = new Map<string, number>();
const mutationBlocks = new Map<string, MutationBlock>();
let nextMutationToken = 0;

/**
 * Try to take the mutation lease for one physical device.
 *
 * The refusal order is the contract. Replay first, because a device that has not
 * finished recovering cannot yet prove anything about itself; then the journal's
 * fail-closed blocks; then this device's own in-flight mutation; and only then the
 * reciprocal streaming check. Reordering it would let a blocked device answer
 * "a stream is running" — true, but not the fact the operator has to act on.
 */
export function tryAcquireModemMutation(
	stableKey: string,
): ModemMutationAdmission {
	if (isRecoveryPending()) {
		return { admitted: false, refusal: "recovery_pending" };
	}
	const block = mutationBlocks.get(stableKey);
	if (block !== undefined) {
		return { admitted: false, refusal: block.refusal };
	}
	if (activeMutations.has(stableKey)) {
		return { admitted: false, refusal: "mutation_in_progress" };
	}
	if (held !== undefined) {
		return {
			admitted: false,
			refusal:
				held.holder === "streaming"
					? "streaming_active"
					: "mutation_in_progress",
		};
	}

	nextMutationToken += 1;
	const token = nextMutationToken;
	activeMutations.set(stableKey, token);
	return {
		admitted: true,
		lease: {
			stableKey,
			release: () => {
				if (activeMutations.get(stableKey) === token) {
					activeMutations.delete(stableKey);
				}
			},
		},
	};
}

export function isModemMutationHeld(stableKey: string): boolean {
	return activeMutations.has(stableKey);
}

export function heldModemMutations(): readonly string[] {
	return [...activeMutations.keys()];
}

/**
 * Publish the journal's current fail-closed blocks. Replacing the whole set is
 * deliberate: a block that no longer exists on disk must stop being enforced in
 * the same operation that stops recording it, so the two cannot disagree.
 */
export function setMutationBlocks(blocks: readonly MutationBlock[]): void {
	mutationBlocks.clear();
	for (const block of blocks) mutationBlocks.set(block.stableKey, block);
}

export function getMutationBlocks(): readonly MutationBlock[] {
	return [...mutationBlocks.values()];
}

/** The first block holding global stream autostart, if any. */
export function streamingBlockingMutation(): MutationBlock | undefined {
	for (const block of mutationBlocks.values()) {
		if (block.blocksStreaming) return block;
	}
	return undefined;
}
