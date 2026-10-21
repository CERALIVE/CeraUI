import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import { UpdateStartupCadence } from "../modules/system/update-orchestrator/startup-cadence.ts";
import { retryUpdateStartup } from "../modules/system/update-orchestrator/startup-retry.ts";
import { startupCadenceClock } from "./helpers/startup-cadence-clock.ts";

const faults: unknown[] = [];
const onFault = (error: unknown) => faults.push(error);
beforeEach(() => {
	faults.length = 0;
	process.on("unhandledRejection", onFault);
	process.on("uncaughtException", onFault);
});
afterEach(async () => {
	await new Promise<void>((resolve) => setImmediate(resolve));
	process.off("unhandledRejection", onFault);
	process.off("uncaughtException", onFault);
	expect(faults).toEqual([]);
});

test("startup burst preserves retries and original failure when its warning throws", async () => {
	// Given a retryable fault and a diagnostic transport that always throws.
	const c = startupCadenceClock();
	const original = new OsStageError("os_update_lock_held");
	const log = spyOn(logger, "warn").mockImplementation(() => {
		throw new Error("synthetic logger fault");
	});
	let attempts = 0;
	try {
		// When the finite retry budget is exhausted.
		await expect(
			retryUpdateStartup(async () => {
				attempts++;
				throw original;
			}, c.clock),
		).rejects.toBe(original);
		// Then all five waits still run and diagnostics do not replace the cause.
		expect(attempts).toBe(6);
		expect(log).toHaveBeenCalledTimes(5);
		expect(c.delays).toEqual([250, 500, 1000, 2000, 4000]);
	} finally {
		log.mockRestore();
	}
});

test("startup exhaustion still arms its one background retry when reporting throws", async () => {
	// Given the post-burst warning alone has a broken transport.
	const c = startupCadenceClock();
	const cadence = new UpdateStartupCadence();
	const original = new OsStageError("os_update_lock_held");
	const log = spyOn(logger, "warn").mockImplementation((message) => {
		if (message.includes("burst exhausted"))
			throw new Error("synthetic exhaustion logger fault");
		return logger;
	});
	try {
		// When startup exhausts its ordinary burst.
		await expect(
			cadence.start(async () => {
				throw original;
			}, c.clock),
		).rejects.toBe(original);
		// Then the low-frequency unreferenced timer is installed exactly once.
		expect(c.delays).toEqual([250, 500, 1000, 2000, 4000]);
		expect(c.timers).toHaveLength(1);
		expect(c.timers[0]).toMatchObject({
			milliseconds: 30_000,
			unreferenced: true,
		});
	} finally {
		cadence.resetForTest();
		log.mockRestore();
	}
});

for (const terminal of [false, true]) {
	test(`background startup ${terminal ? "adjudicates refusal" : "reschedules"} when its logger throws`, async () => {
		// Given a background retry armed while logging still works.
		const c = startupCadenceClock();
		const cadence = new UpdateStartupCadence();
		let failure = new OsStageError("os_update_lock_held");
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		const error = spyOn(logger, "error").mockImplementation(() => logger);
		try {
			await expect(
				cadence.start(async () => {
					throw failure;
				}, c.clock),
			).rejects.toBe(failure);
			const timer = c.timers[0];
			if (!timer) throw new TypeError("background retry was not armed");
			failure = new OsStageError(
				terminal ? "rauc_recovery_unproven" : "os_update_lock_held",
			);
			const log = terminal ? error : warn;
			log.mockImplementation(() => {
				throw new Error("synthetic background logger fault");
			});
			// When that timer observes a failure with a throwing diagnostic transport.
			await expect(timer.work()).resolves.toBeUndefined();
			// Then refusal settles closed, or exactly one replacement retry remains.
			expect(c.timers).toHaveLength(terminal ? 1 : 2);
			if (terminal) expect(await cadence.waitForAdjudication()).toBe(false);
			else
				expect(c.timers[1]).toMatchObject({
					milliseconds: 30_000,
					unreferenced: true,
				});
		} finally {
			cadence.resetForTest();
			warn.mockRestore();
			error.mockRestore();
		}
	});
}
