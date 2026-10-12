import type { BoundedSpawnOptions } from "../../helpers/bounded-spawn.ts";

interface ScheduledTimer {
	readonly callback: () => void;
	readonly delay: number;
	active: boolean;
}

export interface ManualSpawnClock {
	readonly delays: readonly number[];
	readonly pendingDelay: number | undefined;
	readonly scheduleTimeout: NonNullable<BoundedSpawnOptions["scheduleTimeout"]>;
	readonly cancelTimeout: NonNullable<BoundedSpawnOptions["cancelTimeout"]>;
	fireNext(): Promise<void>;
	flush(): Promise<void>;
}

export function createManualSpawnClock(): ManualSpawnClock {
	const timers: ScheduledTimer[] = [];
	// Each transition is promise-only; this drains its finite microtask graph, not time.
	const flush = async () => {
		for (let turn = 0; turn < 16; turn++) await Promise.resolve();
	};
	return {
		get delays() {
			return timers.map((timer) => timer.delay);
		},
		get pendingDelay() {
			return timers.find((timer) => timer.active)?.delay;
		},
		scheduleTimeout: (callback, delay) => {
			timers.push({ callback, delay, active: true });
			return timers.length;
		},
		cancelTimeout: (token) => {
			if (typeof token !== "number") throw new Error("unexpected native timer");
			const timer = timers[token - 1];
			if (timer === undefined) throw new Error("unknown manual timer");
			timer.active = false;
		},
		fireNext: async () => {
			const timer = timers.find((entry) => entry.active);
			if (timer === undefined) throw new Error("missing bounded timer");
			timer.active = false;
			timer.callback();
			await flush();
		},
		flush,
	};
}
