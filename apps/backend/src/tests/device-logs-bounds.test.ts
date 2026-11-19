/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { scanBudget } from "../modules/device-logs/bounds.ts";

const limits = {
	deadlineMs: 2000,
	records: 4096,
	stdoutBytes: 8 * 1024 * 1024,
} as const;

describe("journal scan budget", () => {
	test.each([
		[0, false, 2000],
		[500, false, 1500],
		[1999, false, 1],
		[2000, true, 0],
		[3000, true, 0],
		[10_001, true, 0],
	] as const)(
		"elapsed %i ms gives exhausted=%s and delay=%i ms",
		(elapsed, exhausted, delay) => {
			let now = 10_000;
			const budget = scanBudget(limits, { now: () => now });

			now += elapsed;

			expect(budget.exhausted()).toBe(exhausted);
			expect(budget.delay()).toBe(delay);
		},
	);

	test.each([
		[0, false],
		[1, false],
		[4095, false],
		[4096, true],
		[4097, true],
	] as const)("%i candidates gives exhausted=%s", (count, exhausted) => {
		const budget = scanBudget(limits, { now: () => 10_000 });

		for (let i = 0; i < count; i++) budget.take();

		expect(budget.exhausted()).toBe(exhausted);
	});

	test("candidate exhaustion skips the clock read but delay still reads it", () => {
		const reads: number[] = [];
		let now = 10_000;
		const budget = scanBudget(
			{ ...limits, records: 1 },
			{
				now: () => {
					reads.push(now);
					return now;
				},
			},
		);
		budget.take();
		now += 500;

		expect(budget.exhausted()).toBe(true);
		expect(reads).toEqual([10_000]);
		expect(budget.delay()).toBe(1500);
		expect(reads).toEqual([10_000, 10_500]);
	});

	test("stdout accumulates chunks and exceeds the limit only after 8 MiB", () => {
		const budget = scanBudget(limits, { now: () => 10_000 });

		expect(budget.overStdout(0)).toBe(false);
		expect(budget.overStdout(4 * 1024 * 1024)).toBe(false);
		expect(budget.overStdout(4 * 1024 * 1024)).toBe(false);
		expect(budget.overStdout(1)).toBe(true);
		expect(budget.overStdout(0)).toBe(true);
		expect(budget.exhausted()).toBe(false);
	});

	test("each budget uses its supplied limits and owns independent counters", () => {
		let now = 100;
		const clock = { now: () => now };
		const custom = { deadlineMs: 7, records: 2, stdoutBytes: 3 };
		const first = scanBudget(custom, clock);
		first.take();
		expect(first.exhausted()).toBe(false);
		first.take();
		expect(first.exhausted()).toBe(true);
		expect(first.overStdout(3)).toBe(false);
		expect(first.overStdout(1)).toBe(true);
		const second = scanBudget(custom, clock);

		now += 6;
		expect(second.exhausted()).toBe(false);
		expect(second.delay()).toBe(1);
		expect(second.overStdout(3)).toBe(false);
		now += 2;
		expect(second.exhausted()).toBe(true);
		expect(second.delay()).toBe(0);
	});
});
