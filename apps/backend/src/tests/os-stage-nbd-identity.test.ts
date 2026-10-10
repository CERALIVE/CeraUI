import { expect, test } from "bun:test";
import {
	observeRaucStage,
	type RaucObservationDeps,
} from "../modules/system/update-orchestrator/os-stage-observation.ts";
import { raucQuiescenceRefusal } from "../modules/system/update-orchestrator/os-stage-recovery.ts";
import { record } from "./helpers/os-stage-orphan-record.ts";

const ownedResource = "nbd:nbd43:358962:23";
const ownership = {
	baseline: record.baseline,
	processes: new Set(["659:10", "358962:23"]),
	resources: new Set([ownedResource]),
};

async function fixture(nbdPid: string | null) {
	const status = await Bun.file(
		new URL(
			"./fixtures/rauc/status-detailed-rock-5b-plus-rauc-1.15.txt",
			import.meta.url,
		),
	).text();
	const proc = (pid: string, ticks: string) =>
		`${pid} (process) ${["S", ...Array(18).fill("0"), ticks].join(" ")}`;
	const reads = new Map([
		["/sys/fs/cgroup/system.slice/rauc.service/cgroup.procs", "371279\n"],
		["/proc/371279/stat", proc("371279", "99")],
		["/proc/358962/stat", proc("358962", "500")],
		["/proc/358962/cgroup", "0::/system.slice/unrelated.service\n"],
		["/proc/888/stat", proc("888", "600")],
		["/proc/888/cgroup", "0::/system.slice/unrelated.service\n"],
		["/proc/self/mountinfo", ""],
	]);
	if (nbdPid !== null) reads.set("/sys/block/nbd43/pid", `${nbdPid}\n`);
	const deps: RaucObservationDeps = {
		read: async (path) => {
			const value = reads.get(path);
			if (value !== undefined) return value;
			throw Object.assign(new Error("absent"), { code: "ENOENT" });
		},
		list: async () => ["nbd43"],
		run: async (argv) => ({
			exitCode: 0,
			stderr: "",
			stdout:
				argv[0] === "systemctl"
					? "ActiveState=active\nMainPID=371279\nControlGroup=/system.slice/rauc.service\n"
					: argv[0] === "busctl"
						? 's "idle"\n'
						: status,
		}),
		device: async (path) => (path.endsWith("rootfs_b") ? "179:5" : "179:4"),
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
	return deps;
}

test.each(["358962", "888"])(
	"previously owned NBD cannot retire when its configured PID is now unrelated (%s)",
	async (pid) => {
		// Given tracked nbd43's creator 358962:23 is gone, with new idle RAUC 371279:99.
		const deps = await fixture(pid);
		// When sysfs still reports a configured device but proc identifies an unrelated process.
		const current = await observeRaucStage(ownership, deps);
		const refusal = raucQuiescenceRefusal({
			ownership,
			current,
			cliSettled: true,
			lockHeld: true,
			requireNewInstance: true,
		});
		// Then process retirement cannot stand in for device retirement at the retry boundary.
		expect(refusal).toBe("owned-resource-survives");
		expect(current?.resources).toContain(ownedResource);
		expect(current?.processes).toEqual(["371279:99"]);
	},
);

test("a never-owned unrelated configured NBD is excluded from RAUC resources", async () => {
	// Given the same unrelated connection without prior device ownership.
	const deps = await fixture("358962");
	// When the observer has no tracked resource for this device.
	const current = await observeRaucStage(
		{ processes: ownership.processes, resources: new Set() },
		deps,
	);
	// Then unrelated NBD usage does not block an otherwise proven recovery.
	expect(current?.resources).toEqual([]);
	expect(
		raucQuiescenceRefusal({
			ownership,
			current,
			cliSettled: true,
			lockHeld: true,
			requireNewInstance: true,
		}),
	).toBeNull();
});

test("a previously owned NBD can retire when its sysfs connection PID is absent", async () => {
	// Given the device remains enumerated but its connection attribute is gone.
	const deps = await fixture(null);
	// When independent kernel connection absence is observed.
	const current = await observeRaucStage(ownership, deps);
	// Then the old process identity alone does not invent a surviving connection.
	expect(
		raucQuiescenceRefusal({
			ownership,
			current,
			cliSettled: true,
			lockHeld: true,
			requireNewInstance: true,
		}),
	).toBeNull();
});
