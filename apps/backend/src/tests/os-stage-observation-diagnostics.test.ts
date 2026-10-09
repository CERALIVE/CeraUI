import { afterEach, expect, test } from "bun:test";
import { SpawnTimeoutError } from "../helpers/spawn-policy.ts";
import {
	observeRaucStage,
	type RaucObservationDeps,
} from "../modules/system/update-orchestrator/os-stage-observation.ts";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import { recordedAdmissionDeps as recorded } from "./helpers/os-admission-recorded.ts";
import { cleanupRecovery } from "./helpers/os-recovery-harness.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { manifest } from "./helpers/os-stage-run-inputs.ts";

afterEach(cleanupRecovery);

type Fault = {
	readonly stage: string;
	readonly deps: Partial<RaucObservationDeps>;
};
const denied = Object.assign(
	new Error("EACCES: permission denied, open '/private/token-secret'"),
	{ code: "EACCES" },
);
const readFault = (path: string): Partial<RaucObservationDeps> => ({
	read: async (current) => {
		if (current === path) throw denied;
		return recorded.read(current);
	},
});
const commandFault = (name: string): Partial<RaucObservationDeps> => ({
	run: async (argv, options) => {
		if (argv[0] === name) throw new SpawnTimeoutError(name);
		return recorded.run(argv, options);
	},
});
const withNbd = (pid: string, fault: string): Partial<RaucObservationDeps> => ({
	list: async () => ["nbd0"],
	read: async (path) => {
		if (path === fault) throw denied;
		if (path === "/sys/block/nbd0/pid") return pid;
		return recorded.read(path);
	},
});
const faults: Fault[] = [
	{ stage: "service-command", deps: commandFault("systemctl") },
	{ stage: "daemon-process", deps: readFault("/proc/650/stat") },
	{
		stage: "cgroup-processes",
		deps: readFault("/sys/fs/cgroup/system.slice/rauc.service/cgroup.procs"),
	},
	{
		stage: "block-inventory",
		deps: {
			list: async () => {
				throw denied;
			},
		},
	},
	{ stage: "nbd-pid", deps: withNbd("650", "/sys/block/nbd0/pid") },
	{ stage: "nbd-process", deps: withNbd("651", "/proc/651/stat") },
	{ stage: "nbd-cgroup", deps: withNbd("650", "/proc/650/cgroup") },
	{
		stage: "dm-identity",
		deps: { ...readFault("/sys/block/dm-0/dev"), list: async () => ["dm-0"] },
	},
	{
		stage: "dm-slaves",
		deps: {
			list: async (path) => {
				if (path.endsWith("slaves")) throw denied;
				return ["dm-0"];
			},
			read: async (path) =>
				path.startsWith("/sys/block/dm-0/") ? "253:0" : recorded.read(path),
		},
	},
	{ stage: "mountinfo", deps: readFault("/proc/self/mountinfo") },
	{ stage: "operation-command", deps: commandFault("busctl") },
	{ stage: "status-command", deps: commandFault("rauc") },
	{
		stage: "status-parse",
		deps: {
			run: async (argv, options) =>
				argv[0] === "rauc"
					? { exitCode: 0, stdout: "{", stderr: "" }
					: recorded.run(argv, options),
		},
	},
	{
		stage: "boot-id",
		deps: {
			bootId: async () => {
				throw denied;
			},
		},
	},
	{
		stage: "healthy-state",
		deps: {
			healthy: async () => {
				throw denied;
			},
		},
	},
	{
		stage: "booted-device",
		deps: {
			device: async () => {
				throw denied;
			},
		},
	},
	{
		stage: "root-device",
		deps: {
			rootDevice: async () => {
				throw denied;
			},
		},
	},
	{
		stage: "activation-marker",
		deps: readFault("/data/ceralive/update-state/activation-armed"),
	},
	{
		stage: "target-device",
		deps: {
			device: async (path) => {
				if (path.endsWith("rootfs_b")) throw denied;
				return recorded.device(path);
			},
		},
	},
];

async function refuse(deps: Partial<RaucObservationDeps>): Promise<unknown> {
	const h = await harness();
	try {
		await runOsStageJob(manifest, h.control, {
			...h.deps,
			observe: (tracked, _deps, report) =>
				observeRaucStage(tracked, { ...recorded, ...deps }, report),
		});
	} catch (error) {
		// The refusal precedes the guardian, the pin and the installer.
		expect(h.events).toEqual([]);
		return error;
	}
	throw new Error("admission unexpectedly passed");
}

test.each(faults)(
	"names the swallowed $stage exception at runner admission",
	async ({ stage, deps }) => {
		// Given complete post-refusal Rock inputs with one fault at one boundary.
		// When the real runner observes its initial admission baseline.
		const error = await refuse(deps);
		// Then admission is unchanged and the stopped boundary is diagnosed.
		expect(error).toMatchObject({
			reason: "rauc_recovery_unproven",
			mode: "unsafe",
			diagnostics: {
				refusal: "stage-admission-unproven",
				predicate: "observation-unknown",
				observation: expect.stringMatching(new RegExp(`^${stage}: \\w+`)),
			},
		});
	},
);

const answerWith = (
	name: string,
	exitCode: number,
): Partial<RaucObservationDeps> => ({
	run: async (argv, options) =>
		argv[0] === name
			? { exitCode, stdout: "", stderr: "" }
			: recorded.run(argv, options),
});
const nullReturns: Fault[] = [
	{ stage: "service-properties", deps: answerWith("systemctl", 0) },
	{ stage: "status-command", deps: answerWith("rauc", 1) },
	{
		stage: "daemon-process",
		deps: {
			read: async (path) => {
				if (path === "/proc/650/stat")
					throw Object.assign(new Error("gone"), { code: "ENOENT" });
				return recorded.read(path);
			},
		},
	},
];

test.each(nullReturns)(
	"names the $stage null-return refusal",
	async ({ stage, deps }) => {
		// Given one boundary that answers without proving the RAUC state.
		// When the runner observes its admission baseline.
		const error = await refuse(deps);
		// Then the refusal names the boundary rather than an exception.
		expect(error).toMatchObject({
			diagnostics: {
				predicate: "observation-unknown",
				observation: `${stage}: unproven`,
			},
		});
	},
);

test("bounds and redacts exception text without changing null semantics", async () => {
	// Given a read error containing paths, URL credentials and a long message.
	const error = new Error(
		`permission denied '/private/my-secret' https://user:password@example.test/?token=secret token=secret ${"x".repeat(500)}`,
	);
	// When admission observes that error through the production runner.
	const caught = await refuse({
		healthy: async () => {
			throw error;
		},
	});
	// Then only bounded, redacted diagnostic text reaches callers.
	if (!(caught instanceof Error) || !("diagnostics" in caught)) throw caught;
	const observation = JSON.stringify(caught.diagnostics);
	expect(observation).toContain("healthy-state: Error:");
	expect(observation).not.toContain("my-secret");
	expect(observation).not.toContain("password");
	expect(observation).not.toContain("token=secret");
	expect(
		(caught.diagnostics as { observation: string }).observation.length,
	).toBeLessThanOrEqual(200);
});

test("a throwing diagnostic sink leaves the observation's null result", async () => {
	// Given a fault and a report callback that itself throws.
	const result = await observeRaucStage(
		{ processes: new Set(), resources: new Set() },
		{ ...recorded, ...readFault("/proc/self/mountinfo") },
		() => {
			throw new Error("sink down");
		},
	);
	// Then the observer still returns its refusal instead of throwing.
	expect(result).toBeNull();
});
