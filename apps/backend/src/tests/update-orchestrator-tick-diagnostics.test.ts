import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { logger } from "../helpers/logger.ts";
import { DownloadPausedLedger } from "../modules/system/update-orchestrator/download-paused-ledger.ts";
import { DownloadPausedNotices } from "../modules/system/update-orchestrator/download-paused-notices.ts";
import * as notices from "../modules/system/update-orchestrator/notifications.ts";
import { saveOrchestratorState } from "../modules/system/update-orchestrator/persistence.ts";
import {
	getOrchestratorState,
	startUpdateOrchestrator,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { runtimeFixture } from "./helpers/os-unlaunched-runtime-fixture.ts";

for (const loggerThrows of [false, true]) {
	test(`scheduled tick retries exactly once when diagnostics ${loggerThrows ? "throw" : "succeed"}`, async () => {
		// Given a started scheduler and an independent worker with a throwing reporter.
		const f = runtimeFixture({
			observeCredentials: async () => undefined,
			loadCapabilities: async () => ({ mode: "legacy", features: [] }),
		});
		const ledger = new DownloadPausedLedger(join(f.file, "..", "holds.json"));
		const read = spyOn(ledger, "read").mockImplementation(() => {
			throw new Error("synthetic ledger fault");
		});
		let reports = 0;
		const worker = new DownloadPausedNotices({
			ledger,
			publish: () => undefined,
			clear: () => undefined,
			report: () => {
				reports++;
				throw new Error("synthetic reporter fault");
			},
		});
		const rejections: unknown[] = [];
		const exceptions: unknown[] = [];
		const onRejection = (error: unknown) => rejections.push(error);
		const onException = (error: unknown) => exceptions.push(error);
		process.on("unhandledRejection", onRejection);
		process.on("uncaughtException", onException);
		const timers = spyOn(globalThis, "setTimeout");
		const events: string[] = [];
		const captured: unknown[][] = [];
		const schedulesAtWarning: number[] = [];
		const failure = new Error("synthetic tick fault");
		const log = spyOn(logger, "warn").mockImplementation((...args) => {
			captured.push(args);
			events.push("warn");
			schedulesAtWarning.push(
				timers.mock.calls.filter(([, ms]) => ms === 60_000).length,
			);
			if (loggerThrows) throw new Error("synthetic logger fault");
			return logger;
		});
		try {
			await startUpdateOrchestrator({ ...f.deps, downloadNotices: worker });
			await worker.settled();
			const before = getOrchestratorState();
			const scheduled = timers.mock.calls.filter(([, ms]) => ms === 60_000);
			expect(scheduled).toHaveLength(1);
			const callback = scheduled[0]?.[0];
			if (typeof callback !== "function")
				throw new TypeError("scheduler did not install a callback");
			reports = 0;
			const hydrate = spyOn(worker, "hydrate").mockImplementation(() => {
				events.push("hydrate");
				hydrate.mockRestore();
				worker.hydrate();
				throw failure;
			});
			// When the actual detached timer callback receives a rejected tick.
			callback();
			await worker.settled();
			await new Promise<void>((resolve) => setImmediate(resolve));
			// Then diagnostics cannot escape, change state, or suppress/duplicate the retry.
			expect(rejections).toEqual([]);
			expect(exceptions).toEqual([]);
			expect(events).toEqual(["hydrate", "warn"]);
			expect(schedulesAtWarning).toEqual([1]);
			expect(captured).toEqual([
				["update-orchestrator: tick failed", { error: failure }],
			]);
			expect(timers.mock.calls.filter(([, ms]) => ms === 60_000)).toHaveLength(
				2,
			);
			expect(reports).toBe(1);
			expect(getOrchestratorState()).toBe(before);
		} finally {
			worker.dispose();
			f.cleanup();
			timers.mockRestore();
			log.mockRestore();
			read.mockRestore();
			process.off("unhandledRejection", onRejection);
			process.off("uncaughtException", onException);
		}
	});
}

test("startup still schedules after recovered-notice publication and its warning throw", async () => {
	// Given a durable recovered notice with broken publication and diagnostic transports.
	const f = runtimeFixture({
		observeCredentials: async () => undefined,
		loadCapabilities: async () => ({ mode: "legacy", features: [] }),
	});
	const baseline = {
		...initialOrchestratorState(0),
		recoveredNotice: {
			kind: "packages-recovered",
			id: "recovered-fixture",
		} as const,
	};
	saveOrchestratorState(baseline, f.file);
	const original = new Error("synthetic publication failure");
	const publish = spyOn(notices, "notifyUpdate").mockImplementation(() => {
		throw original;
	});
	const captured: unknown[][] = [];
	const log = spyOn(logger, "warn").mockImplementation((...args) => {
		captured.push(args);
		throw new Error("synthetic startup logger fault");
	});
	const timers = spyOn(globalThis, "setTimeout");
	const faults: unknown[] = [];
	const onFault = (error: unknown) => faults.push(error);
	process.on("unhandledRejection", onFault);
	process.on("uncaughtException", onFault);
	try {
		// When startup reaches best-effort recovered-notice hydration.
		await expect(startUpdateOrchestrator(f.deps)).resolves.toBeUndefined();
		await new Promise<void>((resolve) => setImmediate(resolve));
		// Then it retains the recovered state and arms the first tick without escaping.
		expect(captured).toEqual([
			["update-orchestrator: recovered notice deferred", { error: original }],
		]);
		expect(publish).toHaveBeenCalledTimes(1);
		expect(getOrchestratorState()).toEqual(baseline);
		expect(timers.mock.calls.filter(([, ms]) => ms === 60_000)).toHaveLength(1);
		expect(faults).toEqual([]);
	} finally {
		f.cleanup();
		timers.mockRestore();
		publish.mockRestore();
		log.mockRestore();
		process.off("unhandledRejection", onFault);
		process.off("uncaughtException", onFault);
	}
});
