/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import type { UpdateOutcome, UpdatePackage } from "@ceraui/rpc/schemas";
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
};

type Target = { readonly name: string; readonly version: string };

const PROBE_TIMEOUT_MS = 5_000;
const UNKNOWN: UpdateOutcome = { kind: "unknown" };

/**
 * What an install a tab watched did, asked once CeraUI restarted under it:
 * success iff every package the device offered to install is installed at
 * its version or later (dpkg's own comparison); otherwise the unit's non-zero
 * exit, read once, as a hint; otherwise unknown. Read-only: nothing here
 * writes, claims, stops or retires anything.
 */
export async function readUpdateOutcome(
	packages: readonly UpdatePackage[],
	deps: UpdateOutcomeDeps,
): Promise<UpdateOutcome> {
	const targets = packages.flatMap((pkg): Target[] =>
		pkg.actionable === true && pkg.version !== undefined
			? [{ name: pkg.name, version: pkg.version }]
			: [],
	);
	if (
		targets.some(
			({ name, version }) =>
				!APT_PACKAGE_NAME_RE.test(name) ||
				!APT_SIMULATION_VERSION_RE.test(version),
		)
	)
		return UNKNOWN;
	try {
		const unit = await deps.inspect();
		// Its end reaches the tab as the observer's own frame.
		if (unit.kind !== "absent" && deps.observed()) return { kind: "running" };
		const reached = await reachedTargets(targets, deps.run);
		if (reached) return { kind: "success" };
		if (reached === false && unit.kind === "finished" && unit.exitCode !== 0)
			return {
				kind: "failed",
				reason: `apt-get exited with code ${unit.exitCode}`,
			};
	} catch {
		// A probe that gives no answer proves nothing either way.
	}
	return UNKNOWN;
}

/** null: no target is known, or dpkg gave no answer. */
async function reachedTargets(
	targets: readonly Target[],
	run: UpdateOutcomeDeps["run"],
): Promise<boolean | null> {
	if (targets.length === 0) return null;
	const query = await run(
		[
			"dpkg-query",
			"-W",
			"-f=$" + "{Package}\\t$" + "{db:Status-Abbrev}\\t$" + "{Version}\\n",
			"--",
			...targets.map(({ name }) => name),
		],
		{ timeoutMs: PROBE_TIMEOUT_MS },
	);
	// 1: a name is not installed at all; anything else is no answer.
	if (query.exitCode !== 0 && query.exitCode !== 1) return null;
	const installed = new Map<string, string>();
	for (const line of query.stdout.split("\n")) {
		const [name, status, version] = line.split("\t");
		if (name && version && status?.startsWith("ii"))
			installed.set(name, version);
	}
	for (const target of targets) {
		const version = installed.get(target.name);
		if (version === undefined) return false;
		const compared = await run(
			["dpkg", "--compare-versions", version, "ge", target.version],
			{ timeoutMs: PROBE_TIMEOUT_MS },
		);
		if (compared.exitCode === 1) return false;
		if (compared.exitCode !== 0) return null;
	}
	return true;
}
