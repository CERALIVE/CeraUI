import { afterEach, expect, spyOn, test } from "bun:test";
import { SpawnTimeoutError } from "../helpers/bounded-spawn.ts";
import * as spawnPolicy from "../helpers/spawn-policy.ts";
import {
	isDisruptiveActionPending,
	PowerSubmissionError,
	reservePowerAction,
	resetDisruptiveActionReservationForTest,
} from "../modules/system/disruptive-action-reservation.ts";
import {
	cancelDisruptiveRetries,
	setDisruptiveRetryClockForTest,
} from "../modules/system/disruptive-retry.ts";
import {
	probeServiceCompletion,
	type ServiceCompletion,
	withServiceReservation,
} from "../modules/system/disruptive-service-reservation.ts";

afterEach(() => {
	resetDisruptiveActionReservationForTest();
	setDisruptiveRetryClockForTest(null);
});

test("a failed superseding power retry resumes the older uncertain arm resolver", async () => {
	// Given an uncertain arm whose same-action retry temporarily supersedes it.
	const callbacks: (() => Promise<void>)[] = [];
	setDisruptiveRetryClockForTest({
		schedule: (run) => {
			callbacks.push(run);
			return () => {};
		},
	});
	let settled = false;
	let probes = 0;
	await expect(
		withServiceReservation(
			async () => {
				throw new SpawnTimeoutError("arm");
			},
			{
				unit: "arm.service",
				shutdownAction: "reboot",
				decision: () => ({ allowed: true }),
			},
			async () => {
				probes++;
				return settled ? "failed" : "unknown";
			},
		),
	).rejects.toBeInstanceOf(SpawnTimeoutError);
	const retry = reservePowerAction({ allowed: true }, "reboot");
	if (!retry.allowed) throw new Error("retry refused");
	// When the observer wakes while superseded, then the retry fails positively.
	await callbacks.shift()?.();
	retry.reservation.releaseAfterFailure();
	settled = true;
	await callbacks.shift()?.();
	// Then restored uncertainty still has a resolver and can settle.
	expect(isDisruptiveActionPending()).toBe(false);
	expect(probes).toBe(2);
});

for (const evidence of ["in-flight", "unknown", "unreachable"] as const) {
	test(`uncertain service holds through ${evidence} and releases only on later positive completion`, async () => {
		// Given a failed client and a controllable evidence/backoff clock.
		const callbacks: (() => Promise<void>)[] = [];
		const delays: number[] = [];
		setDisruptiveRetryClockForTest({
			schedule: (run, ms) => {
				callbacks.push(run);
				delays.push(ms);
				return () => {};
			},
		});
		let settled = false;
		let probes = 0;
		const probe = async (): Promise<ServiceCompletion> => {
			probes++;
			if (settled) return "completed";
			if (evidence === "unreachable") throw new SpawnTimeoutError("show");
			return evidence;
		};
		await expect(
			withServiceReservation(
				async () => {
					throw new SpawnTimeoutError("restart");
				},
				{ unit: "example.service", decision: () => ({ allowed: true }) },
				probe,
			),
		).rejects.toBeInstanceOf(SpawnTimeoutError);
		// When repeated timer wakeups find no positive completion.
		for (let i = 0; i < 6; i++) {
			const next = callbacks.shift();
			if (!next) throw new Error("resolver lost");
			await next();
		}
		expect(isDisruptiveActionPending()).toBe(true);
		expect(delays).toEqual([
			2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
		]);
		settled = true;
		await callbacks.shift()?.();
		// Then actual evidence, not elapsed time, resolves exactly one hold.
		expect(isDisruptiveActionPending()).toBe(false);
		expect(probes).toBe(8);
		expect(callbacks.length).toBe(0);
	});
}

test("shutdown cancellation fences a late successful completion probe", async () => {
	// Given a resolver with one already-submitted probe.
	const reply = Promise.withResolvers<ServiceCompletion>();
	const entered = Promise.withResolvers<void>();
	setDisruptiveRetryClockForTest({
		schedule: () => {
			throw new Error("late schedule");
		},
	});
	await expect(
		withServiceReservation(
			async () => {
				throw new SpawnTimeoutError("restart");
			},
			{ unit: "example.service", decision: () => ({ allowed: true }) },
			async () => {
				entered.resolve();
				return reply.promise;
			},
		),
	).rejects.toBeInstanceOf(SpawnTimeoutError);
	await entered.promise;
	// When shutdown cancels observation before its successful reply arrives.
	cancelDisruptiveRetries();
	reply.resolve("completed");
	await Promise.resolve();
	await Promise.resolve();
	// Then cancellation cannot turn a late reply into admission clearance.
	expect(isDisruptiveActionPending()).toBe(true);
});

test("positive service exception releases without probing or scheduling", async () => {
	// Given a real positive command failure, not a client timeout.
	let probes = 0;
	// When the shared seam catches that exception.
	await expect(
		withServiceReservation(
			async () => {
				throw new PowerSubmissionError("service", 1);
			},
			{ unit: "example.service", decision: () => ({ allowed: true }) },
			async () => {
				probes++;
				return "unknown";
			},
		),
	).rejects.toBeInstanceOf(PowerSubmissionError);
	// Then no uncertain hold remains.
	expect(isDisruptiveActionPending()).toBe(false);
	expect(probes).toBe(0);
});

test("nested helper completion leaves its active outer owner held", async () => {
	// Given an owner whose outer callback invokes another protected step.
	const owner = Symbol("addon");
	const ledger: boolean[] = [];
	// When the same operation finishes its inner step and then throws positively.
	await expect(
		withServiceReservation(
			async () => {
				await withServiceReservation(async () => {}, {
					unit: "inner.service",
					owner,
					decision: () => ({ allowed: true }),
				});
				ledger.push(isDisruptiveActionPending());
				throw new PowerSubmissionError("outer", 1);
			},
			{ unit: "outer.service", owner, decision: () => ({ allowed: true }) },
		),
	).rejects.toBeInstanceOf(PowerSubmissionError);
	// Then only the outer settlement finally clears it.
	expect(ledger).toEqual([true]);
	expect(isDisruptiveActionPending()).toBe(false);
});

for (const [rows, expected] of [
	["Job=7\nActiveState=active\nSubState=running\n", "in-flight"],
	["Job=0\nActiveState=activating\nSubState=start\n", "in-flight"],
	["Job=0\nActiveState=deactivating\nSubState=stop\n", "in-flight"],
	["Job=0\nActiveState=active\nSubState=running\n", "completed"],
	["Job=\nActiveState=active\nSubState=exited\n", "completed"],
	["Job=0\nActiveState=inactive\nSubState=dead\n", "completed"],
	["Job=0\nActiveState=failed\nSubState=failed\n", "completed"],
	["ActiveState=active\nSubState=running\n", "unknown"],
	["Job=0\nJob=7\nActiveState=active\nSubState=running\n", "unknown"],
	["Job=0\nActiveState=active\n", "in-flight"],
] as const) {
	test(`systemd completion evidence ${JSON.stringify(rows)} yields ${expected}`, async () => {
		// Given literal systemd property evidence at the bounded native port.
		const run = spyOn(spawnPolicy, "spawnWithTimeout").mockResolvedValue({
			exitCode: 0,
			stdout: rows,
			stderr: "",
		});
		try {
			// When the production probe parses it.
			const result = await probeServiceCompletion(
				{ unit: "arbitrary@job.service", decision: () => ({ allowed: true }) },
				new AbortController().signal,
			);
			// Then queued work and malformed evidence are never completion.
			expect(result).toBe(expected);
		} finally {
			run.mockRestore();
		}
	});
}
