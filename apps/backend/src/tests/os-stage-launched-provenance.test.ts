import { expect, test } from "bun:test";
import {
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOsStageJobOwner } from "../modules/system/update-orchestrator/os-stage-job.ts";
import {
	type OsStageJobRecord,
	prepareOsStageJob,
	readOsJobFile,
	writePrivateOsJobFile,
} from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import { guardTest } from "./helpers/os-guard-harness.ts";
import { record as orphanRecord } from "./helpers/os-stage-orphan-record.ts";

const record: OsStageJobRecord = { ...orphanRecord, launched: false };
const uid = process.getuid?.() ?? -1;

const tampering: Readonly<
	Record<string, (directory: string, current: OsStageJobRecord) => unknown>
> = {
	"a replaced job.json": (directory, current) =>
		writePrivateOsJobFile(
			"job.json",
			JSON.stringify({ ...current, candidateKey: "forged-candidate" }),
			directory,
		),
	"a corrupted job.json": (directory) =>
		writePrivateOsJobFile("job.json", "{not-json", directory),
	"a forged token": (directory) =>
		writePrivateOsJobFile(
			"token",
			"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\n",
			directory,
		),
	"a foreign private entry": (directory) =>
		writeFile(join(directory, "foreign"), "", { mode: 0o600 }),
	"a replaced directory inode keeping a valid old ready token": async (
		directory,
	) => {
		await rename(directory, `${directory}.old`);
		await mkdir(directory, { mode: 0o700 });
		await chmod(directory, 0o700);
		for (const name of ["token", "job.json", "ready"]) {
			await copyFile(join(`${directory}.old`, name), join(directory, name));
			await chmod(join(directory, name), 0o600);
		}
	},
};

for (const [name, tamper] of Object.entries(tampering))
	guardTest(
		`launched release refuses ${name} and keeps provenance`,
		record,
		async (h) => {
			// Given a real launched owner whose guardian published `ready`.
			await h.owner.acquire();
			const snapshot = h.owner.record().baseline;
			h.owner.remember(snapshot, true, true);
			// When the private directory drifts after the owner's last write.
			await tamper(h.directory, h.owner.record());
			let published = false;
			await expect(
				h.owner.release(snapshot, true, () => {
					published = true;
				}),
			).rejects.toMatchObject({
				reason: "rauc_recovery_unproven",
				diagnostics: { refusal: "private-provenance-mismatch" },
			});
			// Then no callback, marker or retirement runs and the lock stays held.
			expect(published).toBe(false);
			expect(await Bun.file(join(h.directory, "release")).exists()).toBe(false);
			expect(await readOsJobFile("ready", h.directory, uid)).toBe(
				`${record.attemptId}\n`,
			);
			expect(
				h.commands.some(
					(argv) => argv[1] === "stop" || argv[1] === "reset-failed",
				),
			).toBe(false);
			expect(await h.contender()).toBe(75);
		},
	);

test("an adopted owner keeps the identity proven at adoption", async () => {
	// Given startup adoption: a recorded job whose first held() proof captures provenance.
	const root = await mkdtemp(join(tmpdir(), "ceraui-adopted-provenance-"));
	const directory = join(root, "job");
	const job = { ...record, launched: true, lifecycle: "held" as const };
	const commands: string[] = [];
	let now = 0;
	try {
		await prepareOsStageJob(job, directory, uid);
		await writeFile(join(directory, "ready"), `${job.attemptId}\n`, {
			mode: 0o600,
		});
		const owner = createOsStageJobOwner(job, {
			directory,
			uid,
			run: async (argv) => {
				commands.push(argv.join(" "));
				return { exitCode: 0, stdout: "", stderr: "" };
			},
			cliGone: async () => true,
			inspect: async () => ({ kind: "live", pid: "100", invocationId: "a" }),
			kernel: async () => true,
			jobIdle: async () => true,
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
		});
		expect(await owner.held()).toBe(true);
		// When the directory inode is replaced by an identical-looking copy.
		await tampering[
			"a replaced directory inode keeping a valid old ready token"
		]?.(directory, job);
		// Then release refuses instead of re-capturing the replacement.
		await expect(owner.release(job.baseline, true)).rejects.toMatchObject({
			diagnostics: { refusal: "private-provenance-mismatch" },
		});
		expect(await Bun.file(join(directory, "release")).exists()).toBe(false);
		expect(
			commands.some((command) => / stop | reset-failed /.test(command)),
		).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
