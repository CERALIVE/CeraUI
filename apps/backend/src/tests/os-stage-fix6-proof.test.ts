import { expect, test } from "bun:test";
import { observeAdmission } from "../modules/system/update-orchestrator/os-stage-admission-snapshot.ts";
import { recoverRaucStage } from "../modules/system/update-orchestrator/os-stage-recovery.ts";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { baseline, manifest } from "./helpers/os-stage-run-inputs.ts";

test.each(["authority", "quiescence"])(
	"fresh proof rejects post-sample target change at %s",
	async (boundary) => {
		// Given a clean preliminary sample with an invalidated target during a later port call.
		let changed = false;
		let assertions = 0;
		// When the real proof seam adjudicates the port barrier.
		await expect(
			observeAdmission(
				async () => {
					return changed
						? { ...baseline, targetDevice: "foreign-target" }
						: baseline;
				},
				baseline,
				{
					deadline: performance.now() + 1000,
					now: () => performance.now(),
					sleep: (ms) => Bun.sleep(ms),
					assert: async () => {
						if (++assertions === 2 && boundary === "authority") changed = true;
					},
					quiescence: async () => {
						if (boundary === "quiescence") changed = true;
						return null;
					},
				},
			),
		).rejects.toHaveProperty("mode", "unsafe");
		// Then no clean snapshot captured before the change is returned as authority.
		expect(changed).toBe(true);
	},
);

test.each([
	"observe",
	"authority",
	"quiescence",
	"recovery-observe",
	"recovery-lock",
])("pending %s refuses at the absolute deadline", async (boundary) => {
	// Given one never-resolving port and a real monotonic deadline.
	const never = new Promise<never>(() => {});
	const started = performance.now();
	const deadline = started + 40;
	const pending = boundary.startsWith("recovery")
		? recoverRaucStage(
				{ baseline, processes: new Set(), resources: new Set() },
				{
					now: () => performance.now(),
					sleep: (ms) => Bun.sleep(ms),
					deadline,
					observe: () =>
						boundary === "recovery-observe" ? never : Promise.resolve(baseline),
					lockHeld: () =>
						boundary === "recovery-lock" ? never : Promise.resolve(true),
					cliSettled: () => true,
				},
				false,
			)
		: observeAdmission(
				() => (boundary === "observe" ? never : Promise.resolve(baseline)),
				baseline,
				{
					deadline,
					now: () => performance.now(),
					sleep: (ms) => Bun.sleep(ms),
					assert: () => (boundary === "authority" ? never : Promise.resolve()),
					quiescence: () =>
						boundary === "quiescence" ? never : Promise.resolve(null),
				},
			);
	// When an independent ceiling observes settlement, rather than releasing the stalled port.
	const result = await Promise.race([
		pending.then(
			() => "admitted",
			(error: unknown) => error,
		),
		Bun.sleep(150).then(() => "pending"),
	]);
	// Then the product has refused without waiting for I/O to resume.
	expect(result).toHaveProperty("mode", "unsafe");
});

test.each(["member", "mount", "target"])(
	"runner never dispatches after post-read admission introduces %s",
	async (residue) => {
		// Given a first failed pair and a replacement proof followed by admission work.
		const h = await harness();
		let sampled = false;
		let invalidated = false;
		let revalidations = 0;
		const observe = h.deps.observe;
		const result = runOsStageJob(manifest, h.control, {
			...h.deps,
			revalidate: async () => {
				revalidations++;
				await h.deps.revalidate();
			},
			observe: async (...args) => {
				const sample = await observe(...args);
				if (revalidations === 2) sampled = true;
				return sample;
			},
			blocked: async () => {
				if (sampled && !invalidated) {
					invalidated = true;
					h.setSnapshot({
						...baseline,
						instance: "new:1",
						processes:
							residue === "member" ? ["new:1", "foreign:9"] : ["new:1"],
						resources: residue === "mount" ? ["mount:residue"] : [],
						targetDevice:
							residue === "target" ? "foreign-target" : baseline.targetDevice,
					});
				}
				return false;
			},
		});
		// When the real runner resumes from the invalidating port.
		await expect(result).rejects.toHaveProperty("mode", "unsafe");
		// Then only the first writer was dispatched.
		expect(h.attempts()).toBe(1);
	},
);
