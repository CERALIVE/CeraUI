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
// One package query plus up to two comparisons per target, ample for the 512
// targets the RPC accepts; past it nothing is proven.
export const UPDATE_OUTCOME_DEADLINE_MS = 20_000;
const FORMAT = `-f=${["Package", "Architecture", "db:Status-Abbrev", "Version"].map((field) => `\${${field}}`).join("\\t")}\\n`;
// db:Status-Abbrev is want (unknown/install/hold/remove/purge), state, error flag.
const ROW =
	/^([a-z0-9][a-z0-9+.-]*)\t([a-z0-9][a-z0-9-]*)\t([uihrp][ncHUFWti][ R])\t([0-9][A-Za-z0-9.+:~-]*)?$/;
// Installed and configured with no reinstall required; a hold changes no state.
const CONFIGURED = /^[ih]i $/;
// The same, and not held: a held package is one the operator keeps where it is.
const CONFIGURED_UNHELD = /^ii $/;
// Half-installed, unpacked, half-configured, awaiting or pending triggers, or reinstall required.
const UNFINISHED = /^.[HUFWt]|^..R/;
const ARCH = /^[a-z0-9][a-z0-9-]*$/;

type Row = {
	readonly name: string;
	readonly arch: string;
	readonly status: string;
	readonly version: string;
};

// apt prints a foreign instance as `name:arch`; dpkg-query lists the bare name.
const packageOf = (target: UpdateTarget) => target.name.split(":")[0] ?? "";

/**
 * What the install a tab watched did, asked once CeraUI restarted under it.
 * `targets` is the vector that install was launched with, as its own running
 * frames carried it: each target an exact instance (name and architecture)
 * and the version installed before. Success only when one complete read of
 * dpkg's database shows every target's own instance configured at its
 * version or later (dpkg's order), none was already there before, and the
 * fixed-name unit is neither running nor last failed. Otherwise unknown; that
 * unit's non-zero exit, read after the packages, is attached only as a hint,
 * because it may be another run's. Read-only: nothing here writes, claims,
 * stops or retires anything.
 */
export async function readUpdateOutcome(
	targets: readonly UpdateTarget[],
	deps: UpdateOutcomeDeps,
): Promise<UpdateOutcome> {
	if (
		targets.some(
			({ name, version, arch, from }) =>
				!APT_PACKAGE_NAME_RE.test(name) ||
				!APT_SIMULATION_VERSION_RE.test(version) ||
				!ARCH.test(arch) ||
				(from !== undefined && !APT_SIMULATION_VERSION_RE.test(from)),
		)
	)
		return { kind: "unknown" };
	const attained = await targetsAttained(targets, deps);
	const unit = await deps.inspect().catch(() => undefined);
	// Its end reaches the tab as the observer's own frame; a failed probe
	// cannot tell whether one is still to come.
	if (deps.observed() && unit?.kind !== "absent")
		return unit ? { kind: "running" } : { kind: "unknown" };
	const failedExit =
		unit?.kind === "finished" && unit.exitCode !== 0
			? unit.exitCode
			: undefined;
	// A running unit has not finished; a failed one may be this very run.
	if (attained && unit?.kind !== "running" && failedExit === undefined)
		return { kind: "success" };
	return failedExit === undefined
		? { kind: "unknown" }
		: { kind: "unknown", exit: failedExit };
}

type Ask = (
	argv: string[],
) => Promise<Awaited<ReturnType<typeof spawnWithTimeout>> | null> | null;

// A timeout, a throw or no time left is no answer.
function asker(
	{ run, now }: Pick<UpdateOutcomeDeps, "run" | "now">,
	deadline: number,
): Ask {
	return (argv) => {
		const left = deadline - now();
		return left > 0
			? run(argv, { timeoutMs: Math.min(PROBE_TIMEOUT_MS, left) }).catch(
					() => null,
				)
			: null;
	};
}

// One complete dpkg-query answer as rows: one per instance, each of `packages` when given.
function readRows(stdout: string, packages?: readonly string[]): Row[] | null {
	if (!stdout.endsWith("\n")) return null;
	const rows: Row[] = [];
	const instances = new Set<string>();
	for (const line of stdout.slice(0, -1).split("\n")) {
		const [, name = "", arch = "", status = "", version = ""] =
			ROW.exec(line) ?? [];
		const instance = `${name}\t${arch}`;
		if (
			!status ||
			(packages !== undefined && !packages.includes(name)) ||
			instances.has(instance)
		)
			return null;
		instances.add(instance);
		rows.push({ name, arch, status, version });
	}
	return rows;
}

/** Whether one complete dpkg read shows every target's own instance configured at its version or later. */
export async function targetsAttained(
	targets: readonly UpdateTarget[],
	deps: Pick<UpdateOutcomeDeps, "run" | "now">,
): Promise<boolean> {
	if (targets.length === 0) return false;
	const ask = asker(deps, deps.now() + UPDATE_OUTCOME_DEADLINE_MS);
	const packages = [...new Set(targets.map(packageOf))];
	const query = await ask(["dpkg-query", "-W", FORMAT, "--", ...packages]);
	// Exit 1 is a name dpkg does not know: no complete read either.
	if (query?.exitCode !== 0) return false;
	const rows = readRows(query.stdout, packages);
	return rows !== null && attainedFrom(targets, rows, ask, CONFIGURED);
}

/**
 * Whether each set of targets is installed, judged from one snapshot of dpkg's
 * whole database: every instance configured, not held, at its version or later.
 * Every set is judged from the same rows, and the pass ends with a second read
 * that must equal the first, so nothing changed while it judged. Unfinished
 * work on any package (by the snapshot or by `dpkg --audit`), a failed,
 * partial or changed read, or no time left proves no set.
 */
export async function targetSetsAttained(
	sets: readonly (readonly UpdateTarget[])[],
	deps: Pick<UpdateOutcomeDeps, "run" | "now">,
): Promise<boolean[]> {
	const none = sets.map(() => false);
	// The runner answers exit 0 with a partial drain once its deadline fired, so only
	// an answer back inside its own timeout is whole.
	const whole: typeof spawnWithTimeout = async (argv, options) => {
		const started = performance.now();
		const answer = await deps.run(argv, options);
		return performance.now() - started < (options?.timeoutMs ?? 0)
			? answer
			: { exitCode: 1, stdout: "", stderr: "" };
	};
	const ask = asker(
		{ run: whole, now: deps.now },
		deps.now() + UPDATE_OUTCOME_DEADLINE_MS,
	);
	const read = () => ask(["dpkg-query", "-W", FORMAT]);
	const snapshot = await read();
	if (snapshot?.exitCode !== 0) return none;
	const rows = readRows(snapshot.stdout);
	if (rows === null || rows.some(({ status }) => UNFINISHED.test(status)))
		return none;
	const verdicts: boolean[] = [];
	for (const set of sets)
		verdicts.push(
			set.length > 0 && (await attainedFrom(set, rows, ask, CONFIGURED_UNHELD)),
		);
	const confirm = await read();
	if (confirm?.exitCode !== 0 || confirm.stdout !== snapshot.stdout)
		return none;
	// A cut snapshot can hide unfinished work; any prefix of a report is not empty.
	const audit = await ask(["dpkg", "--audit"]);
	return audit?.exitCode === 0 && audit.stdout === "" && audit.stderr === ""
		? verdicts
		: none;
}

async function attainedFrom(
	targets: readonly UpdateTarget[],
	rows: readonly Row[],
	ask: Ask,
	configured: RegExp,
): Promise<boolean> {
	for (const target of targets) {
		// Only the admitted instance counts: another architecture's is not it.
		const row = rows.find(
			(candidate) =>
				candidate.name === packageOf(target) && candidate.arch === target.arch,
		);
		if (!row || !configured.test(row.status)) return false;
		const reached = await ask([
			"dpkg",
			"--compare-versions",
			row.version,
			"ge",
			target.version,
		]);
		if (reached?.exitCode !== 0) return false;
		// Already at that version before the run: nothing proves this run did it.
		if (target.from !== undefined) {
			const before = await ask([
				"dpkg",
				"--compare-versions",
				target.from,
				"lt",
				target.version,
			]);
			if (before?.exitCode !== 0) return false;
		}
	}
	return true;
}
