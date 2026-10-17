import { expect, test } from "bun:test";
import { SOFTWARE_UPDATE_LOCK } from "../modules/system/update-orchestrator/lock.ts";
import {
	type OsGuardKernelDeps,
	proveOsGuardKernelOwnership,
} from "../modules/system/update-orchestrator/os-stage-guard-lock.ts";
import { OS_STAGE_GUARD_HELPER } from "../modules/system/update-orchestrator/os-stage-job-files.ts";

const attemptId = "33333333-3333-4333-8333-333333333333";
const group = "/system.slice/ceralive-os-stage-guard.service";
const row = "2: FLOCK ADVISORY WRITE 100 00:1d:8215 0 EOF\n";
const procStat = (pid: string, parent: string) =>
	`${pid} (x) S ${parent} 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1234 0 0`;

function tree(child: readonly string[], persistent: boolean) {
	let scans = 0;
	let present = true;
	const deps: OsGuardKernelDeps = {
		lock: SOFTWARE_UPDATE_LOCK,
		device: async () => "00:1d",
		identity: async () => ({ dev: 29, ino: 8215 }),
		list: async (path) => (path === "/proc" ? ["100", "101"] : ["3"]),
		read: async (path) => {
			if (path === "/proc/locks") return row;
			if (path.endsWith("cgroup.procs")) {
				scans++;
				return present ? "100\n101\n102\n" : "100\n101\n";
			}
			const pid = path.split("/")[2] ?? "";
			if (path.endsWith("/stat"))
				return procStat(
					pid,
					pid === "100" ? "1" : pid === "101" ? "100" : "101",
				);
			if (path.endsWith("/cgroup")) return `0::${group}\n`;
			if (path.includes("/fdinfo/")) return `lock:\t${row}`;
			if (path.endsWith("/cmdline")) {
				if (pid === "100")
					return [
						"/usr/bin/flock",
						"-n",
						"-E",
						"75",
						"-x",
						SOFTWARE_UPDATE_LOCK,
						OS_STAGE_GUARD_HELPER,
						attemptId,
						"",
					].join("\0");
				if (pid === "101")
					return `/bin/bash\0${OS_STAGE_GUARD_HELPER}\0${attemptId}\0`;
				if (!persistent) present = false;
				return [...child, ""].join("\0");
			}
			throw new Error(`unexpected tree read ${path}`);
		},
	};
	return { deps, scans: () => scans };
}

test.each(["token", "release"] as const)(
	"a short-lived stat checking %s triggers rescan without widening membership",
	async (file) => {
		const h = tree(
			["stat", "-c", "%u:%a:%h", `/run/ceralive/os-stage/${file}`],
			false,
		);
		expect(
			await proveOsGuardKernelOwnership({ pid: "100", attemptId }, h.deps),
		).toBe(true);
		expect(h.scans()).toBe(2);
	},
);

test("persistent unexpected RAUC membership is refused after bounded observation", async () => {
	const h = tree(
		["rauc", "--debug", "install", "https://images.ceralive.tv/bundle.raucb"],
		true,
	);
	expect(
		await proveOsGuardKernelOwnership({ pid: "100", attemptId }, h.deps),
	).toBe(false);
	expect(h.scans()).toBe(3);
});

test("even an allowlisted stat child cannot be accepted as steady guardian membership", async () => {
	const h = tree(
		["stat", "-c", "%u:%a:%h", "/run/ceralive/os-stage/release"],
		true,
	);
	expect(
		await proveOsGuardKernelOwnership({ pid: "100", attemptId }, h.deps),
	).toBe(false);
	expect(h.scans()).toBe(3);
});
