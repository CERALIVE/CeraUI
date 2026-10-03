import { readdir, stat } from "node:fs/promises";
import { SOFTWARE_UPDATE_LOCK } from "./lock.ts";
import {
	equalSets,
	type Identity,
	type KernelLockIdentity,
	lockKey,
	lockTable,
	parentOf,
	sameArgv,
	splitArgv,
} from "./os-stage-guard-kernel-rows.ts";
import {
	GuardTreeChanged,
	guardianMembers,
	memberIdentities,
	readGuardProc,
} from "./os-stage-guard-tree.ts";
import { OS_STAGE_GUARD_HELPER } from "./os-stage-job-files.ts";
import { readOsLockKernelDevice } from "./os-stage-lock-device.ts";
import { processIdentity } from "./os-stage-observation.ts";

export type OsGuardKernelDeps = {
	readonly read: (path: string) => Promise<string>;
	readonly list: (path: string) => Promise<string[]>;
	readonly identity: (path: string) => Promise<Identity>;
	readonly device: typeof readOsLockKernelDevice;
	readonly lock: string;
};
export const defaultOsGuardKernelDeps: OsGuardKernelDeps = {
	read: (path) => Bun.file(path).text(),
	list: readdir,
	identity: async (path) => {
		const value = await stat(path);
		return { dev: value.dev, ino: value.ino };
	},
	lock: SOFTWARE_UPDATE_LOCK,
	device: readOsLockKernelDevice,
};
export type OsGuardKernelInput = {
	readonly pid: string | null;
	readonly attemptId: string;
	readonly temporaryPid?: string;
};
type Holders = { readonly granted: Set<string>; readonly mainFd: boolean };

const ATTEMPTS = 3;
const missing = (cause: unknown) =>
	cause instanceof Error && "code" in cause && cause.code === "ENOENT";
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;

/** Positive kernel proof that the update lock is held exactly as expected. */
export async function proveOsGuardKernelOwnership(
	input: OsGuardKernelInput,
	deps: OsGuardKernelDeps = defaultOsGuardKernelDeps,
): Promise<boolean> {
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		try {
			return await proveOnce(input, deps);
		} catch (cause) {
			if (!(cause instanceof GuardTreeChanged)) throw cause;
		}
	}
	return false;
}

async function proveOnce(
	input: OsGuardKernelInput,
	deps: OsGuardKernelDeps,
): Promise<boolean> {
	const identity = await deps.identity(deps.lock);
	const device = await deps.device(deps.lock, identity);
	if (!device) return false;
	const lock = { ...identity, device };
	const before = lockTable(await deps.read("/proc/locks"), lock);
	const members = await guardianMembers(input, deps);
	if (!members || !before) return false;
	const identities = await memberIdentities(input, members, deps);
	if (!identities) return false;
	const holders = await lockHolders(input, { lock, members, deps });
	if (!holders) return false;
	for (const [pid, identity] of identities) {
		if (
			processIdentity(pid, await readGuardProc(deps, pid, "stat")) !== identity
		)
			return false;
	}
	const after = lockTable(await deps.read("/proc/locks"), lock);
	if (
		!same(lock, await deps.identity(deps.lock)) ||
		!after ||
		!equalSets(before, after) ||
		!equalSets(before, holders.granted)
	)
		return false;
	return input.pid === null
		? holders.granted.size === (input.temporaryPid ? 1 : 0)
		: holders.mainFd && holders.granted.size === 1;
}

async function lockHolders(
	input: OsGuardKernelInput,
	scope: {
		readonly lock: KernelLockIdentity;
		readonly members: readonly string[];
		readonly deps: OsGuardKernelDeps;
	},
): Promise<Holders | null> {
	const { lock, members, deps } = scope;
	const granted = new Set<string>();
	let mainFd = false;
	const pids = (await deps.list("/proc")).filter((name) =>
		/^[1-9][0-9]*$/.test(name),
	);
	for (const pid of pids) {
		for (const fd of await openLockFds(deps, pid, lock)) {
			if (!members.includes(pid) && !(await temporaryHolder(input, pid, deps)))
				return null;
			if (pid === input.pid) mainFd = true;
			let info: string;
			try {
				info = await deps.read(`/proc/${pid}/fdinfo/${fd}`);
			} catch (cause) {
				if (missing(cause)) continue;
				throw cause;
			}
			for (const row of info.split("\n")) {
				if (!row.startsWith("lock:")) continue;
				const key = lockKey(row.slice(5), lock);
				if (!key || key.owner !== (input.pid ?? input.temporaryPid))
					return null;
				granted.add(key.value);
			}
		}
	}
	return { granted, mainFd };
}

async function openLockFds(
	deps: OsGuardKernelDeps,
	pid: string,
	lock: Identity,
): Promise<string[]> {
	let fds: string[];
	try {
		fds = await deps.list(`/proc/${pid}/fd`);
	} catch (cause) {
		if (missing(cause)) return [];
		throw cause;
	}
	const matching: string[] = [];
	for (const fd of fds) {
		try {
			if (same(lock, await deps.identity(`/proc/${pid}/fd/${fd}`)))
				matching.push(fd);
		} catch (cause) {
			if (!missing(cause)) throw cause;
		}
	}
	return matching;
}

async function temporaryHolder(
	input: OsGuardKernelInput,
	pid: string,
	deps: OsGuardKernelDeps,
): Promise<boolean> {
	if (!input.temporaryPid) return false;
	if (pid === input.temporaryPid) return true;
	try {
		const parent = parentOf(await deps.read(`/proc/${pid}/stat`));
		const argv = splitArgv(await deps.read(`/proc/${pid}/cmdline`));
		return (
			parent === input.temporaryPid &&
			sameArgv(argv, ["/bin/bash", OS_STAGE_GUARD_HELPER, "--orphan-lock"])
		);
	} catch (cause) {
		if (missing(cause)) return false;
		throw cause;
	}
}
