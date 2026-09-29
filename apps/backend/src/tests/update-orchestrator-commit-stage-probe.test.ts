/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * The wire-independent "is the commit stage running" probe D8 consults before
 * it may stop the package-install unit for a stream start. Driven against a
 * REAL fake cgroup/proc tree on disk (the default file readers, not a mock),
 * with only the `systemctl show` answer injected.
 *
 * Measured motivation (Rock 5B+, 2026-09-29): a stream start sent 1 ms after
 * dpkg appeared was admitted because the wire still read `downloading`, and
 * dpkg was killed 84 ms later. The probe must say "commit stage" for the
 * second-stage `apt-get --no-download install` and for any `dpkg`, and must
 * NOT say so for the first (download) stage, which stays abortable.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnWithTimeoutResult } from "../helpers/spawn-policy.ts";
import {
	type CommitStageProbeDeps,
	isCommitStageProcess,
	isCommitStageRunning,
} from "../modules/system/update-orchestrator/commit-stage-probe.ts";

const UNIT_CGROUP = "/system.slice/ceralive-software-update.service";
const SCRIPT =
	"/usr/bin/apt-get -d -y upgrade --with-new-pkgs && /usr/bin/apt-get -y --no-download --no-remove -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold install a=1 b=2";

const STAGE_ONE = [
	"/usr/bin/apt-get",
	"-d",
	"-y",
	"upgrade",
	"--with-new-pkgs",
];
const STAGE_TWO = [
	"/usr/bin/apt-get",
	"-y",
	"--no-download",
	"--no-remove",
	"-o",
	"Dpkg::Options::=--force-confdef",
	"-o",
	"Dpkg::Options::=--force-confold",
	"install",
	"a=1",
	"b=2",
];
const FLOCK = [
	"flock",
	"-x",
	"/run/lock/ceralive-update.lock",
	"/bin/sh",
	"-ec",
	SCRIPT,
];
const SHELL = ["/bin/sh", "-ec", SCRIPT];

type Proc = { readonly pid: number; readonly comm: string; argv: string[] };

const roots: string[] = [];

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true });
});

function activeShow(controlGroup = UNIT_CGROUP): SpawnWithTimeoutResult {
	return {
		exitCode: 0,
		stdout: `LoadState=loaded\nActiveState=active\nSubState=running\nControlGroup=${controlGroup}\n`,
		stderr: "",
	};
}

function tree(opts: {
	readonly procsFile?: string | null;
	readonly processes?: readonly Proc[];
	readonly childCgroup?: { readonly name: string; readonly procs: string };
	readonly show?: SpawnWithTimeoutResult;
}): CommitStageProbeDeps {
	const root = mkdtempSync(join(tmpdir(), "ceraui-commit-probe-"));
	roots.push(root);
	const cgroupRoot = join(root, "cgroup");
	const procRoot = join(root, "proc");
	const unitDir = join(cgroupRoot, UNIT_CGROUP);
	mkdirSync(unitDir, { recursive: true });
	mkdirSync(procRoot, { recursive: true });
	const processes = opts.processes ?? [];
	if (opts.procsFile !== null) {
		writeFileSync(
			join(unitDir, "cgroup.procs"),
			opts.procsFile ?? processes.map((p) => `${p.pid}\n`).join(""),
		);
	}
	if (opts.childCgroup) {
		const child = join(unitDir, opts.childCgroup.name);
		mkdirSync(child);
		writeFileSync(join(child, "cgroup.procs"), opts.childCgroup.procs);
	}
	for (const proc of processes) {
		const dir = join(procRoot, String(proc.pid));
		mkdirSync(dir);
		writeFileSync(join(dir, "comm"), `${proc.comm}\n`);
		writeFileSync(join(dir, "cmdline"), `${proc.argv.join("\0")}\0`);
	}
	const show = opts.show ?? activeShow();
	return { showUnit: async () => show, cgroupRoot, procRoot };
}

describe("isCommitStageProcess — the classification rule", () => {
	test("dpkg and any dpkg-* helper are the commit stage", () => {
		expect(isCommitStageProcess("dpkg", ["/usr/bin/dpkg"])).toBe(true);
		expect(isCommitStageProcess("dpkg-deb", ["dpkg-deb", "--fsys"])).toBe(true);
	});

	test("the second-stage apt-get (--no-download) is the commit stage", () => {
		expect(isCommitStageProcess("apt-get", STAGE_TWO)).toBe(true);
	});

	test("the first (download) stage apt-get is NOT the commit stage", () => {
		expect(isCommitStageProcess("apt-get", STAGE_ONE)).toBe(false);
	});

	test("a wrapper whose argv merely CONTAINS the script text is not the commit stage", () => {
		// flock and sh carry the whole script (with `--no-download` as a
		// substring of one element) for the unit's entire life; only an exact
		// argv element on an `apt-get` process counts.
		expect(isCommitStageProcess("flock", FLOCK)).toBe(false);
		expect(isCommitStageProcess("sh", SHELL)).toBe(false);
		expect(isCommitStageProcess("http", ["/usr/lib/apt/methods/http"])).toBe(
			false,
		);
	});
});

describe("isCommitStageRunning — default readers over a fake cgroup/proc tree", () => {
	test("a dpkg process in the unit's cgroup -> commit stage running", async () => {
		const deps = tree({
			processes: [
				{ pid: 100, comm: "flock", argv: FLOCK },
				{ pid: 101, comm: "sh", argv: SHELL },
				{ pid: 102, comm: "apt-get", argv: STAGE_TWO },
				{ pid: 103, comm: "dpkg", argv: ["/usr/bin/dpkg", "--unpack"] },
			],
		});
		expect(await isCommitStageRunning(deps)).toBe(true);
	});

	test("the second-stage apt-get alone (before dpkg exists) -> commit stage running", async () => {
		const deps = tree({
			processes: [
				{ pid: 100, comm: "flock", argv: FLOCK },
				{ pid: 101, comm: "sh", argv: SHELL },
				{ pid: 102, comm: "apt-get", argv: STAGE_TWO },
			],
		});
		expect(await isCommitStageRunning(deps)).toBe(true);
	});

	test("the first (download) stage -> NOT the commit stage, stays abortable", async () => {
		const deps = tree({
			processes: [
				{ pid: 100, comm: "flock", argv: FLOCK },
				{ pid: 101, comm: "sh", argv: SHELL },
				{ pid: 102, comm: "apt-get", argv: STAGE_ONE },
				{ pid: 103, comm: "http", argv: ["/usr/lib/apt/methods/http"] },
			],
		});
		expect(await isCommitStageRunning(deps)).toBe(false);
	});

	test("an empty cgroup -> false", async () => {
		expect(await isCommitStageRunning(tree({ procsFile: "" }))).toBe(false);
	});

	test("non-numeric cgroup.procs entries are ignored, not treated as unreadable", async () => {
		const deps = tree({
			procsFile: "abc\n\n 102\n-1\n",
			processes: [{ pid: 102, comm: "apt-get", argv: STAGE_ONE }],
		});
		expect(await isCommitStageRunning(deps)).toBe(false);
	});

	test("a listed pid that has already exited is skipped", async () => {
		const deps = tree({
			procsFile: "555\n102\n",
			processes: [{ pid: 102, comm: "apt-get", argv: STAGE_ONE }],
		});
		expect(await isCommitStageRunning(deps)).toBe(false);
	});

	test("dpkg in a child cgroup of the unit still counts", async () => {
		const deps = tree({
			procsFile: "",
			processes: [{ pid: 103, comm: "dpkg", argv: ["/usr/bin/dpkg"] }],
			childCgroup: { name: "sub", procs: "103\n" },
		});
		expect(await isCommitStageRunning(deps)).toBe(true);
	});

	test("FAIL CLOSED: unit active but its process list is unreadable -> true", async () => {
		expect(await isCommitStageRunning(tree({ procsFile: null }))).toBe(true);
	});

	test("FAIL CLOSED: unit active with no ControlGroup -> true", async () => {
		expect(await isCommitStageRunning(tree({ show: activeShow("") }))).toBe(
			true,
		);
	});

	test("FAIL CLOSED: a ControlGroup that escapes the cgroup root -> true", async () => {
		expect(
			await isCommitStageRunning(
				tree({ show: activeShow("/system.slice/../../etc") }),
			),
		).toBe(true);
	});

	test("FAIL CLOSED: systemctl show fails without saying not-found -> true", async () => {
		const deps = tree({
			show: { exitCode: 1, stdout: "", stderr: "Failed to connect to bus" },
		});
		expect(await isCommitStageRunning(deps)).toBe(true);
	});

	test("FAIL CLOSED: the systemctl spawn itself throws -> true", async () => {
		const deps: CommitStageProbeDeps = {
			...tree({}),
			showUnit: async () => {
				throw new Error("spawn failed");
			},
		};
		expect(await isCommitStageRunning(deps)).toBe(true);
	});

	test("unit not found -> false, without reading any process list", async () => {
		const deps: CommitStageProbeDeps = {
			showUnit: async () => ({
				exitCode: 0,
				stdout:
					"LoadState=not-found\nActiveState=inactive\nSubState=dead\nControlGroup=\n",
				stderr: "",
			}),
			cgroupRoot: "/nonexistent-cgroup-root",
			procRoot: "/nonexistent-proc-root",
		};
		expect(await isCommitStageRunning(deps)).toBe(false);
	});

	test("unit loaded but inactive/dead -> false", async () => {
		const deps: CommitStageProbeDeps = {
			showUnit: async () => ({
				exitCode: 0,
				stdout:
					"LoadState=loaded\nActiveState=inactive\nSubState=dead\nControlGroup=\n",
				stderr: "",
			}),
			cgroupRoot: "/nonexistent-cgroup-root",
			procRoot: "/nonexistent-proc-root",
		};
		expect(await isCommitStageRunning(deps)).toBe(false);
	});

	test("unit finished and kept by RemainAfterExit (active/exited) -> false", async () => {
		const deps: CommitStageProbeDeps = {
			showUnit: async () => ({
				exitCode: 0,
				stdout: `LoadState=loaded\nActiveState=active\nSubState=exited\nControlGroup=${UNIT_CGROUP}\n`,
				stderr: "",
			}),
			cgroupRoot: "/nonexistent-cgroup-root",
			procRoot: "/nonexistent-proc-root",
		};
		expect(await isCommitStageRunning(deps)).toBe(false);
	});
});
