import {
	isLegalLifecycleTransition,
	type LifecycleState,
} from "@ceraui/rpc/schemas";
import type { StreamSessionOrchestratorDeps } from "./stream-session-orchestrator.ts";

export type SessionOwner = {
	readonly generation: number;
	readonly epoch: number;
};
export type SessionLiveness = "idle" | "streaming" | "unknown";

/** Session writes are atomic with the transition guard, never its aftermath. */
export function createSessionOwnership(deps: StreamSessionOrchestratorDeps) {
	const initialLiveness =
		typeof deps.initialLiveness === "function"
			? deps.initialLiveness()
			: (deps.initialLiveness ?? "idle");
	let state: LifecycleState =
		initialLiveness === "unknown" ? "reconciling" : "idle";
	let generation = 0;
	let epoch = 0;
	let protectedForOta = false;
	let launches = 0;
	let protectionRequired = initialLiveness === "unknown";
	let confirmedLiveness: SessionLiveness = initialLiveness;
	// Confirmed cleanup can restore the same absent-sentinel baseline as boot.
	const sentinelAbsent = () =>
		typeof deps.initialLiveness !== "function" ||
		deps.initialLiveness() === "idle";
	const unprotectedBaseline = () =>
		!protectionRequired && launches === 0 && sentinelAbsent();
	const capture = (): SessionOwner => ({ generation, epoch });
	const owns = (owner: SessionOwner) =>
		owner.generation === generation && owner.epoch === epoch;
	const invalidate = () => {
		epoch++;
		return capture();
	};
	const transition = (next: LifecycleState): boolean => {
		if (state === next) return true;
		if (!isLegalLifecycleTransition(state, next)) {
			deps.invariantViolation?.(state, next);
			return false;
		}
		state = next;
		deps.setLifecycleState?.(state);
		return true;
	};
	const protect = () => {
		protectionRequired = true;
		if (protectedForOta) return;
		try {
			protectedForOta = deps.markStreamingForOta?.() !== false;
		} catch {
			protectedForOta = false;
		}
	};
	const commit = (
		owner: SessionOwner,
		next: LifecycleState,
		liveness: SessionLiveness,
	): boolean => {
		if (!owns(owner) || !transition(next)) return false;
		confirmedLiveness = liveness;
		switch (liveness) {
			case "unknown":
				if (!unprotectedBaseline()) protect();
				break;
			case "streaming":
				protect();
				deps.setStreamingStatus(true);
				break;
			case "idle":
				deps.setStreamingStatus(false);
				try {
					protectionRequired = deps.unmarkStreamingForOta?.() === false;
				} catch {
					protectionRequired = true;
				}
				if (protectionRequired) transition("reconciling");
				else protectedForOta = false;
				break;
		}
		return true;
	};
	return {
		get state() {
			return state;
		},
		get generation() {
			return generation;
		},
		streamLiveness: (): SessionLiveness =>
			unprotectedBaseline() && state === "idle"
				? "idle"
				: confirmedLiveness === "streaming" &&
						protectedForOta &&
						state === "streaming"
					? "streaming"
					: "unknown",
		get launchPending() {
			return launches > 0;
		},
		capture,
		owns,
		invalidate,
		transition,
		commit,
		settleUnprotectedObservation: (owner: SessionOwner): boolean =>
			owns(owner) && unprotectedBaseline() && transition("idle"),
		protect,
		begin: () => {
			generation++;
			return invalidate();
		},
		trackLaunch: (launch: Promise<void>): Promise<void> => {
			launches++;
			return launch.finally(() => {
				launches--;
			});
		},
	};
}

export type SessionOwnership = ReturnType<typeof createSessionOwnership>;
