/**
 * One classification for every optional persistent record a writer derives a
 * whole-file replacement from.
 *
 * An unknown read is NOT an empty record. `absent` (ENOENT) and `valid` are the
 * only answers a writer may build on. `unavailable` (EIO/EAGAIN, a short or
 * changed read, a non-regular entry) is retried by its owner and never written
 * over. `damaged` means the bytes were read completely and refused by the
 * grammar or schema: the exact bytes are archived before anything replaces them.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
	openStoredStateDirectory,
	readStoredStateBytes,
	readStoredStateDescriptor,
} from "../modules/system/update-orchestrator/stored-state-file.ts";
import {
	decodeAuthorityUtf8,
	parseAuthorityJson,
} from "../modules/system/update-orchestrator/strict-authority-json.ts";

export type PersistentRecordRead<T> =
	| { readonly kind: "absent" }
	| { readonly kind: "valid"; readonly value: T }
	| { readonly kind: "damaged"; readonly bytes: Buffer }
	| { readonly kind: "unavailable"; readonly cause: unknown };

export async function readPersistentRecord<T>(
	path: string,
	maxBytes: number,
	parse: (json: unknown) => T,
): Promise<PersistentRecordRead<T>> {
	let bytes: Buffer | null;
	try {
		bytes = await readStoredStateBytes(path, maxBytes);
	} catch (cause) {
		return { kind: "unavailable", cause };
	}
	if (bytes === null) return { kind: "absent" };
	try {
		return {
			kind: "valid",
			value: parse(parseAuthorityJson(decodeAuthorityUtf8(bytes))),
		};
	} catch {
		return { kind: "damaged", bytes };
	}
}

function readBytesSync(path: string, maxBytes: number): Buffer | null {
	let directory: number;
	try {
		directory = openStoredStateDirectory(dirname(path));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw error;
	}
	try {
		let fd: number;
		try {
			fd = openSync(
				`/proc/self/fd/${directory}/${basename(path)}`,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				return null;
			throw error;
		}
		try {
			return readStoredStateDescriptor(fd, maxBytes);
		} finally {
			closeSync(fd);
		}
	} finally {
		closeSync(directory);
	}
}

export function readPersistentRecordSync<T>(
	path: string,
	maxBytes: number,
	parse: (json: unknown) => T,
): PersistentRecordRead<T> {
	let bytes: Buffer | null;
	try {
		bytes = readBytesSync(path, maxBytes);
	} catch (cause) {
		return { kind: "unavailable", cause };
	}
	if (bytes === null) return { kind: "absent" };
	try {
		return {
			kind: "valid",
			value: parse(parseAuthorityJson(decodeAuthorityUtf8(bytes))),
		};
	} catch {
		return { kind: "damaged", bytes };
	}
}

type ArchiveTemp = { readonly name: string; readonly fd: number };
// Keep the inode pinned until cleanup succeeds; errno cannot erase ownership.
const pendingArchiveTemps = new Map<string, ArchiveTemp>();

function cleanupArchiveTemp(key: string, parent: number): void {
	const own = pendingArchiveTemps.get(key);
	if (own === undefined) return;
	const temp = join(`/proc/self/fd/${parent}`, own.name);
	try {
		const current = lstatSync(temp);
		const identity = fstatSync(own.fd);
		if (
			current.dev === identity.dev &&
			current.ino === identity.ino &&
			current.birthtimeMs === identity.birthtimeMs
		)
			unlinkSync(temp);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			throw error;
	}
	pendingArchiveTemps.delete(key);
	closeSync(own.fd);
}

class DamagedCopyConflictError extends Error {
	override readonly name = "DamagedCopyConflictError";
	constructor() {
		super("published damaged copy differs from the record");
	}
}

function publishedCopyMatches(target: string, bytes: Uint8Array): boolean {
	let fd: number;
	try {
		fd = openSync(
			target,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return false;
		throw error;
	}
	try {
		if (!readStoredStateDescriptor(fd, bytes.length).equals(Buffer.from(bytes)))
			throw new DamagedCopyConflictError();
		return true;
	} finally {
		closeSync(fd);
	}
}

/** Immutable digest evidence is checked and reacknowledged before any allocation. */
export function preserveDamagedRecord(path: string, bytes: Uint8Array): string {
	const key = resolve(path);
	const digest = createHash("sha256").update(bytes).digest("hex");
	const copy = `${path}.damaged-${digest}`;
	const parent = openStoredStateDirectory(dirname(key));
	const target = `/proc/self/fd/${parent}/${basename(copy)}`;
	try {
		if (publishedCopyMatches(target, bytes)) {
			fsyncSync(parent);
			cleanupArchiveTemp(key, parent);
			return copy;
		}
		cleanupArchiveTemp(key, parent);
		const name = `.${basename(copy)}.${randomUUID()}.${process.pid}.tmp`;
		const temp = join(`/proc/self/fd/${parent}`, name);
		const fd = openSync(temp, "wx", 0o600);
		pendingArchiveTemps.set(key, { name, fd });
		try {
			let written = 0;
			while (written < bytes.length) {
				const count = writeSync(fd, bytes, written, bytes.length - written);
				if (count === 0)
					throw Object.assign(new Error("short archive write"), {
						code: "EIO",
					});
				written += count;
			}
			fsyncSync(fd);
			try {
				linkSync(temp, target);
			} catch (error) {
				if (
					!(
						error instanceof Error &&
						"code" in error &&
						error.code === "EEXIST"
					)
				)
					throw error;
				if (!publishedCopyMatches(target, bytes)) throw error;
			}
			fsyncSync(parent);
			return copy;
		} finally {
			cleanupArchiveTemp(key, parent);
		}
	} finally {
		closeSync(parent);
	}
}
