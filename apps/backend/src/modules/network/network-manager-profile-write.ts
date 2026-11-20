import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { DEFAULT_MAX_BUFFER, run } from "../../helpers/run.ts";
import type {
	NmProfileReadTrace,
	NmProfileStat,
} from "./network-manager-profile-diagnostics.ts";
import type { NmProfileInstance } from "./network-manager-profile-instance.ts";

export function nmProfileStat(info: BigIntStats): NmProfileStat {
	return {
		dev: String(info.dev),
		inode: String(info.ino),
		size: String(info.size),
		mtime_ns: String(info.mtimeNs),
		ctime_ns: String(info.ctimeNs),
	};
}

const sameStat = (a: BigIntStats, b: BigIntStats): boolean =>
	a.dev === b.dev &&
	a.ino === b.ino &&
	a.ctimeNs === b.ctimeNs &&
	a.size === b.size;

/** Positional reads also work on the pre-rename inode held open by a modifier. */
export async function readNmProfileFd(
	file: FileHandle,
): Promise<Buffer | undefined> {
	try {
		const before = await file.stat({ bigint: true });
		if (!before.isFile() || before.size > BigInt(DEFAULT_MAX_BUFFER))
			return undefined;
		const bytes = Buffer.alloc(Number(before.size));
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await file.read(
				bytes,
				offset,
				bytes.length - offset,
				offset,
			);
			if (!bytesRead) return undefined;
			offset += bytesRead;
		}
		return sameStat(before, await file.stat({ bigint: true }))
			? bytes
			: undefined;
	} catch (error: unknown) {
		if (error instanceof Error) return undefined;
		throw error;
	}
}

/** The descriptor and bytes are ephemeral; the credential receipt shape is unchanged. */
export async function openNmProfileFile(
	expected: NmProfileInstance["file"],
	trace?: NmProfileReadTrace,
): Promise<
	{ readonly handle: FileHandle; readonly bytes: Buffer } | undefined
> {
	if (!expected) return undefined;
	let handle: FileHandle | undefined;
	let retained = false;
	try {
		handle = await open(
			expected.filename,
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
		const before = await handle.stat({ bigint: true });
		const pathBefore = await lstat(expected.filename, { bigint: true });
		if (trace) {
			trace.fdStat = nmProfileStat(before);
			trace.pathStat = nmProfileStat(pathBefore);
		}
		if (
			String(before.dev) !== expected.device ||
			String(before.ino) !== expected.inode ||
			String(before.ctimeNs) !== expected.ctime ||
			!sameStat(before, pathBefore)
		) {
			if (trace) trace.fileReason = "changed-before-open";
			return undefined;
		}
		const bytes = await readNmProfileFd(handle);
		const pathAfter = await lstat(expected.filename, { bigint: true });
		if (trace) trace.pathStat = nmProfileStat(pathAfter);
		if (!bytes || !sameStat(before, pathAfter)) {
			if (trace) trace.fileReason = "changed-during-fd-read";
			return undefined;
		}
		retained = true;
		return { handle, bytes };
	} catch (error: unknown) {
		if (error instanceof Error) {
			if (trace)
				trace.fileReason =
					"code" in error && error.code === "ENOENT"
						? "vanished"
						: "open-unreadable";
			return undefined;
		}
		throw error;
	} finally {
		if (!retained) await handle?.close();
	}
}

/** Null is a known pre-1.44 server; undefined is an unreadable modern revision. */
export async function readNmVersionId(
	path: string,
): Promise<bigint | null | undefined> {
	const target = ["--system", "get-property", "org.freedesktop.NetworkManager"];
	const options = { timeout: 1000, maxBuffer: 4096 };
	try {
		const version = await run(
			"busctl",
			[
				...target,
				"/org/freedesktop/NetworkManager",
				"org.freedesktop.NetworkManager",
				"Version",
			],
			options,
		);
		const match = /^s "(\d+)\.(\d+)[^"]*"\s*$/.exec(version);
		if (!match?.[1] || !match[2]) return undefined;
		if (Number(match[1]) === 1 && Number(match[2]) < 44) return null;
		if (Number(match[1]) < 1) return undefined;
		const revision = await run(
			"busctl",
			[
				...target,
				path,
				"org.freedesktop.NetworkManager.Settings.Connection",
				"VersionId",
			],
			options,
		);
		const value = /^t (\d+)\s*$/.exec(revision)?.[1];
		return value === undefined ? undefined : BigInt(value);
	} catch (error: unknown) {
		if (error instanceof Error) return undefined;
		throw error;
	}
}
