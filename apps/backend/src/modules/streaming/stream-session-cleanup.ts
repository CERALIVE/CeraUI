import type { StreamSessionOrchestratorDeps } from "./stream-session-orchestrator.ts";

type Timer = ReturnType<typeof globalThis.setTimeout> | number;
type CleanupFlight = {
	readonly result: Promise<void>;
	readonly release: () => void;
	readonly reject: (error: unknown) => void;
};

/** A deadline ends the caller's wait, not the ownership of submitted cleanup. */
export function createSessionCleanup(
	deps: StreamSessionOrchestratorDeps,
	clock: {
		readonly schedule: (callback: () => void, delayMs: number) => Timer;
		readonly cancel: (timer: Timer) => void;
		readonly deadlineMs: number;
	},
) {
	let flight: CleanupFlight | undefined;
	return {
		get pending() {
			return flight !== undefined;
		},
		run: (generation: number): Promise<void> => {
			if (flight !== undefined) return flight.result;
			const answer = Promise.withResolvers<void>();
			const current: CleanupFlight = {
				result: answer.promise,
				release: () => answer.resolve(),
				reject: answer.reject,
			};
			flight = current;
			const timer = clock.schedule(
				() => current.reject(new Error("stop_timeout")),
				clock.deadlineMs,
			);
			let raw: Promise<void>;
			try {
				raw = deps.stopRuntime(generation);
			} catch (error) {
				raw = Promise.reject(error);
			}
			const retire = () => {
				clock.cancel(timer);
				if (flight === current) flight = undefined;
			};
			void raw.then(
				() => {
					retire();
					current.release();
				},
				(error: unknown) => {
					retire();
					current.reject(error);
				},
			);
			return current.result;
		},
	};
}
