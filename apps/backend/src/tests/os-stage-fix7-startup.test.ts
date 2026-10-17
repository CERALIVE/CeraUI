import { expect, test } from "bun:test";
import { recoverOwnedOsStageAtStartup } from "../modules/system/update-orchestrator/os-stage-startup-recovery.ts";
import { harness, record } from "./helpers/os-stage-startup-harness.ts";

test.each(["restart", "drain", "sweep", "release"])(
	"startup bounds %s without late retirement",
	async (boundary) => {
		// Given a startup owner with a held outer port at 40 ms remaining.
		const h = harness();
		const started = performance.now();
		let offset = 0;
		let entered = false;
		const gate = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		const hold = async () => {
			offset = started + 359_960 - performance.now();
			entered = true;
			reached.resolve();
			await gate.promise;
		};
		const original = h.deps.owner(record);
		const owner = {
			...original,
			release: async (...args: Parameters<typeof original.release>) => {
				if (boundary === "release") await hold();
				args[2]?.();
				await original.release(...args);
			},
		};
		const work = recoverOwnedOsStageAtStartup(record, owner, {
			...h.deps,
			now: () => (entered ? performance.now() + offset : started),
			restart: async () => {
				if (boundary === "restart") await hold();
			},
			observe: async () => ({
				...record.baseline,
				instance: "660:20",
				processes: ["660:20"],
			}),
			cliGone: async () => true,
			drain: async () => {
				if (boundary === "drain") await hold();
			},
			sweep: async () => {
				if (boundary === "sweep") await hold();
			},
		}).then(
			() => "released",
			(error: unknown) => error,
		);
		try {
			expect(
				await Promise.race([
					reached.promise.then(() => "boundary-entered"),
					work.then(() => `startup-settled-before-${boundary}`),
				]),
			).toBe("boundary-entered");
			// When the outer port stays held past the original startup recovery deadline.
			const result = await Promise.race([
				work,
				Bun.sleep(160).then(() => "pending"),
			]);
			expect(result).toHaveProperty("mode", "unsafe");
		} finally {
			gate.resolve();
			await work;
		}
		await Bun.sleep(0);
		// Then no late continuation retires the owner or opens startup admission.
		expect(h.calls).not.toContain("release");
	},
);
