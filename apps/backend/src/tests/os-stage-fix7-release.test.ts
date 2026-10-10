import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStageDeadline } from "../modules/system/update-orchestrator/os-stage-deadline.ts";
import { createOsStageJobOwner } from "../modules/system/update-orchestrator/os-stage-job.ts";
import {
	prepareOsStageJob,
	readOsJobFile,
} from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import { proveOsStageRelease } from "../modules/system/update-orchestrator/os-stage-release-proof.ts";
import { record } from "./helpers/os-stage-orphan-record.ts";

test.each(["held", "cli", "provenance"])(
	"release proof bounds held %s evidence",
	async (boundary) => {
		// Given a held evidence port and a non-renewable 40 ms budget.
		const gate = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		const hold = async () => {
			reached.resolve();
			await gate.promise;
			return true;
		};
		const budget = createStageDeadline({
			deadline: performance.now() + 40,
			now: () => performance.now(),
		});
		const input = {
			record,
			snapshot: record.baseline,
			pinClean: true,
			budget,
			held: async () => (boundary === "held" ? hold() : true),
			cliGone: async () => (boundary === "cli" ? hold() : true),
			provenance: async () => {
				if (boundary === "provenance") await hold();
			},
		};
		const work = proveOsStageRelease(input).then(
			() => "released",
			(error: unknown) => error,
		);
		await reached.promise;
		// When the evidence is not released by the deadline.
		const result = await Promise.race([
			work,
			Bun.sleep(160).then(() => "pending"),
		]);
		try {
			expect(result).toHaveProperty("mode", "unsafe");
		} finally {
			gate.resolve();
		}
		// Then a late positive result cannot turn the failed proof into release authority.
		expect(await work).toHaveProperty("mode", "unsafe");
	},
);

test("production owner never publishes or writes release after a held read expires", async () => {
	// Given a real private job, adopted owner and a held guardian read.
	const root = await mkdtemp(join(tmpdir(), "ceraui-fix7-release-"));
	const directory = join(root, "job");
	const uid = process.getuid?.() ?? -1;
	const job = { ...record, launched: true, lifecycle: "held" as const };
	let hold = false;
	let published = false;
	const gate = Promise.withResolvers<void>();
	const reached = Promise.withResolvers<void>();
	try {
		await prepareOsStageJob(job, directory, uid);
		await writeFile(join(directory, "ready"), `${job.attemptId}\n`, {
			mode: 0o600,
		});
		const owner = createOsStageJobOwner(job, {
			directory,
			uid,
			now: () => performance.now(),
			sleep: (ms) => Bun.sleep(ms),
			run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			inspect: async () => {
				if (hold) {
					reached.resolve();
					await gate.promise;
				}
				return { kind: "live", pid: "100", invocationId: "a".repeat(32) };
			},
			kernel: async () => true,
			jobIdle: async () => true,
			cliGone: async () => true,
		});
		expect(await owner.held()).toBe(true);
		hold = true;
		const budget = createStageDeadline({
			deadline: performance.now() + 40,
			now: () => performance.now(),
		});
		const work = owner
			.release(
				job.baseline,
				true,
				() => {
					published = true;
				},
				budget,
			)
			.then(
				() => "released",
				(error: unknown) => error,
			);
		await reached.promise;
		// When the guardian read remains held past the remaining publication deadline.
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
		// Then late read completion cannot publish or release the independently held owner.
		expect(published).toBe(false);
		expect(await readOsJobFile("release", directory, uid)).toBeNull();
	} finally {
		gate.resolve();
		await rm(root, { recursive: true, force: true });
	}
});
