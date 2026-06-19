import { describe, expect, it } from "bun:test";
import { SHUTDOWN_SIGTERM_GRACE_MS } from "../modules/streaming/constants.ts";
import {
	gracefulShutdown,
	type ShutdownTimers,
	type StreamingProcess,
} from "../modules/streaming/streamloop/process-runner.ts";

function makeFakeProc(spawnfile: string): {
	sp: StreamingProcess;
	signals: string[];
} {
	const signals: string[] = [];
	const sp = {
		proc: {
			exitCode: null as number | null,
			signalCode: null as string | null,
			kill: (sig: string) => {
				signals.push(sig);
			},
		},
		spawnfile,
		exitListeners: [] as Array<() => void>,
	} as unknown as StreamingProcess;
	return { sp, signals };
}

function fakeTimers(): {
	timers: ShutdownTimers;
	scheduled: Array<{ fn: () => void; ms: number }>;
	fireAll: () => void;
} {
	const scheduled: Array<{ fn: () => void; ms: number }> = [];
	return {
		timers: {
			setTimeout(fn, ms) {
				scheduled.push({ fn, ms });
				return scheduled.length as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimeout() {},
		},
		scheduled,
		fireAll() {
			for (const s of [...scheduled]) s.fn();
		},
	};
}

describe("gracefulShutdown: SIGTERM then SIGKILL after the grace window", () => {
	it("SIGTERMs each live process then SIGKILLs survivors at the timeout", async () => {
		const a = makeFakeProc("srtla_send");
		const b = makeFakeProc("cerastream");
		const ft = fakeTimers();

		const done = gracefulShutdown(
			SHUTDOWN_SIGTERM_GRACE_MS,
			[a.sp, b.sp],
			ft.timers,
		);

		// SIGTERM sent to both immediately.
		expect(a.signals).toEqual(["SIGTERM"]);
		expect(b.signals).toEqual(["SIGTERM"]);

		// One grace timer scheduled at the 5s window.
		expect(ft.scheduled).toHaveLength(1);
		expect(ft.scheduled[0]?.ms).toBe(5_000);

		// Timeout elapses with both still alive → SIGKILL escalation.
		ft.fireAll();
		expect(a.signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(b.signals).toEqual(["SIGTERM", "SIGKILL"]);

		await done;
	});

	it("resolves without SIGKILL when processes exit within the grace window", async () => {
		const a = makeFakeProc("srtla_send");
		const ft = fakeTimers();

		const done = gracefulShutdown(5_000, [a.sp], ft.timers);
		expect(a.signals).toEqual(["SIGTERM"]);

		// Simulate a clean exit before the timeout: mark dead, fire exit listeners.
		(a.sp.proc as { exitCode: number | null }).exitCode = 0;
		for (const listener of [...a.sp.exitListeners]) listener();

		await done;

		// A late timer fire must not SIGKILL an already-exited process.
		ft.fireAll();
		expect(a.signals).toEqual(["SIGTERM"]);
	});

	it("resolves immediately when nothing is alive to shut down", async () => {
		const dead = makeFakeProc("srtla_send");
		(dead.sp.proc as { exitCode: number | null }).exitCode = 0;
		const ft = fakeTimers();

		await gracefulShutdown(5_000, [dead.sp], ft.timers);

		expect(dead.signals).toEqual([]);
		expect(ft.scheduled).toHaveLength(0);
	});
});
