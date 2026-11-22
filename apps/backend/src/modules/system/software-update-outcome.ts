/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import type { UpdateOutcome, UpdateTarget } from "@ceraui/rpc/schemas";
import type { spawnWithTimeout } from "../../helpers/spawn-policy.ts";
import { APT_PACKAGE_NAME_RE } from "./apt-package-name.ts";
import { APT_SIMULATION_VERSION_RE } from "./apt-simulation-row.ts";
import type { DetachedAptServiceState } from "./software-update-service-state.ts";

export type UpdateOutcomeDeps = {
	/** One read of the fixed unit: the same `systemctl show` recovery makes. */
	readonly inspect: () => Promise<DetachedAptServiceState>;
	/** This process reports the unit's end itself: it observes it, or its recovery is still to look. */
	readonly observed: () => boolean;
	readonly run: typeof spawnWithTimeout;
	readonly now: () => number;
};

const PROBE_TIMEOUT_MS = 5_000;
// One package query plus one comparison per installed row, ample for the 512
// targets the RPC accepts; past it nothing is proven.
export const UPDATE_OUTCOME_DEADLINE_MS = 20_000;
const FORMAT = `-f=${["Package", "Architecture", "db:Status-Abbrev", "Version"].map((field) => `\${${field}}`).join("\\t")}\\n`;
// db:Status-Abbrev is want (unknown/install/hold/remove/purge), state, error flag.
const ROW =
	/^([a-z0-9][a-z0-9+.-]*)\t([a-z0-9][a-z0-9-]*)\t([uihrp][ncHUFWti][ R])\t([0-9][A-Za-z0-9.+:~-]*)?$/;
// Installed and configured with no reinstall required; a hold changes no state.
const CONFIGURED = /^[ih]i $/;
// Not-installed or config-files only: no instance of the package is there.
const NO_INSTANCE = /^.[nc]/;

type Row = {
	readonly name: string;
	readonly arch: string;
	readonly status: string;
	readonly version: string;
};

const answers = (target: UpdateTarget) => {
	const [name, arch] = target.name.split(":");
	return (row: Row) =>
		row.name === name && (arch === undefined || row.arch === arch);
};

/**
 * What the install a tab watched did, asked once CeraUI restarted under it.
 * `targets` is the vector that install was launched with, as its own running
 * frames carried it. Success only when one complete read of dpkg's database
 * shows every target installed, configured and at its version or later
 * (dpkg's order). Otherwise unknown; the fixed-name unit's non-zero exit, read
 * after the packages, is attached only as a hint, because it may be another
 * run's. Read-only: nothing here writes, claims, stops or retires anything.
 */
export async function readUpdateOutcome(
	targets: readonly UpdateTarget[],
	deps: UpdateOutcomeDeps,
): Promise<UpdateOutcome> {
	if (
		targets.some(
			({ name, version }) =>
				!APT_PACKAGE_NAME_RE.test(name) ||
				!APT_SIMULATION_VERSION_RE.test(version),
		)
	)
		return { kind: "unknown" };
	const attained = await targetsAttained(targets, deps);
	const unit = await deps.inspect().catch(() => undefined);
	// Its end reaches the tab as the observer's own frame; a failed probe
	// cannot tell whether one is still to come.
	if (deps.observed() && unit?.kind !== "absent")
		return unit ? { kind: "running" } : { kind: "unknown" };
	if (attained) return { kind: "success" };
	return unit?.kind === "finished" && unit.exitCode !== 0
		? { kind: "unknown", exit: unit.exitCode }
		: { kind: "unknown" };
}

async function targetsAttained(
	targets: readonly UpdateTarget[],
	{ run, now }: UpdateOutcomeDeps,
): Promise<boolean> {
	if (targets.length === 0) return false;
	const deadline = now() + UPDATE_OUTCOME_DEADLINE_MS;
	// A timeout, a throw or no time left is no answer.
	const ask = (argv: string[]) => {
		const left = deadline - now();
		return left > 0
			? run(argv, { timeoutMs: Math.min(PROBE_TIMEOUT_MS, left) }).catch(
					() => null,
				)
			: null;
	};
	const query = await ask([
		"dpkg-query",
		"-W",
		FORMAT,
		"--",
		...targets.map(({ name }) => name),
	]);
	// Exit 1 is a name dpkg does not know: no complete read either.
	if (query?.exitCode !== 0 || !query.stdout.endsWith("\n")) return false;
	const rows: Row[] = [];
	for (const line of query.stdout.slice(0, -1).split("\n")) {
		const [, name = "", arch = "", status = "", version = ""] =
			ROW.exec(line) ?? [];
		if (
			!status ||
			rows.some((row) => row.name === name && row.arch === arch) ||
			!targets.some((target) =>
				answers(target)({ name, arch, status, version }),
			)
		)
			return false;
		rows.push({ name, arch, status, version });
	}
	for (const target of targets) {
		const present = rows
			.filter(answers(target))
			.filter((row) => !NO_INSTANCE.test(row.status));
		if (
			present.length === 0 ||
			present.some((row) => !CONFIGURED.test(row.status))
		)
			return false;
		for (const row of present) {
			const compared = await ask([
				"dpkg",
				"--compare-versions",
				row.version,
				"ge",
				target.version,
			]);
			if (compared?.exitCode !== 0) return false;
		}
	}
	return true;
}
