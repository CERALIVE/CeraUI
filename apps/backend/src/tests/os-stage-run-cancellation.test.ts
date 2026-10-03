import { afterEach, expect, test } from "bun:test";
import { drainRetainedOsStagePin } from "../modules/system/update-orchestrator/os-stage-pin-retention.ts";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import { cleanupRecovery } from "./helpers/os-recovery-harness.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { manifest } from "./helpers/os-stage-run-inputs.ts";

afterEach(cleanupRecovery);

test("cancellation during recovery wins over detected transport loss", async () => {
	const h = await harness();
	await expect(
		runOsStageJob(manifest, h.control, {
			...h.deps,
			restart: async () => {
				await h.deps.restart();
				h.signal.abort();
			},
		}),
	).rejects.toHaveProperty("reason", "os_stage_cancelled_for_stream");
	expect(h.attempts()).toBe(1);
	expect(h.deps.pin.unhealthyUntil("wlan0", 4)).toBeUndefined();
	expect(h.events).toContain("release");
});

test.each(["revalidation", "receipt preparation", "reselection"])(
	"stream cancellation during %s never commits or retries",
	async (at) => {
		// Given cancellation at one asynchronous staging boundary.
		const h = await harness();
		const deps = {
			...h.deps,
			revalidate: async () => {
				if (at === "revalidation") h.signal.abort();
			},
			prepareReceipt: async () => {
				if (at === "receipt preparation") h.signal.abort();
				return () => {
					h.events.push("forbidden-commit");
					return "receipt";
				};
			},
			selection: async () => {
				const result = await h.deps.selection();
				if (at === "reselection" && h.attempts() > 0) h.signal.abort();
				return result;
			},
		};
		// When the job reaches that boundary.
		await expect(
			runOsStageJob(manifest, h.control, deps),
		).rejects.toHaveProperty("reason", "os_stage_cancelled_for_stream");
		// Then safe cleanup releases the lock, but no receipt/publication or later attempt escapes.
		expect(h.events).not.toContain("forbidden-commit");
		expect(h.events).toContain("release");
		expect(h.attempts()).toBe(
			at === "receipt preparation" ? 2 : at === "reselection" ? 1 : 0,
		);
	},
);

test("six-minute unproven recovery retains lock and writes no receipt", async () => {
	// Given the old daemon never becomes independently quiescent after failure.
	const h = await harness();
	// When the recovery deadline expires.
	const job = runOsStageJob(manifest, h.control, {
		...h.deps,
		restart: async () => {},
	});
	// Then it neither releases the owner nor authorizes another candidate or commit.
	await expect(job).rejects.toMatchObject({
		reason: "rauc_recovery_unproven",
		mode: "unsafe",
	});
	expect(h.now()).toBe(360000);
	expect(h.events).not.toContain("release");
	expect(h.events).not.toContain("prepare-receipt");
	expect(h.attempts()).toBe(1);
	await expect(h.deps.pin.sweep()).rejects.toHaveProperty("reason", "busy");
	h.makeReady();
	await drainRetainedOsStagePin(h.control.attemptId);
	await h.deps.pin.sweep();
});
