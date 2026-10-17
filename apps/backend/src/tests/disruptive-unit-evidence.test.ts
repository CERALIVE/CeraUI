import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as spawnPolicy from "../helpers/spawn-policy.ts";
import {
	runDisruptiveSysextStep,
	setSysextEvidenceForTest,
} from "../modules/addons/disruptive-sysext-step.ts";
import { isDisruptiveActionPending } from "../modules/system/disruptive-action-reservation.ts";
import { setDisruptiveRetryClockForTest } from "../modules/system/disruptive-retry.ts";
import { probeServiceCompletion } from "../modules/system/disruptive-service-reservation.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { sysextFixture } from "./sysext-action-fixture.ts";

useSessionOwnerForFile();
let fixture: ReturnType<typeof sysextFixture>;
beforeEach(() => {
	fixture = sysextFixture();
	setSysextEvidenceForTest({ procRoot: "/unused-fixture-proc" });
	setDisruptiveRetryClockForTest({ schedule: () => () => undefined });
});
afterEach(() => {
	setDisruptiveRetryClockForTest(null);
	fixture.reset();
});

for (const [unit, active, sub, job, expected] of [
	["addon.socket", "active", "listening", "0", "completed"],
	["addon.timer", "active", "waiting", "0", "completed"],
	["addon.path", "active", "waiting", "0", "completed"],
	["addon.target", "active", "active", "0", "completed"],
	["addon.mount", "active", "mounted", "0", "completed"],
	["addon.service", "active", "running", "0", "completed"],
	["addon.service", "active", "exited", "0", "completed"],
	["addon.socket", "active", "listening", "7", "in-flight"],
	["addon.timer", "activating", "waiting", "0", "in-flight"],
	["addon.service", "active", "listening", "0", "in-flight"],
	["addon.service", "active", "waiting", "0", "in-flight"],
	["addon.service", "active", "active", "0", "in-flight"],
	["addon.socket", "active", "running", "0", "in-flight"],
	["addon.path", "active", "listening", "0", "in-flight"],
	["addon.unknown", "active", "waiting", "0", "in-flight"],
] as const) {
	test(`unit-specific settlement ${unit}/${active}/${sub}/job=${job} yields ${expected}`, async () => {
		// Given literal systemd evidence at an injected command boundary, never the host.
		const rows = `Job=${job}\nActiveState=${active}\nSubState=${sub}\n`;
		const run = spyOn(spawnPolicy, "spawnWithTimeout").mockResolvedValue({
			exitCode: 0,
			stdout: rows,
			stderr: "",
		});
		try {
			// When the production resolver and sysext unit seam observe an uncertain start.
			const answer = await probeServiceCompletion(
				{ unit, decision: () => ({ allowed: true }) },
				new AbortController().signal,
			);
			await runDisruptiveSysextStep(
				"start-unit",
				async () => {
					throw new Error("client uncertain");
				},
				{ unit },
			).catch(() => undefined);
			for (let i = 0; i < 30; i++) await Promise.resolve();
			// Then only a no-job state coherent with that unit type releases its hold.
			expect(answer).toBe(expected);
			expect(isDisruptiveActionPending()).toBe(expected === "in-flight");
		} finally {
			run.mockRestore();
		}
	});
}
