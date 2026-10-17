import { expect, test } from "bun:test";
import {
	observeRaucStage,
	processIdentity,
	type RaucObservationDeps,
} from "../modules/system/update-orchestrator/os-stage-observation.ts";
import { osInstallClientsGone } from "../modules/system/update-orchestrator/os-stage-startup.ts";
import type { readHealthyState } from "../modules/system/update-orchestrator/slot-sync-state.ts";
import { realDeviceSection } from "./helpers/real-device-fixture.ts";

async function captureDeps() {
	const read = new Map([
		["/proc/656/stat", await realDeviceSection("rock", "rauc-stat")],
		["/proc/656/cgroup", await realDeviceSection("rock", "rauc-cgroup")],
		[
			"/sys/fs/cgroup/system.slice/rauc.service/cgroup.procs",
			await realDeviceSection("rock", "rauc-cgroup-procs"),
		],
		["/proc/self/mountinfo", await realDeviceSection("rock", "mountinfo")],
	]);
	const outputs = new Map([
		["systemctl", await realDeviceSection("rock", "rauc-service")],
		["busctl", await realDeviceSection("rock", "operation")],
		["rauc", await realDeviceSection("rock", "status")],
	]);
	const bootId = (await realDeviceSection("rock", "boot-id")).trim();
	const blocks = (await realDeviceSection("rock", "blocks")).trim().split("\n");
	const healthy: Awaited<ReturnType<typeof readHealthyState>> = JSON.parse(
		await realDeviceSection("rock", "healthy"),
	);
	const deps: RaucObservationDeps = {
		read: async (path) => {
			const value = read.get(path);
			if (value !== undefined) return value;
			throw Object.assign(new Error("not captured"), { code: "ENOENT" });
		},
		list: async () => blocks,
		run: async (argv) => ({
			exitCode: 0,
			stdout: outputs.get(argv[0] ?? "") ?? "",
			stderr: "",
		}),
		device: async (path) => (path.endsWith("rootfs_a") ? "45922" : "45923"),
		rootDevice: async () => "45922",
		bootId: async () => bootId,
		healthy: async () => healthy,
	};
	return { deps, read, outputs };
}
const tracked = { processes: new Set<string>(), resources: new Set<string>() };

test("observes the real idle RAUC service, busctl, slot JSON and proc/mount inventory", async () => {
	const { deps } = await captureDeps();
	const snapshot = await observeRaucStage(tracked, deps);
	expect(snapshot).toEqual({
		instance: "656:879",
		active: true,
		operation: "idle",
		processes: ["656:879"],
		resources: [],
		bootId: "11111111-1111-4111-8111-111111111111",
		bootPrimary: "rootfs.0",
		bootedSlot: "rootfs.0",
		bootedDevice: "45922",
		bootedHealthy: true,
		targetSlot: "rootfs.1",
		targetDevice: "45923",
		targetInactive: true,
		activationArmed: false,
	});
});

test("reads the actual process start ticks without mistaking another stat field", async () => {
	const stat = await realDeviceSection("rock", "rauc-stat");
	const identity = processIdentity("656", stat);
	expect(identity).toBe("656:879");
});

test.each(["duplicate", "foreign-group", "missing-pid"] as const)(
	"refuses real RAUC show output with %s tampering",
	async (kind) => {
		const { deps, outputs } = await captureDeps();
		const service = outputs.get("systemctl") ?? "";
		outputs.set(
			"systemctl",
			kind === "duplicate"
				? `${service}MainPID=656\n`
				: kind === "foreign-group"
					? service.replace(
							"/system.slice/rauc.service",
							"/system.slice/foreign.service",
						)
					: service.replace("MainPID=656\n", ""),
		);
		const snapshot = await observeRaucStage(tracked, deps);
		expect(snapshot).toBeNull();
	},
);

test.each(["missing", "unknown", "ambiguous"] as const)(
	"withholds boot_primary when real status is %s",
	async (kind) => {
		const { deps, outputs } = await captureDeps();
		const status = outputs.get("rauc") ?? "";
		outputs.set(
			"rauc",
			kind === "missing"
				? status.replace('"boot_primary":"rootfs.0",', "")
				: kind === "unknown"
					? status.replace(
							'"boot_primary":"rootfs.0"',
							'"boot_primary":"rootfs.99"',
						)
					: status.replaceAll('"rootfs.1":', '"rootfs.0":'),
		);
		const snapshot = await observeRaucStage(tracked, deps);
		expect(snapshot?.bootPrimary).toBeNull();
	},
);

test("refuses malformed busctl operation framing without inventing idle", async () => {
	const { deps, outputs } = await captureDeps();
	outputs.set(
		"busctl",
		(outputs.get("busctl") ?? "").replace('s "idle"', '"idle"'),
	);
	const snapshot = await observeRaucStage(tracked, deps);
	expect(snapshot?.operation).toBeNull();
});

test("retains a tracked mount identity found in real mountinfo", async () => {
	const { deps } = await captureDeps();
	const snapshot = await observeRaucStage(
		{ ...tracked, resources: new Set(["mount:134:0:56:/run/user/1000"]) },
		deps,
	);
	expect(snapshot?.resources).toEqual(["mount:134:0:56:/run/user/1000"]);
});

test("recognises real NUL-separated RAUC service cmdline as not an install client", async () => {
	const raw = Buffer.from(
		(await realDeviceSection("rock", "rauc-cmdline-base64")).trim(),
		"base64",
	).toString();
	const gone = await osInstallClientsGone(undefined, {
		list: async () => ["656"],
		read: async () => raw,
	});
	expect(gone).toBe(true);
});

test.each([false, true])(
	"NBD attribution parses real cgroup bytes with malformed=%s",
	async (malformed) => {
		const { deps, read } = await captureDeps();
		read.set("/sys/block/nbd0/pid", "656\n");
		if (malformed)
			read.set(
				"/proc/656/cgroup",
				(read.get("/proc/656/cgroup") ?? "").replace("0::", "0:cpu:"),
			);
		const snapshot = await observeRaucStage(tracked, {
			...deps,
			list: async () => ["nbd0"],
		});
		if (malformed) expect(snapshot).toBeNull();
		else expect(snapshot?.resources).toEqual(["nbd:nbd0:656:879"]);
	},
);

test("cmdline parsing refuses a tampered captured service changed to an install client", async () => {
	const service = Buffer.from(
		(await realDeviceSection("rock", "rauc-cmdline-base64")).trim(),
		"base64",
	).toString();
	const raw = service.replace(
		"--mount=/run/rauc/mnt\0service",
		"install\0https://images.ceralive.tv/fixture.raucb",
	);
	const gone = await osInstallClientsGone(undefined, {
		list: async () => ["656"],
		read: async () => raw,
	});
	expect(gone).toBe(false);
});
