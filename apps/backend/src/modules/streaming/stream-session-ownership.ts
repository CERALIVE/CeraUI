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
	let state: LifecycleState = "idle";
	let generation = 0;
	let epoch = 0;
	let protectedForOta = false;
	let launches = 0;
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
		if (protectedForOta) return;
		protectedForOta = true;
		deps.markStreamingForOta?.();
	};
	const commit = (
		owner: SessionOwner,
		next: LifecycleState,
		liveness: SessionLiveness,
	): boolean => {
		if (!owns(owner) || !transition(next)) return false;
		switch (liveness) {
			case "unknown":
				protect();
				break;
			case "streaming":
				protect();
				deps.setStreamingStatus(true);
				break;
			case "idle":
				protectedForOta = false;
				deps.setStreamingStatus(false);
				deps.unmarkStreamingForOta?.();
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
		get launchPending() {
			return launches > 0;
		},
		capture,
		owns,
		invalidate,
		transition,
		commit,
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
