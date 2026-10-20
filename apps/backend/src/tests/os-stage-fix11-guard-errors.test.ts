import { expect, test } from "bun:test";
import { SOFTWARE_UPDATE_LOCK } from "../modules/system/update-orchestrator/lock.ts";
import {
	type OsGuardKernelDeps,
	proveOsGuardKernelOwnership,
} from "../modules/system/update-orchestrator/os-stage-guard-lock.ts";
import {
	GuardTreeChanged,
	guardianMembers,
	readGuardProc,
} from "../modules/system/update-orchestrator/os-stage-guard-tree.ts";

const errnos = ["ENOENT", "ESRCH", "EACCES", "EPERM", "EIO", "ENOMEM"];
const vanished = (code: string) => code === "ENOENT" || code === "ESRCH";
const input = { pid: null, attemptId: "33333333-3333-4333-8333-333333333333" };
function guardDeps(fault: string, code: string): OsGuardKernelDeps {
	const error = Object.assign(new Error("x"), { code });
	const lock = { dev: 1, ino: 2 };
	return {
		lock: SOFTWARE_UPDATE_LOCK,
		device: async () => "00:01",
		read: async (path) => {
			if (path === fault) throw error;
			if (path === "/proc/locks") return "";
			if (path.endsWith("cgroup.procs"))
				throw Object.assign(new Error("absent guardian"), { code: "ENOENT" });
			if (path.endsWith("/stat"))
				return `444 (bash) S 333 ${"0 ".repeat(18)}10`;
			return "";
		},
		list: async (path) => {
			if (path === fault) throw error;
			return path === "/proc" ? ["444"] : ["3"];
		},
		identity: async (path) => {
			if (path === fault) throw error;
			return lock;
		},
	};
}

for (const file of ["stat", "cgroup", "cmdline"] as const) {
	test.each(errnos)(
		`guardian ${file} %s requires a fresh tree, never a cached member`,
		async (code) => {
			// Given an already-listed member whose next process read fails.
			const deps = guardDeps(`/proc/444/${file}`, code);
			// When reading the production guardian tree.
			const result = readGuardProc(deps, "444", file);
			// Then disappearance triggers bounded re-observation; other errors propagate.
			if (vanished(code))
				await expect(result).rejects.toBeInstanceOf(GuardTreeChanged);
			else await expect(result).rejects.toHaveProperty("code", code);
		},
	);
}

for (const path of [
	"/proc/444/fd",
	"/proc/444/fd/3",
	"/proc/444/fdinfo/3",
	"/proc/444/stat",
	"/proc/444/cmdline",
]) {
	test.each(errnos)(
		`kernel ownership at ${path} %s grants no vanished holder`,
		async (code) => {
			// Given no lock rows, a listed PID and a failed fd or temporary-holder read.
			const deps = guardDeps(path, code);
			const temporaryPid = path.includes("fdinfo") ? "444" : "333";
			// When correlating actual production holder evidence.
			const result = proveOsGuardKernelOwnership(
				{ ...input, temporaryPid },
				deps,
			);
			// Then absent holders cannot grant ownership and non-gone errnos propagate.
			if (vanished(code)) expect(await result).toBe(false);
			else await expect(result).rejects.toHaveProperty("code", code);
		},
	);
}

test("guardian cgroup ESRCH is not process absence", async () => {
	// Given an unreadable cgroup.procs path, not a vanished PID.
	const deps = guardDeps(
		"/sys/fs/cgroup/system.slice/ceralive-os-stage-guard.service/cgroup.procs",
		"ESRCH",
	);
	// When obtaining the guard roster.
	const result = guardianMembers(input, deps);
	// Then only the existing ENOENT cgroup rule can certify absent guardian state.
	await expect(result).rejects.toHaveProperty("code", "ESRCH");
});
