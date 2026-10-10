import { expect, test } from "bun:test";
import {
	observeRaucStage,
	type RaucObservationDeps,
} from "../modules/system/update-orchestrator/os-stage-observation.ts";

function observationFixture() {
	const proc = (pid: string) =>
		`${pid} (installer with spaces) ${["S", ...Array(18).fill("0"), "123"].join(" ")}`;
	const reads = new Map([
		["/sys/fs/cgroup/system.slice/rauc.service/cgroup.procs", "659\n358961\n"],
		["/proc/659/stat", proc("659")],
		["/proc/358961/stat", proc("358961")],
		["/proc/358961/cgroup", "0::/system.slice/rauc.service\n"],
		["/sys/block/nbd43/pid", "358961\n"],
		["/sys/block/dm-7/dev", "253:7\n"],
		["/sys/block/dm-7/dm/uuid", "rauc-unique\n"],
		["/sys/block/dm-12/dev", "253:12\n"],
		["/sys/block/dm-12/dm/uuid", "foreign-volume\n"],
		[
			"/proc/self/mountinfo",
			"51 1 253:7 / /run/rauc/mnt/bundle ro - squashfs /dev/dm-7 ro\n",
		],
	]);
	const commands: string[][] = [];
	const deps: RaucObservationDeps = {
		read: async (path) => {
			const value = reads.get(path);
			if (value !== undefined) return value;
			throw Object.assign(new Error("absent"), { code: "ENOENT" });
		},
		list: async (path) =>
			path === "/sys/block"
				? ["nbd43", "dm-7", "dm-12"]
				: path.includes("dm-7")
					? ["nbd43"]
					: ["sda"],
		run: async (argv) => {
			commands.push(argv);
			return {
				exitCode: 0,
				stderr: "",
				stdout:
					argv[0] === "systemctl"
						? "ActiveState=active\nMainPID=659\nControlGroup=/system.slice/rauc.service\n"
						: argv[0] === "busctl"
							? 's "installing"\n'
							: JSON.stringify({
									boot_primary: "rootfs.1",
									slots: [
										{
											"rootfs.1": {
												class: "rootfs",
												state: "booted",
												device: "/dev/b",
												boot_status: "good",
												bootname: "B",
											},
										},
										{
											"rootfs.0": {
												class: "rootfs",
												state: "inactive",
												device: "/dev/a",
												boot_status: "bad",
												bootname: "A",
											},
										},
									],
								}),
			};
		},
		device: async (path) => (path === "/dev/b" ? "179:5" : "179:4"),
		rootDevice: async () => "179:5",
		bootId: async () => "boot-B",
		healthy: async () => ({
			boot_id: "boot-B",
			slot: "B",
			build_id: "build",
			dpkg_status_sha256: "a".repeat(64),
			recorded_at: "now",
		}),
	};
	return { deps, reads, commands, proc };
}

test("captures arbitrary RAUC resource identities while leaving foreign block devices alone", async () => {
	const { deps, reads, commands } = observationFixture();
	const result = await observeRaucStage(
		{ processes: new Set(), resources: new Set() },
		deps,
	);
	// Then ownership is identity-specific and every command is read-only.
	expect(result?.resources).toEqual([
		"nbd:nbd43:358961:123",
		"dm:253:7:rauc-unique",
		"mount:51:253:7:/run/rauc/mnt/bundle",
	]);
	expect(result?.bootedHealthy).toBe(true);
	expect(commands.map((argv) => argv.slice(0, 2))).toEqual([
		["systemctl", "show"],
		["busctl", "get-property"],
		["rauc", "status"],
		["systemctl", "show"],
	]);
	reads.delete("/proc/659/stat");
	expect(
		await observeRaucStage(
			{ processes: new Set(), resources: new Set() },
			deps,
		),
	).toBeNull();
});

test("a recycled old PID is not a surviving attempt process", async () => {
	const { deps, reads, proc } = observationFixture();
	reads.set("/proc/123/stat", proc("123"));
	const snapshot = await observeRaucStage(
		{ processes: new Set(["123:999"]), resources: new Set() },
		deps,
	);
	expect(snapshot?.processes).toEqual(["659:123", "358961:123"]);
});

test("an NBD helper in the RAUC cgroup is owned even before the process scan sees it", async () => {
	const { deps, reads } = observationFixture();
	reads.set("/sys/fs/cgroup/system.slice/rauc.service/cgroup.procs", "659\n");
	const snapshot = await observeRaucStage(
		{ processes: new Set(), resources: new Set() },
		deps,
	);
	expect(snapshot?.resources).toContain("nbd:nbd43:358961:123");
});

test("a disconnected NBD slave with an untracked mapping cannot prove cleanup", async () => {
	const { deps, reads } = observationFixture();
	reads.delete("/sys/block/nbd43/pid");
	const snapshot = await observeRaucStage(
		{ processes: new Set(), resources: new Set() },
		deps,
	);
	expect(snapshot?.resources).toContain("unowned-dm:253:7:rauc-unique");
});
