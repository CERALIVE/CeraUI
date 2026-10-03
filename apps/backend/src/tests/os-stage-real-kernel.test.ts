import { expect, test } from "bun:test";
import { SOFTWARE_UPDATE_LOCK } from "../modules/system/update-orchestrator/lock.ts";
import {
	type OsGuardKernelDeps,
	proveOsGuardKernelOwnership,
} from "../modules/system/update-orchestrator/os-stage-guard-lock.ts";
import { OS_STAGE_GUARD_HELPER } from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import { realDeviceSection } from "./helpers/real-device-fixture.ts";

const killedToken = "33333333-3333-4333-8333-333333333333";

test("the real Rock lock, fdinfo, cgroup and process rows prove the guardian holds the lock", async () => {
	// fds/cmdline of the two descendants and /proc/<pid>/cgroup were not captured
	// on the Rock: they are hermetic below, everything else is the real capture.
	const [ino, dev] = (await realDeviceSection("rock-guardian", "lock-stat"))
		.trim()
		.split(" ")
		.map(Number);
	const lock = { ino: ino ?? 0, dev: dev ?? 0 };
	const group = (await realDeviceSection("opi", "guardian-cgroup")).trim();
	const fdinfo = await realDeviceSection("rock-guardian", "fdinfo-3");
	const argv: Record<string, string[]> = {
		"1168323": [
			"/usr/bin/flock",
			"-n",
			"-E",
			"75",
			"-x",
			SOFTWARE_UPDATE_LOCK,
			OS_STAGE_GUARD_HELPER,
			killedToken,
		],
		"1168324": ["/bin/bash", OS_STAGE_GUARD_HELPER, killedToken],
		"1168328": ["sleep", "1"],
	};
	const fds = (await realDeviceSection("rock-guardian", "fds"))
		.split("\n")
		.map((line) => line.match(/ (\d+) -> /)?.[1])
		.filter((fd): fd is string => fd !== undefined);
	const deps: OsGuardKernelDeps = {
		lock: SOFTWARE_UPDATE_LOCK,
		device: async () => "00:1d",
		read: async (path) => {
			if (path === "/proc/locks")
				return realDeviceSection("rock-guardian", "locks");
			if (path.endsWith("cgroup.procs"))
				return realDeviceSection("rock-guardian", "cgroup-procs");
			const [, , pid, file] = path.split("/");
			if (file === "stat")
				return realDeviceSection("rock-guardian", `proc-stat-${pid}`);
			if (file === "cgroup") return `${group}\n`;
			if (file === "cmdline") return `${(argv[pid ?? ""] ?? []).join("\0")}\0`;
			if (file === "fdinfo") return fdinfo;
			throw Object.assign(new Error(path), { code: "ENOENT" });
		},
		list: async (path) => {
			if (path === "/proc") return Object.keys(argv);
			if (path === "/proc/1168323/fd") return fds;
			return ["3"];
		},
		identity: async (path) =>
			path === SOFTWARE_UPDATE_LOCK || path.endsWith("/fd/3")
				? lock
				: { ino: 1, dev: 5 },
	};
	expect(fds).toEqual(["0", "1", "2", "3"]);
	expect(
		await proveOsGuardKernelOwnership(
			{ pid: "1168323", attemptId: killedToken },
			deps,
		),
	).toBe(true);
});
