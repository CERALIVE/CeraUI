import { afterEach, expect, test } from "bun:test";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import { UpdateTransferError } from "../modules/system/update-transport/pin.ts";
import { cleanupRecovery } from "./helpers/os-recovery-harness.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { baseline, manifest } from "./helpers/os-stage-run-inputs.ts";

afterEach(cleanupRecovery);

test.each(["admission", "final settlement"])(
	"bootloader target selection at %s refuses the real job",
	async (at) => {
		const h = await harness();
		const selected = { ...baseline, bootPrimary: baseline.targetSlot };
		if (at === "admission") h.setSnapshot(selected);
		await expect(
			runOsStageJob(manifest, h.control, {
				...h.deps,
				prepareReceipt: async () => {
					h.setSnapshot(selected);
					return () => {
						h.events.push("forbidden-commit");
						return "receipt";
					};
				},
			}),
		).rejects.toHaveProperty("reason", "rauc_recovery_unproven");
		expect(h.attempts()).toBe(at === "admission" ? 0 : 2);
		expect(h.events).not.toContain("forbidden-commit");
		expect(h.events).not.toContain("release");
	},
);

test("fresh resource residue after receipt preparation fences commit and retains the lock", async () => {
	const h = await harness();
	await expect(
		runOsStageJob(manifest, h.control, {
			...h.deps,
			prepareReceipt: async () => {
				h.setSnapshot({ ...baseline, resources: ["mount:late"] });
				return () => {
					h.events.push("forbidden-commit");
					return "receipt";
				};
			},
		}),
	).rejects.toHaveProperty("reason", "rauc_recovery_unproven");
	expect(h.events).not.toContain("forbidden-commit");
	expect(h.events).not.toContain("release");
});

test("the final token check fences cancellation during the lock owner's last await", async () => {
	const h = await harness();
	let current = true;
	await expect(
		runOsStageJob(
			manifest,
			{ ...h.control, canCommit: () => current },
			{
				...h.deps,
				owner: (record) => {
					const owner = h.deps.owner(record);
					return {
						...owner,
						release: async (snapshot, clean, settle) => {
							if (settle) current = false;
							await owner.release(snapshot, clean, settle);
						},
					};
				},
			},
		),
	).rejects.toHaveProperty("reason", "os_stage_cancelled_for_stream");
	expect(h.events).not.toContain("receipt+serial+OS_STAGED");
});

test("routing teardown uncertainty never releases the job lock or manufactures a retry", async () => {
	const h = await harness();
	await expect(
		runOsStageJob(manifest, h.control, {
			...h.deps,
			pin: {
				...h.deps.pin,
				run: async () => {
					throw new AggregateError([
						new UpdateTransferError("no-route"),
						new Error("pin teardown refused"),
					]);
				},
			},
		}),
	).rejects.toMatchObject({ reason: "rauc_recovery_unproven", mode: "unsafe" });
	expect(h.events).not.toContain("release");
	expect(h.events).not.toContain("prepare-receipt");
	expect(h.attempts()).toBe(0);
});

test("reselection cannot reset the booted and target identity boundary", async () => {
	const h = await harness();
	await expect(
		runOsStageJob(manifest, h.control, {
			...h.deps,
			selection: async () => {
				const selection = await h.deps.selection();
				if (h.attempts() === 1)
					h.setSnapshot({
						...baseline,
						instance: "new:1",
						processes: ["new:1"],
						targetDevice: "179:99",
					});
				return selection;
			},
		}),
	).rejects.toHaveProperty("reason", "rauc_recovery_unproven");
	expect(h.attempts()).toBe(1);
	expect(h.events).not.toContain("prepare-receipt");
	expect(h.events).not.toContain("release");
});
