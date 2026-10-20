import { expect, test } from "bun:test";
import { SOFTWARE_UPDATE_LOCK } from "../modules/system/update-orchestrator/lock.ts";
import {
	type OsGuardKernelDeps,
	proveOsGuardKernelOwnership,
} from "../modules/system/update-orchestrator/os-stage-guard-lock.ts";
import { OS_STAGE_GUARD_HELPER } from "../modules/system/update-orchestrator/os-stage-job-files.ts";

const attemptId = "33333333-3333-4333-8333-333333333333";
const GROUP = "/system.slice/ceralive-os-stage-guard.service";
const enoent = () => Object.assign(new Error("gone"), { code: "ENOENT" });
const stat = (pid: string, comm: string, parent: string, ticks: string) =>
	`${pid} (${comm}) S ${parent} 1 1 0 -1 4194560 556 0 0 0 1 0 0 0 20 0 1 0 ${ticks} 2809856 388 0\n`;

type Tree = {
	files: Map<string, string | (() => string)>;
	dirs: Map<string, string[]>;
	ids: Map<string, { dev: number; ino: number }>;
};

/** Healthy guardian tree: flock main, helper child and its `sleep 1` child share fd 3. */
function tree(): Tree {
	const files = new Map<string, string | (() => string)>([
		["/proc/locks", "2: FLOCK  ADVISORY  WRITE 100 00:1d:8215 0 EOF\n"],
		[`/sys/fs/cgroup${GROUP}/cgroup.procs`, "100\n101\n102\n"],
	]);
	const argv = {
		"100": [
			"/usr/bin/flock",
			"-n",
			"-E",
			"75",
			"-x",
			SOFTWARE_UPDATE_LOCK,
			OS_STAGE_GUARD_HELPER,
			attemptId,
		],
		"101": ["/bin/bash", OS_STAGE_GUARD_HELPER, attemptId],
		"102": ["sleep", "1"],
	};
	const parents = { "100": "1", "101": "100", "102": "101" };
	const dirs = new Map<string, string[]>([
		["/proc", ["1", "100", "101", "102"]],
	]);
	const ids = new Map([[SOFTWARE_UPDATE_LOCK, { dev: 29, ino: 8215 }]]);
	for (const pid of ["100", "101", "102"] as const) {
		files.set(`/proc/${pid}/stat`, stat(pid, "x", parents[pid], "3844223"));
		files.set(`/proc/${pid}/cgroup`, `0::${GROUP}\n`);
		files.set(`/proc/${pid}/cmdline`, `${argv[pid].join("\0")}\0`);
		files.set(
			`/proc/${pid}/fdinfo/3`,
			"pos:\t0\nflags:\t0400000\nlock:\t1: FLOCK  ADVISORY  WRITE 100 00:1d:8215 0 EOF\n",
		);
		dirs.set(`/proc/${pid}/fd`, ["0", "3"]);
		ids.set(`/proc/${pid}/fd/3`, { dev: 29, ino: 8215 });
		ids.set(`/proc/${pid}/fd/0`, { dev: 5, ino: 1 });
	}
	dirs.set("/proc/1/fd", ["0"]);
	ids.set("/proc/1/fd/0", { dev: 5, ino: 1 });
	return { files, dirs, ids };
}

function deps(t: Tree): OsGuardKernelDeps {
	return {
		lock: SOFTWARE_UPDATE_LOCK,
		device: async () => "00:1d",
		read: async (path) => {
			const value = t.files.get(path);
			if (value === undefined) throw enoent();
			return typeof value === "function" ? value() : value;
		},
		list: async (path) => {
			const value = t.dirs.get(path);
			if (!value) throw enoent();
			return value;
		},
		identity: async (path) => {
			const value = t.ids.get(path);
			if (!value) throw enoent();
			return value;
		},
	};
}

test("a healthy guardian tree proves ownership although fdinfo and /proc/locks number rows differently", async () => {
	expect(
		await proveOsGuardKernelOwnership({ pid: "100", attemptId }, deps(tree())),
	).toBe(true);
});

test("a sleep child exiting mid-scan is rescanned, not reported as a fault", async () => {
	const t = tree();
	let first = true;
	t.files.set("/proc/102/stat", () => {
		if (!first) throw enoent();
		first = false;
		t.files.set(`/sys/fs/cgroup${GROUP}/cgroup.procs`, "100\n101\n");
		t.dirs.set("/proc", ["1", "100", "101"]);
		throw enoent();
	});
	expect(
		await proveOsGuardKernelOwnership({ pid: "100", attemptId }, deps(t)),
	).toBe(true);
});

test("guardian PID reuse between the identity reads refuses", async () => {
	const t = tree();
	let reads = 0;
	t.files.set("/proc/100/stat", () =>
		stat("100", "x", "1", reads++ === 0 ? "3844223" : "9999999"),
	);
	expect(
		await proveOsGuardKernelOwnership({ pid: "100", attemptId }, deps(t)),
	).toBe(false);
});

test("a replaced lock inode refuses", async () => {
	const t = tree();
	let reads = 0;
	const original = deps(t);
	const replaced: OsGuardKernelDeps = {
		...original,
		identity: async (path) =>
			path === SOFTWARE_UPDATE_LOCK && reads++ > 0
				? { dev: 29, ino: 9000 }
				: original.identity(path),
	};
	expect(
		await proveOsGuardKernelOwnership({ pid: "100", attemptId }, replaced),
	).toBe(false);
});

test("a foreign process retaining the lock's open file description refuses", async () => {
	const t = tree();
	t.dirs.set("/proc", ["1", "100", "101", "102", "500"]);
	t.dirs.set("/proc/500/fd", ["7"]);
	t.ids.set("/proc/500/fd/7", { dev: 29, ino: 8215 });
	t.files.set("/proc/500/stat", stat("500", "foreign", "1", "1"));
	t.files.set("/proc/500/cmdline", "foreign\0");
	expect(
		await proveOsGuardKernelOwnership({ pid: "100", attemptId }, deps(t)),
	).toBe(false);
});

test("a second lock row on the inode refuses", async () => {
	const t = tree();
	t.files.set(
		"/proc/locks",
		"1: POSIX  ADVISORY  WRITE 900 00:1d:8215 0 EOF\n2: FLOCK  ADVISORY  WRITE 100 00:1d:8215 0 EOF\n",
	);
	expect(
		await proveOsGuardKernelOwnership({ pid: "100", attemptId }, deps(t)),
	).toBe(false);
});

test("an unrelated lock appearing elsewhere does not disturb the proof", async () => {
	const t = tree();
	let reads = 0;
	t.files.set("/proc/locks", () =>
		reads++ === 0
			? "2: FLOCK  ADVISORY  WRITE 100 00:1d:8215 0 EOF\n"
			: "1: POSIX  ADVISORY  WRITE 77 08:02:1234 0 EOF\n2: FLOCK  ADVISORY  WRITE 100 00:1d:8215 0 EOF\n",
	);
	expect(
		await proveOsGuardKernelOwnership({ pid: "100", attemptId }, deps(t)),
	).toBe(true);
});

test("an exited guardian proves absence only with an empty cgroup and no holder", async () => {
	const t = tree();
	t.files.delete(`/sys/fs/cgroup${GROUP}/cgroup.procs`);
	t.files.set("/proc/locks", "");
	t.dirs.set("/proc", ["1"]);
	expect(
		await proveOsGuardKernelOwnership({ pid: null, attemptId }, deps(t)),
	).toBe(true);
	t.files.set(
		"/proc/locks",
		"2: FLOCK  ADVISORY  WRITE 100 00:1d:8215 0 EOF\n",
	);
	t.dirs.set("/proc", ["1", "100"]);
	expect(
		await proveOsGuardKernelOwnership({ pid: null, attemptId }, deps(t)),
	).toBe(false);
});

test("the reconciler's own temporary flock and helper are the only accepted holders", async () => {
	const t = tree();
	t.files.delete(`/sys/fs/cgroup${GROUP}/cgroup.procs`);
	t.files.set(
		"/proc/locks",
		"2: FLOCK  ADVISORY  WRITE 700 00:1d:8215 0 EOF\n",
	);
	t.dirs.set("/proc", ["1", "700", "701"]);
	for (const pid of ["700", "701"]) {
		t.dirs.set(`/proc/${pid}/fd`, ["4"]);
		t.ids.set(`/proc/${pid}/fd/4`, { dev: 29, ino: 8215 });
		t.files.set(
			`/proc/${pid}/fdinfo/4`,
			"lock:\t1: FLOCK  ADVISORY  WRITE 700 00:1d:8215 0 EOF\n",
		);
	}
	t.files.set("/proc/701/stat", stat("701", "bash", "700", "1"));
	t.files.set(
		"/proc/701/cmdline",
		`/bin/bash\0${OS_STAGE_GUARD_HELPER}\0--orphan-lock\0`,
	);
	expect(
		await proveOsGuardKernelOwnership(
			{ pid: null, attemptId, temporaryPid: "700" },
			deps(t),
		),
	).toBe(true);
	t.files.set("/proc/701/cmdline", "/bin/bash\0/tmp/other\0");
	expect(
		await proveOsGuardKernelOwnership(
			{ pid: null, attemptId, temporaryPid: "700" },
			deps(t),
		),
	).toBe(false);
});

test("an unexpected argv in the guardian cgroup refuses", async () => {
	const t = tree();
	t.files.set("/proc/102/cmdline", "rauc\0install\0");
	expect(
		await proveOsGuardKernelOwnership({ pid: "100", attemptId }, deps(t)),
	).toBe(false);
});
