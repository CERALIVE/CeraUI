import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isOsStageGuardJobIdle,
	parseOsStageGuardObservation,
} from "../modules/system/update-orchestrator/os-stage-guard-observation.ts";
import {
	prepareOsStageJob,
	readOsJobFile,
	readOsStageJob,
} from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import { settleOsStageOrphan } from "../modules/system/update-orchestrator/os-stage-orphan.ts";
import { updatePinsClean } from "../modules/system/update-orchestrator/os-stage-unlaunched-effects.ts";
import { record } from "./helpers/os-stage-orphan-record.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";
import {
	realDeviceReply,
	realDeviceSection,
} from "./helpers/real-device-fixture.ts";
import { guardianObservationReply as observationReply } from "./helpers/real-guardian-observation.ts";

const killedToken = "33333333-3333-4333-8333-333333333333";
const exitedToken = "44444444-4444-4444-8444-444444444444";
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
	roots.length = 0;
});

const EXTRA = ["ControlPID", "Restart", "ExecMainCode", "InvocationID"];

test.each([
	["immediate", killedToken, { kind: "live", pid: "1168323" }],
	["running", killedToken, { kind: "live", pid: "1168323" }],
	[
		"failed",
		killedToken,
		{ kind: "terminal", cleanExit: false, exitStatus: 9 },
	],
	["exited", exitedToken, { kind: "terminal", cleanExit: true, exitStatus: 0 }],
	["reset-absent", killedToken, { kind: "absent" }],
	["stop-absent", exitedToken, { kind: "absent" }],
] as const)(
	"the real %s guardian reply parses to its lifecycle shape",
	async (stage, token, shape) => {
		expect(
			parseOsStageGuardObservation(await observationReply(stage), token),
		).toMatchObject(shape);
	},
);

test("every extra observation property is present in the real loaded replies", async () => {
	for (const stage of ["running", "failed", "exited"]) {
		const reply = await observationReply(stage);
		for (const key of EXTRA) expect(reply).toContain(`\n${key}=`);
	}
});

test("the real zero-job tuple is the only idle answer", async () => {
	const job = await realDeviceReply("rock-guardian", "job");
	expect(await isOsStageGuardJobIdle(async () => job)).toBe(true);
	expect(
		await isOsStageGuardJobIdle(async () => ({
			...job,
			stdout: '(uo) 77 "/org/freedesktop/systemd1/job/77"\n',
		})),
	).toBe(false);
});

type Shape = "failed" | "exited";
async function terminalJob(shape: Shape) {
	const root = await mkdtemp(join(tmpdir(), "ceraui-real-terminal-"));
	roots.push(root);
	const directory = join(root, "job");
	const uid = process.getuid?.() ?? -1;
	const token = shape === "failed" ? killedToken : exitedToken;
	const job = {
		...record,
		attemptId: token,
		lifecycle: shape === "failed" ? ("held" as const) : ("releasing" as const),
	};
	await prepareOsStageJob(job, directory, uid);
	await writeFile(join(directory, "ready"), `${token}\n`, { mode: 0o600 });
	if (shape === "exited")
		await writeFile(join(directory, "release"), `${token}\n`, { mode: 0o600 });
	return { directory, uid, token };
}

test.each([
	["failed", "reset", "reset-absent", "reset-failed"],
	["exited", "stop", "stop-absent", "stop"],
] as const)(
	"an owned real %s unlaunched unit settles through %s with real replies",
	async (shape, action, after, verb) => {
		// Given an externally killed (or normally released) unlaunched guardian.
		const { directory, uid, token } = await terminalJob(shape);
		let settled = false;
		const commands: string[] = [];
		const witnesses: string[] = [];
		const run = async (argv: string[]) => {
			commands.push(argv.slice(0, 2).join(" "));
			if (argv[0] === "busctl") return realDeviceReply("rock-guardian", "job");
			if (argv[1] === verb) {
				settled = true;
				return realDeviceReply("rock-guardian", action);
			}
			if (argv[1] === "show")
				return {
					stdout: await observationReply(settled ? after : shape),
					stderr: "",
					exitCode: 0,
				};
			throw new Error(`unexpected ${argv.join(" ")}`);
		};
		// When startup settlement runs over the real unit replies.
		const result = await settleOsStageOrphan(
			await readOsStageJob(directory, uid),
			{
				acquireControl: acquireTestOsStageControl,
				directory,
				uid,
				run,
				lock: async () => ({
					held: () => true,
					[Symbol.asyncDispose]: async () => {},
				}),
				observe: async () => record.baseline,
				cliGone: async () => true,
				liveProducer: () => null,
				sweep: async () => {},
				unlaunched: {
					kernel: async () => true,
					pinClean: async () => true,
					outcomesAbsent: async () => true,
					drain: async () => {},
					witness: (witness) => {
						witnesses.push(witness.attemptId);
					},
				},
			},
		);
		// Then only the owned terminal action ran, no token was invented, and the job retired.
		expect(result).toBe(true);
		expect(
			commands.filter(
				(command) =>
					!command.startsWith("systemctl show") &&
					!command.startsWith("busctl"),
			),
		).toEqual([`systemctl ${verb}`]);
		expect(witnesses).toEqual([token]);
		expect(await readOsStageJob(directory, uid)).toBeNull();
		if (shape === "failed")
			expect(await readOsJobFile("release", directory, uid)).toBeNull();
	},
);

test("an unrecorded real failed unit is never reset", async () => {
	const stdout = await realDeviceSection("rock-guardian", "failed-load");
	const commands: string[] = [];
	await expect(
		settleOsStageOrphan(null, {
			acquireControl: acquireTestOsStageControl,
			directory: join(tmpdir(), "ceraui-real-terminal-absent-dir"),
			uid: process.getuid?.() ?? -1,
			run: async (argv) => {
				commands.push(argv.join(" "));
				return { stdout, stderr: "", exitCode: 0 };
			},
			lock: async () => ({
				held: () => true,
				[Symbol.asyncDispose]: async () => {},
			}),
			observe: async () => record.baseline,
			cliGone: async () => true,
			liveProducer: () => null,
			sweep: async () => {},
		}),
	).resolves.toBe(false);
	expect(commands.some((command) => command.includes("reset-failed"))).toBe(
		false,
	);
});

test("real never-created pin tables (exit 2) and empty rule sets prove a clean pin", async () => {
	const reply = async (args: string[]) => {
		const family = args[0] === "-6" ? "6" : "4";
		const section = args.includes("rule")
			? `b2-rules${family}`
			: `routes-${args.at(-1)}-${family}`;
		const real = await realDeviceReply("rock-readonly", section);
		if (real.exitCode !== 0)
			throw Object.assign(new Error(`exit ${real.exitCode}`), {
				stderr: real.stderr,
			});
		return real.stdout;
	};
	expect(await updatePinsClean(async (_bin, args) => reply(args))).toBe(true);
	expect(
		await updatePinsClean(async (_bin, args) =>
			args.includes("rule")
				? `${await reply(args)}120:\tfrom all uidrange 42043-42043 lookup 100001\n`
				: reply(args),
		),
	).toBe(false);
});
