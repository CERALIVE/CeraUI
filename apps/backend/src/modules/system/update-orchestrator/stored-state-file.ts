import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
	decodeAuthorityUtf8,
	parseAuthorityJson,
} from "./strict-authority-json.ts";

export const STORED_STATE_LIMITS = {
	scalar: 4096,
	receipt: 16_384,
	intent: 65_536,
	agent: 262_144,
	job: 262_144,
	settings: 16_384,
	packages: 8 * 1024 * 1024,
	quarantine: 64 * 1024 * 1024,
	recoveryReceipt: 16 * 1024 * 1024,
} as const;

export class StoredStateReadError extends Error {
	override readonly name = "StoredStateReadError";
	constructor(
		readonly reason:
			| "not_regular_file"
			| "oversize"
			| "changed"
			| "read_failed",
		options?: ErrorOptions,
	) {
		super(reason, options);
	}
}

export async function readStoredStateFile(
	path: string,
	maxBytes: number = STORED_STATE_LIMITS.agent,
): Promise<string | null> {
	const bytes = await readStoredStateBytes(path, maxBytes);
	return bytes === null ? null : decodeAuthorityUtf8(bytes);
}

export async function readStoredStateJson(
	path: string,
	maxBytes: number,
): Promise<unknown> {
	const text = await readStoredStateFile(path, maxBytes);
	return text === null ? undefined : parseAuthorityJson(text);
}

function absent(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function openStoredStateDirectory(
	directory: string,
	privateAncestry = false,
): number {
	const flags =
		constants.O_RDONLY |
		constants.O_DIRECTORY |
		constants.O_NOFOLLOW |
		constants.O_NONBLOCK;
	let parent = openSync("/", flags);
	try {
		for (const component of resolve(directory).split("/").filter(Boolean)) {
			const child = openSync(`/proc/self/fd/${parent}/${component}`, flags);
			try {
				const info = fstatSync(child);
				const uid = process.getuid?.() ?? 0;
				const stickyRoot = info.uid === 0 && (info.mode & 0o1000) !== 0;
				if (
					privateAncestry &&
					((info.uid !== 0 && info.uid !== uid) ||
						((info.mode & 0o022) !== 0 && !stickyRoot))
				) {
					throw new StoredStateReadError("read_failed");
				}
			} catch (error) {
				closeSync(child);
				throw error;
			}
			closeSync(parent);
			parent = child;
		}
		return parent;
	} catch (error) {
		closeSync(parent);
		throw error;
	}
}

export function storedStateEntryPresent(path: string): boolean {
	let parent: number;
	try {
		parent = openStoredStateDirectory(dirname(resolve(path)));
	} catch (cause) {
		if (absent(cause)) return false;
		throw new StoredStateReadError("read_failed", { cause });
	}
	try {
		lstatSync(`/proc/self/fd/${parent}/${basename(path)}`);
		return true;
	} catch (cause) {
		if (absent(cause)) return false;
		throw new StoredStateReadError("read_failed", { cause });
	} finally {
		closeSync(parent);
	}
}

export function readStoredStateDescriptor(
	fd: number,
	maxBytes: number,
): Buffer {
	const before = fstatSync(fd, { bigint: true });
	if (!before.isFile()) throw new StoredStateReadError("not_regular_file");
	if (before.size > BigInt(maxBytes))
		throw new StoredStateReadError("oversize");
	const bytes = Buffer.alloc(Number(before.size) + 1);
	let used = 0;
	while (used < bytes.length) {
		const count = readSync(fd, bytes, used, bytes.length - used, used);
		if (count === 0) break;
		used += count;
	}
	const after = fstatSync(fd, { bigint: true });
	if (
		BigInt(used) !== before.size ||
		after.size !== before.size ||
		after.mtimeNs !== before.mtimeNs ||
		after.ctimeNs !== before.ctimeNs
	)
		throw new StoredStateReadError("changed");
	return bytes.subarray(0, used);
}

export function readStoredStateFileSync(
	path: string,
	maxBytes: number,
): string | null {
	let parent: number;
	try {
		parent = openStoredStateDirectory(dirname(resolve(path)));
	} catch (cause) {
		if (absent(cause)) return null;
		throw new StoredStateReadError("read_failed", { cause });
	}
	try {
		let fd: number;
		try {
			fd = openSync(
				`/proc/self/fd/${parent}/${basename(path)}`,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
		} catch (cause) {
			if (absent(cause)) return null;
			throw cause;
		}
		try {
			return decodeAuthorityUtf8(readStoredStateDescriptor(fd, maxBytes));
		} finally {
			closeSync(fd);
		}
	} catch (cause) {
		throw new StoredStateReadError("read_failed", { cause });
	} finally {
		closeSync(parent);
	}
}

export async function readStoredStateBytes(
	path: string,
	maxBytes: number,
): Promise<Buffer | null> {
	const absolute = resolve(path);
	let parent: number;
	try {
		parent = openStoredStateDirectory(dirname(absolute));
	} catch (cause) {
		if (absent(cause)) return null;
		throw new StoredStateReadError("read_failed", { cause });
	}
	try {
		return await readEntry(
			`/proc/self/fd/${parent}/${basename(absolute)}`,
			maxBytes,
		);
	} catch (cause) {
		if (cause instanceof StoredStateReadError) throw cause;
		throw new StoredStateReadError("read_failed", { cause });
	} finally {
		closeSync(parent);
	}
}

async function readEntry(
	path: string,
	maxBytes: number,
): Promise<Buffer | null> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (error) {
		if (absent(error)) return null;
		throw error;
	}
	try {
		const before = await handle.stat();
		if (!before.isFile()) throw new StoredStateReadError("not_regular_file");
		if (before.size > maxBytes) throw new StoredStateReadError("oversize");
		const bytes = Buffer.alloc(before.size + 1);
		let used = 0;
		while (used < bytes.length) {
			const { bytesRead } = await handle.read(
				bytes,
				used,
				bytes.length - used,
				used,
			);
			if (bytesRead === 0) break;
			used += bytesRead;
		}
		const after = await handle.stat();
		if (
			used !== before.size ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs
		)
			throw new StoredStateReadError("changed");
		return bytes.subarray(0, used);
	} finally {
		await handle.close();
	}
}
