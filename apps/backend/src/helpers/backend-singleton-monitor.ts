import type { KernelLockIdentity } from "../modules/system/update-orchestrator/os-stage-guard-kernel-rows.ts";
import { singletonPathMatches } from "./backend-singleton-proof.ts";
import { logger } from "./logger.ts";

export type SingletonClock = {
	readonly schedule: (tick: () => Promise<void>, ms: number) => () => void;
};
export const singletonClock: SingletonClock = {
	schedule: (tick, ms) => {
		const timer = setTimeout(() => void tick(), ms);
		return () => clearTimeout(timer);
	},
};

export function monitorSingletonPath(
	path: string,
	identity: KernelLockIdentity,
	clock: SingletonClock,
): { readonly lost: Promise<number>; stop(): void } {
	let stopped = false;
	let cancel: () => void;
	const lost = Promise.withResolvers<number>();
	const tick = async () => {
		if (stopped) return;
		try {
			if (!(await singletonPathMatches(path, identity))) {
				logger.error(
					"Backend singleton lock path identity changed; refusing to continue",
				);
				lost.resolve(1);
				return;
			}
		} catch (error) {
			// A missing/unreadable path cannot prove continued exclusivity.
			logger.error(
				"Backend singleton lock path identity unproven; refusing to continue",
				{ error },
			);
			lost.resolve(1);
			return;
		}
		if (!stopped) cancel = clock.schedule(tick, 2_000);
	};
	cancel = clock.schedule(tick, 2_000);
	return {
		lost: lost.promise,
		stop() {
			stopped = true;
			cancel();
		},
	};
}
