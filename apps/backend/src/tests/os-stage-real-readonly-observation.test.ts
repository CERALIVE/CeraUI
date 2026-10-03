import { expect, test } from "bun:test";
import {
	observeRaucStage,
	processIdentity,
	type RaucObservationDeps,
} from "../modules/system/update-orchestrator/os-stage-observation.ts";
import { osInstallClientsGone } from "../modules/system/update-orchestrator/os-stage-startup.ts";
import {
	realDeviceReply,
	realDeviceSection,
} from "./helpers/real-device-fixture.ts";

async function observation() {
	const reads = new Map([
		[
			"/proc/656/stat",
			await realDeviceSection("rock-readonly", "b2-rauc-stat"),
		],
		[
			"/proc/656/cgroup",
			await realDeviceSection("rock-readonly", "b2-rauc-cgroup"),
		],
		[
			"/sys/fs/cgroup/system.slice/rauc.service/cgroup.procs",
			await realDeviceSection("rock-readonly", "b2-rauc-cgroup-procs"),
		],
		[
			"/proc/self/mountinfo",
			await realDeviceSection("rock-readonly", "b2-mountinfo"),
		],
	]);
	const replies = new Map([
		["systemctl", await realDeviceReply("rock-readonly", "b2-rauc-service")],
		["busctl", await realDeviceReply("rock-readonly", "b2-operation")],
		["rauc", await realDeviceReply("rock-readonly", "b2-status")],
	]);
	const blocks = (await realDeviceSection("rock-readonly", "b2-blocks"))
		.trim()
		.split("\n");
	const deps: RaucObservationDeps = {
		read: async (path) => {
			const value = reads.get(path);
			if (value !== undefined) return value;
			throw Object.assign(new Error("not present in idle capture"), {
				code: "ENOENT",
			});
		},
		list: async () => blocks,
		run: async (argv) =>
			replies.get(argv[0] ?? "") ?? {
				exitCode: 1,
				stdout: "",
				stderr: "uncaptured",
			},
		device: async (path) => (path.endsWith("rootfs_a") ? "45922" : "45923"),
		rootDevice: async () => "45922",
		bootId: async () => "11111111-1111-4111-8111-111111111111",
		healthy: async () => null,
	};
	return { deps, reads };
}

test("parses the new RAUC status, Operation, cgroup, stat and mount/block inventory without inventing resources", async () => {
	const { deps } = await observation();
	const result = await observeRaucStage(
		{ processes: new Set(), resources: new Set() },
		deps,
	);
	expect({
		instance: result?.instance,
		operation: result?.operation,
		resources: result?.resources,
		bootPrimary: result?.bootPrimary,
		targetInactive: result?.targetInactive,
	}).toEqual({
		instance: "656:879",
		operation: "idle",
		resources: [],
		bootPrimary: "rootfs.0",
		targetInactive: true,
	});
});

test("NBD attribution accepts the real unified-cgroup `0::/<path>` row", async () => {
	// Given the captured RAUC cgroup row and a test-constructed nbd0 owned by RAUC's pid.
	const { deps, reads } = await observation();
	reads.set("/sys/block/nbd0/pid", "656\n");
	const blocks = await deps.list("/sys/block");
	// When the production NBD attribution parses the captured row.
	const result = await observeRaucStage(
		{ processes: new Set(), resources: new Set() },
		{ ...deps, list: async () => [...blocks, "nbd0"] },
	);
	// Then the grammar is accepted rather than failing closed to null.
	expect(result?.resources).toEqual(["nbd:nbd0:656:879"]);
});

test.each([
	["rock-readonly", "b2-rauc-stat", "656", "656:879"],
	["rock-guardian", "proc-stat-1168323", "1168323", "1168323:3844223"],
] as const)(
	"parses real %s %s process start identity",
	async (board, section, pid, expected) => {
		const raw = await realDeviceSection(board, section);
		expect(processIdentity(pid, raw)).toBe(expected);
	},
);

test("recognises the actual base64 NUL-separated RAUC service inventory as no installer client", async () => {
	const inventory = (await realDeviceSection("rock-readonly", "b2-clients"))
		.trim()
		.split("\n");
	const commands = new Map(
		inventory.map((line) => {
			const [pid = "", , encoded = ""] = line.split(" ");
			return [pid, Buffer.from(encoded, "base64").toString()] as const;
		}),
	);
	const result = await osInstallClientsGone(undefined, {
		list: async () => [...commands.keys()],
		read: async (path) => commands.get(path.split("/")[2] ?? "") ?? "",
	});
	expect(result).toBe(true);
});
