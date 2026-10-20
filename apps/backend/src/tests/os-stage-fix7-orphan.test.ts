import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settleOsStageOrphan } from "../modules/system/update-orchestrator/os-stage-orphan.ts";
import { absentUnit, record } from "./helpers/os-stage-orphan-record.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";

test.each(["baseline", "sweep", "final-inspection"])(
	"orphan bounds %s and retains its private directory",
	async (boundary) => {
		// Given a real private orphan directory with synthetic unit/lock/slot evidence.
		const root = await mkdtemp(join(tmpdir(), "ceraui-fix7-orphan-"));
		const directory = join(root, "job");
		await mkdir(directory, { mode: 0o700 });
		let offset = 0;
		let inspections = 0;
		const gate = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		const hold = async () => {
			offset = 9_960;
			reached.resolve();
			await gate.promise;
		};
		try {
			const work = settleOsStageOrphan(null, {
				acquireControl: acquireTestOsStageControl,
				directory,
				uid: process.getuid?.() ?? -1,
				lock: async () => ({
					held: () => true,
					[Symbol.asyncDispose]: async () => {},
				}),
				now: () => performance.now() + offset,
				sleep: (ms) => Bun.sleep(ms),
				liveProducer: () => null,
				cliGone: async () => true,
				observe: async () => {
					if (boundary === "baseline" && !offset) await hold();
					return record.baseline;
				},
				sweep: async () => {
					if (boundary === "sweep") await hold();
				},
				run: async () => {
					if (++inspections === 2 && boundary === "final-inspection")
						await hold();
					return { exitCode: 0, stdout: absentUnit(), stderr: "" };
				},
			}).then(
				() => "retired",
				(error: unknown) => error,
			);
			await reached.promise;
			// When the evidence port stays held beyond the original proof budget.
			const result = await Promise.race([
				work,
				Bun.sleep(160).then(() => "pending"),
			]);
			try {
				expect(result).toHaveProperty("mode", "unsafe");
			} finally {
				gate.resolve();
			}
			await work;
			await Bun.sleep(0);
			// Then late positive evidence cannot delete retained private ownership.
			expect((await lstat(directory)).isDirectory()).toBe(true);
		} finally {
			gate.resolve();
			await rm(root, { recursive: true, force: true });
		}
	},
);
