import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Identity } from "./os-stage-guard-kernel-rows.ts";

export function kernelDeviceFromMount(
	fdinfo: string,
	mountinfo: string,
	inode: number,
): string | null {
	const ids = [...fdinfo.matchAll(/^mnt_id:\s*(\d+)$/gm)];
	const inodes = [...fdinfo.matchAll(/^ino:\s*(\d+)$/gm)];
	if (
		ids.length !== 1 ||
		inodes.length !== 1 ||
		inodes[0]?.[1] !== String(inode)
	)
		return null;
	const mounts = mountinfo
		.split("\n")
		.filter((line) => line.split(" ")[0] === ids[0]?.[1]);
	if (mounts.length !== 1) return null;
	const device = mounts[0]?.split(" ")[2]?.match(/^(\d+):(\d+)$/);
	if (!device?.[1] || !device[2]) return null;
	return `${BigInt(device[1]).toString(16).padStart(2, "0")}:${BigInt(device[2]).toString(16).padStart(2, "0")}`;
}

/** Use the open file's mount identity; never decode st_dev by guessed bit shifts. */
export async function readOsLockKernelDevice(
	path: string,
	identity: Identity,
): Promise<string | null> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const value = await handle.stat();
		if (
			value.dev !== identity.dev ||
			value.ino !== identity.ino ||
			!value.isFile()
		)
			return null;
		return kernelDeviceFromMount(
			await Bun.file(`/proc/self/fdinfo/${handle.fd}`).text(),
			await Bun.file("/proc/self/mountinfo").text(),
			identity.ino,
		);
	} finally {
		await handle.close();
	}
}
