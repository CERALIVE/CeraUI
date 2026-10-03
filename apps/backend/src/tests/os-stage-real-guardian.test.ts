import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { parseOsStageSystemdProperties } from "../modules/system/update-orchestrator/os-stage-systemd.ts";
import { record } from "./helpers/os-stage-orphan-record.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";
import {
	realDeviceReply,
	realDeviceSection,
} from "./helpers/real-device-fixture.ts";
import {
	guardianObservationReply,
	guardianProductIdentity as productIdentity,
} from "./helpers/real-guardian-observation.ts";

const killedToken = "33333333-3333-4333-8333-333333333333";
const exitedToken = "44444444-4444-4444-8444-444444444444";
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
	roots.length = 0;
});

test.each([
	["running", "loaded", "active", "running", "0"],
	["failed", "loaded", "failed", "failed", "9"],
	["exited", "loaded", "active", "exited", "0"],
	["reset-absent", "not-found", "inactive", "dead", "0"],
	["stop-absent", "not-found", "inactive", "dead", "0"],
])(
	"parses the real %s full show lifecycle",
	async (stage, load, active, sub, status) => {
		const output = await realDeviceSection("rock-guardian", `${stage}-full`);
		const parsed = parseOsStageSystemdProperties(output);
		expect([
			parsed?.get("LoadState"),
			parsed?.get("ActiveState"),
			parsed?.get("SubState"),
			parsed?.get("ExecMainStatus"),
		]).toEqual([load, active, sub, status]);
	},
);

test.each([
	["running", killedToken],
	["failed", killedToken],
	["exited", exitedToken],
])(
	"accepts real %s ExecStart grammar under explicitly aliased product identity",
	async (stage, token) => {
		const output = productIdentity(
			await realDeviceSection("rock-guardian", `${stage}-properties`),
		);
		expect(isOwnedOsStageGuard(output, token ?? "")).toBe(true);
	},
);

test("refuses the actual isolated unit as a product guardian", async () => {
	const output = await realDeviceSection("rock-guardian", "running-properties");
	expect(isOwnedOsStageGuard(output, killedToken)).toBe(false);
});

test("refuses acquire when the real failed unit remains loaded", async () => {
	const stdout = await realDeviceSection("rock-guardian", "failed-load");
	const owner = createOsStageJobOwner(
		{ ...record, attemptId: killedToken },
		{
			directory: join(import.meta.dir, "unused-real-guardian-job"),
			uid: process.getuid?.() ?? -1,
			now: () => 0,
			sleep: async () => {},
			run: async () => ({ exitCode: 0, stdout, stderr: "" }),
		},
	);
	await expect(owner.acquire()).rejects.toHaveProperty(
		"reason",
		"os_update_lock_held",
	);
});

test.each([
	["failed", killedToken, false],
	["exited", exitedToken, true],
] as const)(
	"orphan settlement classifies the real acknowledged %s unit",
	async (stage, token, safe) => {
		const root = await mkdtemp(
			join(import.meta.dir, "fixtures", ".guardian-test-"),
		);
		roots.push(root);
		const directory = join(root, "job");
		const uid = process.getuid?.() ?? -1;
		// Launched: an unlaunched record now takes the shared settlement instead.
		const job = {
			...record,
			attemptId: token,
			launched: true,
			lifecycle: "releasing" as const,
		};
		await prepareOsStageJob(job, directory, uid);
		for (const file of ["ready", "release"])
			await writeFile(join(directory, file), `${token}\n`, { mode: 0o600 });
		let stopped = false;
		let sweeps = 0;
		const result = settleOsStageOrphan(await readOsStageJob(directory, uid), {
			acquireControl: acquireTestOsStageControl,
			directory,
			uid,
			lock: async () => ({
				held: () => true,
				[Symbol.asyncDispose]: async () => {},
			}),
			kernel: async () => true,
			run: async (argv) => {
				if (argv[0] === "busctl")
					return realDeviceReply("rock-guardian", "job");
				if (argv[1] === "stop") {
					stopped = true;
					return realDeviceReply("rock-guardian", "stop");
				}
				return {
					exitCode: 0,
					stdout: await guardianObservationReply(
						stopped ? "stop-absent" : stage,
					),
					stderr: "",
				};
			},
			observe: async () => record.baseline,
			cliGone: async () => true,
			liveProducer: () => null,
			sweep: async () => {
				sweeps++;
			},
		});
		if (safe) {
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
