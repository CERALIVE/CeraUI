import { lstat, readdir, readlink, stat } from "node:fs/promises";
import {
	type KernelLockIdentity,
	lockKey,
} from "../modules/system/update-orchestrator/os-stage-guard-kernel-rows.ts";
import { kernelDeviceFromMount } from "../modules/system/update-orchestrator/os-stage-lock-device.ts";
import {
	type SingletonCensusIO,
	type SingletonProcIO,
	singletonCensus,
} from "./backend-singleton-qualify.ts";

export const singletonProcIO: SingletonProcIO = {
	readdir,
	stat,
	readText: (path) => Bun.file(path).text(),
};

export type SingletonPaths = { readonly lock: string; readonly helper: string };

export function singletonArgv(paths: SingletonPaths): string[] {
	return [
		"/usr/bin/flock",
		"-n",
		"-E",
		"75",
		"-x",
		paths.lock,
		paths.helper,
		"--orphan-lock",
	];
}

export async function singletonHolderPresent(
	paths: SingletonPaths,
	pendingPid?: number,
	io: SingletonCensusIO = {
		...singletonProcIO,
		readlink,
		getuid: () => process.getuid?.(),
		lockIdentity: singletonLockIdentity,
	},
): Promise<boolean> {
	return singletonCensus(singletonArgv(paths), pendingPid, io);
}

export async function singletonLockIdentity(
	pid: number,
	io: SingletonProcIO = singletonProcIO,
): Promise<KernelLockIdentity | null> {
	let identity: KernelLockIdentity | null = null;
	const mountinfo = await io.readText(`/proc/${pid}/mountinfo`);
	for (const fd of await io.readdir(`/proc/${pid}/fd`)) {
		const info = await io.readText(`/proc/${pid}/fdinfo/${fd}`);
		if (!/^lock:/m.test(info)) continue;
		const file = await io.stat(`/proc/${pid}/fd/${fd}`);
		const device = kernelDeviceFromMount(info, mountinfo, file.ino);
		if (!file.isFile() || !device || identity) return null;
		const lock = { dev: file.dev, ino: file.ino, device };
		const rows = info.split("\n").filter((row) => row.startsWith("lock:"));
		if (
			rows.length !== 1 ||
			lockKey((rows[0] ?? "").slice(5), lock)?.owner !== String(pid)
		)
			return null;
		identity = lock;
	}
	return identity;
}

export async function singletonPathMatches(
	path: string,
	identity: KernelLockIdentity,
): Promise<boolean> {
	const file = await lstat(path);
	return (
		file.isFile() &&
		!file.isSymbolicLink() &&
		file.dev === identity.dev &&
		file.ino === identity.ino
	);
}
