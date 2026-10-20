import type { Stats } from "node:fs";
import type { KernelLockIdentity } from "../modules/system/update-orchestrator/os-stage-guard-kernel-rows.ts";
import { singletonCredentialsMatch } from "./backend-singleton-credentials.ts";
import { BackendSingletonError } from "./backend-singleton-error.ts";

export type SingletonProcIO = {
	readonly readdir: (path: string) => Promise<string[]>;
	readonly readText: (path: string) => Promise<string>;
	readonly stat: (path: string) => Promise<Stats>;
};

export type SingletonCensusIO = SingletonProcIO & {
	readonly readlink: (path: string) => Promise<string>;
	readonly getuid: () => number | undefined;
	readonly lockIdentity: (pid: number) => Promise<KernelLockIdentity | null>;
};

export class SingletonCensusError extends Error {
	override readonly name = "SingletonCensusError";
	readonly reason = "uid-unavailable";
	constructor() {
		super("Singleton census requires a process uid");
	}
}

export async function singletonCensus(
	expected: readonly string[],
	pendingPid: number | undefined,
	io: SingletonCensusIO,
): Promise<boolean> {
	const uid = io.getuid();
	if (uid === undefined) throw new SingletonCensusError();
	const flock = await io.stat("/usr/bin/flock");
	for (const name of await io.readdir("/proc")) {
		if (!/^[1-9][0-9]*$/.test(name) || name === String(pendingPid)) continue;
		try {
			if (
				!(await singletonCredentialsMatch(
					{ path: `/proc/${name}`, uid, argv: expected },
					io.readText,
				))
			)
				continue;
			const exe = await io.stat(`/proc/${name}/exe`);
			const trusted =
				(exe.dev === flock.dev && exe.ino === flock.ino) ||
				(await io.readlink(`/proc/${name}/exe`)) === "/usr/bin/flock (deleted)";
			// The grant comes from the held fd, never the replaceable lock pathname.
			if (!(await io.lockIdentity(Number(name)))) continue;
			if (!trusted) throw new BackendSingletonError("unproven");
			return true;
		} catch (cause) {
			if (
				cause instanceof Error &&
				"code" in cause &&
				(cause.code === "ENOENT" || cause.code === "ESRCH")
			)
				continue;
			throw cause;
		}
	}
	return false;
}
