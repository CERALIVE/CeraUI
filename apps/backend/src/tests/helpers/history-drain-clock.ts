import { spyOn } from "bun:test";
import { manualClock } from "./device-journal.ts";

/** Virtualize the clear deadline only; transport and event-deadline clocks stay real. */
export function drainClock() {
	const scheduled = spyOn(globalThis, "setTimeout");
	const cleared = spyOn(globalThis, "clearTimeout");
	const time = manualClock();
	let deadline: unknown;
	return {
		capture() {
			const index =
				scheduled.mock.calls
					.map(([, delay], index) => (delay === 15_000 ? index : -1))
					.filter((index) => index >= 0)
					.at(-1) ?? -1;
			const callback = scheduled.mock.calls[index]?.[0];
			if (typeof callback !== "function")
				throw new Error("clear did not schedule its 15000ms stop deadline");
			deadline = scheduled.mock.results[index]?.value;
			time.clock.setTimeout(() => callback(), 15_000);
		},
		advance: time.advance,
		wasCleared: () => cleared.mock.calls.some(([timer]) => timer === deadline),
		dispose() {
			scheduled.mockRestore();
			cleared.mockRestore();
		},
	};
}
