import type { StartupRetryClock } from "../../modules/system/update-orchestrator/startup-retry.ts";

export function startupCadenceClock() {
	const delays: number[] = [];
	const timers: {
		readonly work: () => Promise<void>;
		readonly milliseconds: number;
		unreferenced: boolean;
		cancelled: boolean;
	}[] = [];
	const clock: StartupRetryClock = {
		wait: async (milliseconds) => {
			delays.push(milliseconds);
		},
		scheduleBackground: (work, milliseconds) => {
			const timer = {
				work,
				milliseconds,
				unreferenced: false,
				cancelled: false,
			};
			timers.push(timer);
			return {
				unref: () => {
					timer.unreferenced = true;
				},
				cancel: () => {
					timer.cancelled = true;
				},
			};
		},
	};
	return { clock, delays, timers };
}
