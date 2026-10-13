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

import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fsyncSync,
	linkSync,
	openSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
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

/**
 * Durably copy damaged bytes beside their record and return the copy's path.
 * `link()` publishes the fully written copy under a name that must not exist,
 * so an earlier copy is never replaced. The digest name reuses a published copy
 * after a failed directory acknowledgement. Throws when the copy cannot be made;
 * the caller must then leave the record unwritten.
 */
export function preserveDamagedRecord(path: string, bytes: Uint8Array): string {
	const directory = dirname(path);
	const digest = createHash("sha256").update(bytes).digest("hex");
	const copy = `${path}.damaged-${digest}`;
	const parent = openStoredStateDirectory(directory);
	const target = `/proc/self/fd/${parent}/${basename(copy)}`;
	const temp = join(
		`/proc/self/fd/${parent}`,
		`.${basename(copy)}.${process.pid}.tmp`,
	);
	let created = false;
	try {
		const fd = openSync(temp, "wx", 0o600);
		created = true;
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
		} finally {
			closeSync(fd);
		}
		try {
			linkSync(temp, target);
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "EEXIST")
			)
				throw error;
			const existing = openSync(
				target,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			try {
				if (
					!readStoredStateDescriptor(existing, bytes.length).equals(
						Buffer.from(bytes),
					)
				)
					throw error;
			} finally {
				closeSync(existing);
			}
		}
		fsyncSync(parent);
		return copy;
	} finally {
		try {
			if (created) unlinkSync(temp);
		} finally {
			closeSync(parent);
		}
	}
}
