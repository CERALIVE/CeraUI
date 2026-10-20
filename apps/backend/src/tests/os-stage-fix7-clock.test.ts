import { expect, test } from "bun:test";
import {
	assertStageDeadline,
	createStageDeadline,
	withinStageDeadline,
} from "../modules/system/update-orchestrator/os-stage-deadline.ts";

test("expired deadline never submits awaited work", async () => {
	const budget = { deadline: 40, now: () => 40 };
	let submissions = 0;
	await expect(
		withinStageDeadline(budget, async () => {
			submissions++;
		}),
	).rejects.toHaveProperty("mode", "unsafe");
	expect(submissions).toBe(0);
});

test("final clock rejects a value that resolves after expiry before the timer runs", async () => {
	let now = 0;
	const budget = { deadline: 40, now: () => now };
	await expect(
		withinStageDeadline(budget, async () => {
			now = 40;
			return true;
		}),
	).rejects.toHaveProperty("mode", "unsafe");
});

test("invalidated lifetime stays closed even if the injected clock moves back", () => {
	const budget = createStageDeadline({ deadline: 40, now: () => 0 });
	budget.invalidate();
	expect(() => assertStageDeadline(budget)).toThrow();
});
