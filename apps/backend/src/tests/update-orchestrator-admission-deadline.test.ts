import { afterEach, expect, test } from "bun:test";
import {
	checkUpdatesNow,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	setUpdateAdmissionDeadlineTimerForTest,
	UPDATE_ADMISSION_DEADLINE_MS,
} from "../modules/system/update-orchestrator/update-admission-deadline.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	setUpdateAdmissionDeadlineTimerForTest(null);
});

function clock() {
	let now = 0;
	const timers = new Set<{ at: number; expire: () => void }>();
	setUpdateAdmissionDeadlineTimerForTest((expire, ms) => {
		const timer = { at: now + ms, expire };
		timers.add(timer);
		return () => {
			timers.delete(timer);
		};
	});
	return {
		advance: async (ms: number) => {
			now += ms;
			for (const timer of timers) {
				if (timer.at > now) continue;
				timers.delete(timer);
				timer.expire();
			}
			// Drain promise reactions, not wall-clock time or repeated verdict polls.
			for (let turn = 0; turn < 12; turn++) await Promise.resolve();
		},
		pending: () => timers.size,
	};
}

for (const action of [checkUpdatesNow, installUpdatesNow]) {
	test(`${action.name} refuses a stranded admission read by the observer deadline`, async () => {
		// Given an unresolved read shared by concurrent manual callers.
		const time = clock();
		const read = Promise.withResolvers<boolean>();
		let verdicts: Awaited<ReturnType<typeof action>>[] | undefined;
		let reads = 0;
		setOrchestratorRuntimeDepsForTest({
			isUpdateAdmissionReady: () => {
				reads++;
				return read.promise;
			},
		});
		const requests = Promise.all([action(), action()]).then((value) => {
			verdicts = value;
		});
		// When its deadline elapses, without any writer-retirement evidence.
		await time.advance(UPDATE_ADMISSION_DEADLINE_MS - 1);
		expect(verdicts).toBeUndefined();
		await time.advance(1);
		// Then both callers receive busy, while the underlying observer is still unresolved.
		expect(verdicts).toEqual([
			{ started: false, reason: "busy" },
			{ started: false, reason: "busy" },
		]);
		expect(reads).toBe(1);
		await requests;
	});
}

for (const completion of ["resolve", "reject"] as const) {
	test(`a late ${completion} cannot clear the replacement admission probe or change a timed-out verdict`, async () => {
		// Given a timed-out observer, followed by a second unresolved observer.
		const time = clock();
		const old = Promise.withResolvers<boolean>();
		const replacement = Promise.withResolvers<boolean>();
		let reads = 0;
		let firstVerdict: Awaited<ReturnType<typeof checkUpdatesNow>> | undefined;
		setOrchestratorRuntimeDepsForTest({
			isUpdateAdmissionReady: () =>
				++reads === 1 ? old.promise : replacement.promise,
		});
		const first = checkUpdatesNow().then((value) => {
			firstVerdict = value;
		});
		await time.advance(UPDATE_ADMISSION_DEADLINE_MS);
		expect(firstVerdict).toEqual({ started: false, reason: "busy" });
		const second = installUpdatesNow();
		// When the original read completes after replacement has started.
		if (completion === "resolve") old.resolve(true);
		else old.reject(new Error("late observer failure"));
		await time.advance(0);
		const third = checkUpdatesNow();
		replacement.resolve(false);
		// Then both newer callers joined the replacement, and old permission never escapes.
		expect(await Promise.all([second, third])).toEqual([
			{ started: false, reason: "busy" },
			{ started: false, reason: "busy" },
		]);
		expect(reads).toBe(2);
		expect(firstVerdict).toEqual({ started: false, reason: "busy" });
		expect(time.pending()).toBe(0);
		await first;
	});
}

test("a scheduler timeout leaves staged activation and writer settlement untouched", async () => {
	// Given a staged slot and a stranded observer, with every safety effect counted.
	const time = clock();
	const read = Promise.withResolvers<boolean>();
	let settled = false;
	const effects: string[] = [];
	setOrchestratorRuntimeDepsForTest({
		isUpdateAdmissionReady: () => read.promise,
		armOs: async () => {
			effects.push("activate");
		},
		proveOsWriterQuiescent: async () => {
			effects.push("writer-proof");
			return true;
		},
		persist: () => {
			effects.push("persist-settlement");
		},
	});
	setOrchestratorStateForTest({
		...initialOrchestratorState(0),
		phase: "os-staged",
	});
	const tick = runOrchestratorTick().then(() => {
		settled = true;
	});
	// When observer time expires without proof of recovery.
	await time.advance(UPDATE_ADMISSION_DEADLINE_MS);
	// Then the tick returns but activates nothing and publishes no settlement.
	expect(settled).toBe(true);
	expect(effects).toEqual([]);
	expect(getOrchestratorState().phase).toBe("os-staged");
	await tick;
});
