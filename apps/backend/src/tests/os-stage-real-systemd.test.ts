import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createOsStageJobOwner,
	isOwnedOsStageGuard,
} from "../modules/system/update-orchestrator/os-stage-job.ts";
import {
	prepareOsStageJob,
	readOsStageJob,
} from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import { settleOsStageOrphan } from "../modules/system/update-orchestrator/os-stage-orphan.ts";
import { reconcileOsStageStartup } from "../modules/system/update-orchestrator/os-stage-startup.ts";
import { record } from "./helpers/os-stage-orphan-record.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";
import { realDeviceSection } from "./helpers/real-device-fixture.ts";

const attemptId = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
	roots.length = 0;
});

test("owns the live systemd 257 guardian when empty exec lists are omitted", async () => {
	const output = await realDeviceSection("opi", "guardian");
	const owned = isOwnedOsStageGuard(output, attemptId);
	expect(owned).toBe(true);
});

test.each(["ExecStartPre", "ExecStartPost", "ExecStop", "ExecStopPost"])(
	"refuses a foreign nonempty %s in the real guardian output",
	async (key) => {
		const output = `${await realDeviceSection("opi", "guardian")}${key}={ path=/bin/true ; argv[]=/bin/true }\n`;
		const owned = isOwnedOsStageGuard(output, attemptId);
		expect(owned).toBe(false);
	},
);

test.each([
	"Id",
	"FragmentPath",
	"Description",
	"Transient",
	"Type",
	"RemainAfterExit",
	"User",
	"DropInPaths",
	"ExecStart",
])("refuses the real guardian when mandatory %s is absent", async (key) => {
	const output = (await realDeviceSection("opi", "guardian"))
		.split("\n")
		.filter((line) => !line.startsWith(`${key}=`))
		.join("\n");
	const owned = isOwnedOsStageGuard(output, attemptId);
	expect(owned).toBe(false);
});

test.each([
	[
		"description",
		(text: string) =>
			text.replace(
				"Description=CeraLive OS stage lock",
				"Description=Foreign stage lock",
			),
	],
	[
		"attempt",
		(text: string) =>
			text.replaceAll(attemptId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
	],
	["duplicate", (text: string) => `${text}User=\n`],
	["truncated argv", (text: string) => text.replace(` ${attemptId} ;`, " ;")],
	[
		"truncated suffix",
		(text: string) => text.replace(" ; status=0/0 }", " ; status=0/0"),
	],
])("refuses tampered real guardian %s", async (_name, mutate) => {
	const output = mutate(await realDeviceSection("opi", "guardian"));
	const owned = isOwnedOsStageGuard(output, attemptId);
	expect(owned).toBe(false);
});

test("accepts explicitly empty exec lists as well as the omitted real lists", async () => {
	const output = `${await realDeviceSection("opi", "guardian")}ExecStartPre=\nExecStartPost=\nExecStop=\nExecStopPost=\n`;
	const owned = isOwnedOsStageGuard(output, attemptId);
	expect(owned).toBe(true);
});

test("acquires through real absent LoadState and live show replies", async () => {
	const root = await mkdtemp(join(tmpdir(), "ceraui-real-guard-"));
	roots.push(root);
	const directory = join(root, "job");
	// The OPI receipt carries the product subset and LoadState of this exact
	// guardian; the four lifecycle keys the observation also requests were only
	// captured on the Rock guardian lifecycle, and ControlGroup is the OPI's own.
	const lifecycle = (await realDeviceSection("rock-guardian", "running-full"))
		.split("\n")
		.filter((line) =>
			["ControlPID=", "Restart=", "ExecMainCode=", "InvocationID="].some(
				(key) => line.startsWith(key),
			),
		);
	const group = (await realDeviceSection("opi", "guardian-cgroup"))
		.trim()
		.replace(/^0::/, "");
	const live = `${await realDeviceSection("opi", "orphan-live")}${lifecycle.join("\n")}\nControlGroup=${group}\n`;
	const absent = await realDeviceSection("opi", "absent-load");
	const job = { ...record, attemptId };
	const owner = createOsStageJobOwner(job, {
		kernel: async () => true,
		directory,
		uid: process.getuid?.() ?? -1,
		now: () => 0,
		sleep: async () => {},
		run: async (argv) => {
			if (argv[0] === "systemd-run")
				await writeFile(join(directory, "ready"), `${attemptId}\n`, {
					mode: 0o600,
					flag: "wx",
				});
			return {
				exitCode: 0,
				stderr: "",
				stdout: argv.includes("--property=LoadState") ? absent : live,
			};
		},
	});
	await owner.acquire();
	expect((await readOsStageJob(directory, process.getuid?.()))?.lifecycle).toBe(
		"held",
	);
});

test.each(["opi", "rock"] as const)(
	"startup recognises %s real absent LoadState",
	async (board) => {
		const stdout = await realDeviceSection(board, "absent-load");
		const result = await reconcileOsStageStartup({
			acquireControl: acquireTestOsStageControl,
			readJob: async () => null,
			run: async () => ({ exitCode: 0, stdout, stderr: "" }),
			liveProducer: () => null,
			orphan: async () => false,
			sweep: async () => {},
		});
		expect(result).toEqual({ kind: "none" });
	},
);

test("startup refuses real loaded state without a private job", async () => {
	const stdout = await realDeviceSection("opi", "live-load");
	const result = reconcileOsStageStartup({
		acquireControl: acquireTestOsStageControl,
		readJob: async () => null,
		run: async () => ({ exitCode: 0, stdout, stderr: "" }),
		liveProducer: () => null,
	});
	await expect(result).rejects.toHaveProperty(
		"reason",
		"rauc_recovery_unproven",
	);
});

test.each(["absent", "live", "duplicate"] as const)(
	"orphan inspection handles real %s property rows by key",
	async (kind) => {
		const root = await mkdtemp(join(tmpdir(), "ceraui-real-orphan-"));
		roots.push(root);
		const directory = join(root, "job");
		const uid = process.getuid?.() ?? -1;
		await prepareOsStageJob(record, directory, uid);
		const stdout =
			kind === "live"
				? await realDeviceSection("opi", "orphan-live")
				: `${await realDeviceSection("opi", "orphan-absent")}${kind === "duplicate" ? "LoadState=not-found\n" : ""}`;
		let sweeps = 0;
		const result = settleOsStageOrphan(await readOsStageJob(directory, uid), {
			acquireControl: acquireTestOsStageControl,
			unlaunched: {
				kernel: async () => true,
				pinClean: async () => true,
				outcomesAbsent: async () => true,
				witness: () => undefined,
			},
			directory,
			uid,
			lock: async () => ({
				held: () => true,
				[Symbol.asyncDispose]: async () => {},
			}),
			run: async () => ({ exitCode: 0, stdout, stderr: "" }),
			observe: async () => record.baseline,
			cliGone: async () => true,
			liveProducer: () => null,
			sweep: async () => {
				sweeps++;
			},
		});
		if (kind === "absent") {
			expect(await result).toBe(true);
			expect(sweeps).toBe(1);
		} else {
			await expect(result).rejects.toHaveProperty(
				"reason",
				"rauc_recovery_unproven",
			);
			expect(sweeps).toBe(0);
		}
	},
);
