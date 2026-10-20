import { expect, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import {
	defaultMutationJournalFs,
	readMutationEntry,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { withJournaledModemMutation } from "../modules/modems/mutation-lease.ts";
import {
	sleepUnlessAborted,
	stopMutationRecovery,
} from "../modules/modems/mutation-recovery-owner.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import { tryAcquireModemMutation } from "../modules/streaming/lifecycle-admission.ts";
import {
	awaitRecoveryBarrier,
	isRecoveryPending,
} from "../modules/streaming/recovery-barrier.ts";
import {
	deferred,
	JournalRetryClock,
} from "./helpers/journal-reconciliation-harness.ts";
import {
	invalidateReplayRead,
	seedInterruptedMutation,
	useReplayHarness,
} from "./helpers/journal-replay-harness.ts";

const harness = useReplayHarness();
for (const useDefault of [false, true]) {
	test(`shutdown during an invalidated held retry capture requests no further sleep or rollback: default=${useDefault}`, async () => {
		// Given replay ownership with its second actual capture held.
		await seedInterruptedMutation();
		const clock = new JournalRetryClock();
		const waits: { ms: number; aborted: boolean }[] = [];
		const sleep = (ms: number, signal: AbortSignal) => {
			waits.push({ ms, aborted: signal.aborted });
			return useDefault && waits.length > 1
				? sleepUnlessAborted(ms, signal)
				: clock.sleep(ms, signal);
		};
		const first = harness.pauseRollback();
		const init = initMutationRecovery({ sleep });
		await first.entered;
		await invalidateReplayRead(harness.root());
		first.release();
		expect((await init).unreadable).toBe(1);
		const second = harness.pauseRollback();
		const finished = deferred();
		const info = spyOn(logger, "info").mockImplementation((message) => {
			if (message === "modem mutation replay finished") finished.release();
			return logger;
		});
		try {
			clock.advance();
			await second.entered;
			let lowered = 0;
			void awaitRecoveryBarrier().then(() => {
				lowered++;
			});
			// When shutdown aborts that capture and a real read fault invalidates its result.
			stopMutationRecovery();
			await invalidateReplayRead(harness.root());
			second.release();
			await finished.promise;
			for (let n = 0; n < 10; n++) await Promise.resolve();
			// Then false outcome still cancels: no already-aborted next wait is requested.
			expect(clock.waits).toEqual([1000]);
			expect(waits).toEqual([{ ms: 1000, aborted: false }]);
			expect(second.captures()).toBe(1);
			expect((await readMutationEntry("usb:b"))?.state).toBe("executing");
			expect(isRecoveryPending()).toBe(true);
			expect(lowered).toBe(0);
		} finally {
			second.release();
			info.mockRestore();
		}
	});
}

test("the default recovery sleep given an already-aborted signal arms no real timer", async () => {
	// Given a signal cancelled before entering the real default sleep.
	const own = new AbortController();
	own.abort();
	const timer = spyOn(globalThis, "setTimeout");
	const listener = spyOn(own.signal, "addEventListener");
	let resolved = false;
	try {
		// When the default sleep is called (60 s is a bound, not a latency assertion).
		const sleep = sleepUnlessAborted(60_000, own.signal).then(() => {
			resolved = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		// Then it resolves immediately with no timer or stale abort listener.
		expect(timer.mock.calls).toEqual([]);
		expect(listener.mock.calls).toEqual([]);
		expect(resolved).toBe(true);
		await sleep;
	} finally {
		for (const result of timer.mock.results) {
			if (result.type === "return") clearTimeout(result.value);
		}
		timer.mockRestore();
		listener.mockRestore();
	}
});

test("arming failure keeps its lease until held fallback bookkeeping owns the slot", async () => {
	// Given failed arming and a held fallback commit, before any hardware effect.
	await initMutationRecovery();
	const entered = deferred(),
		hold = deferred();
	let writes = 0,
		effects = 0;
	setMutationJournalDeps({
		dir: harness.root(),
		fs: {
			...defaultMutationJournalFs,
			writeTemp: async (path, data) => {
				if (++writes === 1)
					throw Object.assign(new Error("arming EIO"), { code: "EIO" });
				entered.release();
				await hold.promise;
				await defaultMutationJournalFs.writeTemp(path, data);
			},
		},
	});
	const result = withJournaledModemMutation(
		"usb:b",
		"usb-mode",
		{},
		async () => {
			effects++;
			return { confirmed: true, value: 1 };
		},
	);
	try {
		// When the fallback commit is still held, another mutation cannot replace authority.
		await Promise.race([entered.promise, result]);
		const other = tryAcquireModemMutation("usb:b");
		if (other.admitted) other.lease.release();
		expect(other).toEqual({ admitted: false, refusal: "mutation_in_progress" });
		hold.release();
		// Then failure settlement precedes lease release, with no hardware dispatch.
		expect(await result).toEqual({ ok: false, refusal: "mutation_blocked" });
		expect(effects).toBe(0);
		expect((await readMutationEntry("usb:b"))?.state).toBe("failed");
	} finally {
		hold.release();
		await result;
	}
});
