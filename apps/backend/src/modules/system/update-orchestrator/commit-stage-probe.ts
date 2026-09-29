/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

/**
 * D8's wire-independent answer to "may the package-install unit still be
 * stopped?". The unit runs `apt-get -d … upgrade && apt-get --no-download …
 * install` under one flock; stopping it during the first (download) stage is
 * safe, stopping it once the second stage or any dpkg runs is not. The wire
 * only reports `installing` after dpkg prints its first `Unpacking` line, so
 * this reads the unit's own processes instead: the commit stage is running
 * when any process in the unit's cgroup is `dpkg`/`dpkg-*` or an `apt-get`
 * whose argv carries `--no-download`.
 *
 * FAIL CLOSED: an active unit whose processes cannot be read answers `true`
 * (a refused stream start is safe; a killed dpkg is not). An absent or
 * inactive unit answers `false`.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../../helpers/logger.ts";
import {
	type SpawnWithTimeoutResult,
	spawnWithTimeout,
} from "../../../helpers/spawn-policy.ts";
import { SOFTWARE_UPDATE_UNIT } from "../software-update-service-contract.ts";

const SYSTEMCTL_SHOW_TIMEOUT_MS = 5_000;
const MAX_CGROUP_DEPTH = 4;

export interface CommitStageProbeDeps {
	readonly showUnit: () => Promise<SpawnWithTimeoutResult>;
	readonly cgroupRoot: string;
	readonly procRoot: string;
}

export const defaultCommitStageProbeDeps: CommitStageProbeDeps = {
	showUnit: () =>
		spawnWithTimeout(
			[
				"systemctl",
				"show",
				SOFTWARE_UPDATE_UNIT,
				"--property=LoadState,ActiveState,SubState,ControlGroup",
				"--no-pager",
			],
			{ timeoutMs: SYSTEMCTL_SHOW_TIMEOUT_MS },
		),
	cgroupRoot: "/sys/fs/cgroup",
	procRoot: "/proc",
};

export function isCommitStageProcess(
	comm: string,
	argv: readonly string[],
): boolean {
	if (comm === "dpkg" || comm.startsWith("dpkg-")) return true;
	return comm === "apt-get" && argv.includes("--no-download");
}

type UnitView =
	| { readonly kind: "idle" }
	| { readonly kind: "running"; readonly controlGroup: string };

class CommitStageUnreadableError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "CommitStageUnreadableError";
	}
}

function parseUnitView(result: SpawnWithTimeoutResult): UnitView {
	const properties = new Map<string, string>();
	for (const line of result.stdout.split("\n")) {
		const separator = line.indexOf("=");
		if (separator > 0)
			properties.set(line.slice(0, separator), line.slice(separator + 1));
	}
	if (properties.get("LoadState") === "not-found") return { kind: "idle" };
	if (result.exitCode !== 0)
		throw new CommitStageUnreadableError(
			`systemctl show exited ${result.exitCode}`,
		);
	if (properties.get("LoadState") !== "loaded")
		throw new CommitStageUnreadableError("unit load state unreadable");
	const active = properties.get("ActiveState");
	const sub = properties.get("SubState");
	if (active === "inactive" || active === "failed" || sub === "exited")
		return { kind: "idle" };
	if (
		active !== "active" &&
		active !== "activating" &&
		active !== "deactivating" &&
		active !== "reloading"
	)
		throw new CommitStageUnreadableError(`unit state ${active}/${sub}`);
	const controlGroup = properties.get("ControlGroup") ?? "";
	if (!controlGroup.startsWith("/") || controlGroup.split("/").includes(".."))
		throw new CommitStageUnreadableError("unit control group unreadable");
	return { kind: "running", controlGroup };
}

async function collectPids(dir: string, depth: number): Promise<string[]> {
	const pids = (await Bun.file(join(dir, "cgroup.procs")).text())
		.split("\n")
		.map((entry) => entry.trim())
		.filter((entry) => /^\d+$/.test(entry));
	if (depth >= MAX_CGROUP_DEPTH) return pids;
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.isDirectory())
			pids.push(...(await collectPids(join(dir, entry.name), depth + 1)));
	}
	return pids;
}

function isGone(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return code === "ENOENT" || code === "ESRCH";
}

async function readProcess(
	procRoot: string,
	pid: string,
): Promise<{ comm: string; argv: string[] } | undefined> {
	try {
		const comm = (await Bun.file(join(procRoot, pid, "comm")).text()).trim();
		const argv = (await Bun.file(join(procRoot, pid, "cmdline")).text())
			.split("\0")
			.filter((arg) => arg !== "");
		return { comm, argv };
	} catch (error) {
		if (isGone(error)) return undefined;
		throw error;
	}
}

export async function isCommitStageRunning(
	deps: CommitStageProbeDeps = defaultCommitStageProbeDeps,
): Promise<boolean> {
	try {
		const unit = parseUnitView(await deps.showUnit());
		if (unit.kind === "idle") return false;
		const pids = await collectPids(join(deps.cgroupRoot, unit.controlGroup), 0);
		for (const pid of pids) {
			const proc = await readProcess(deps.procRoot, pid);
			if (proc && isCommitStageProcess(proc.comm, proc.argv)) return true;
		}
		return false;
	} catch (error) {
		logger.warn(
			"update-orchestrator: package-install commit stage could not be ruled out; treating it as running",
			{ error },
		);
		return true;
	}
}
