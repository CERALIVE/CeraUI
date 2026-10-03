import { SOFTWARE_UPDATE_LOCK } from "./lock.ts";
import { parentOf, sameArgv, splitArgv } from "./os-stage-guard-kernel-rows.ts";
import type {
	OsGuardKernelDeps,
	OsGuardKernelInput,
} from "./os-stage-guard-lock.ts";
import {
	OS_STAGE_GUARD_HELPER,
	OS_STAGE_GUARD_UNIT,
} from "./os-stage-job-files.ts";
import { processIdentity } from "./os-stage-observation.ts";

const GROUP = `/system.slice/${OS_STAGE_GUARD_UNIT}`;
const missing = (cause: unknown) =>
	cause instanceof Error && "code" in cause && cause.code === "ENOENT";
export class GuardTreeChanged extends Error {}

export async function guardianMembers(
	input: OsGuardKernelInput,
	deps: OsGuardKernelDeps,
): Promise<string[] | null> {
	let raw: string;
	try {
		raw = await deps.read(`/sys/fs/cgroup${GROUP}/cgroup.procs`);
	} catch (cause) {
		if (!missing(cause)) throw cause;
		return input.pid === null ? [] : null;
	}
	const members = raw.trim().split(/\s+/).filter(Boolean);
	if (members.some((pid) => !/^[1-9][0-9]*$/.test(pid))) return null;
	if (input.pid === null) return members.length ? null : members;
	return members.includes(input.pid) ? members : null;
}

export async function memberIdentities(
	input: OsGuardKernelInput,
	members: readonly string[],
	deps: OsGuardKernelDeps,
): Promise<Map<string, string> | null> {
	const identities = new Map<string, string>();
	const parents = new Map<string, string>();
	const flock = [
		"/usr/bin/flock",
		"-n",
		"-E",
		"75",
		"-x",
		SOFTWARE_UPDATE_LOCK,
		OS_STAGE_GUARD_HELPER,
		input.attemptId,
	];
	const descendants = [
		["/bin/bash", OS_STAGE_GUARD_HELPER, input.attemptId],
		["sleep", "1"],
	];
	for (const pid of members) {
		const raw = await readGuardProc(deps, pid, "stat");
		identities.set(pid, processIdentity(pid, raw));
		parents.set(pid, parentOf(raw));
		if ((await readGuardProc(deps, pid, "cgroup")).trim() !== `0::${GROUP}`)
			return null;
		const argv = splitArgv(await readGuardProc(deps, pid, "cmdline"));
		const expected = pid === input.pid ? [flock] : descendants;
		// Shell command substitutions can briefly expose stat (or an unfinished argv).
		// Re-observe instead of accepting any extra dispatch-capable tree member.
		if (!expected.some((value) => sameArgv(argv, value)))
			throw new GuardTreeChanged();
	}
	for (const pid of members) {
		const seen = new Set<string>();
		let ancestor = pid;
		while (ancestor !== input.pid) {
			if (seen.has(ancestor) || !parents.has(ancestor)) return null;
			seen.add(ancestor);
			ancestor = parents.get(ancestor) ?? "";
		}
	}
	return identities;
}

export async function readGuardProc(
	deps: OsGuardKernelDeps,
	pid: string,
	file: "stat" | "cgroup" | "cmdline",
): Promise<string> {
	try {
		return await deps.read(`/proc/${pid}/${file}`);
	} catch (cause) {
		if (missing(cause)) throw new GuardTreeChanged();
		throw cause;
	}
}
