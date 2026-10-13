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

import { randomBytes } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	linkSync,
	openSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { readStoredStateBytes } from "../modules/system/update-orchestrator/stored-state-file.ts";
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

function utcStamp(at: Date): string {
	return at
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "Z");
}

function fsyncDirectory(directory: string): void {
	const fd = openSync(directory, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/**
 * Durably copy damaged bytes beside their record and return the copy's path.
 * `link()` publishes the fully written copy under a name that must not exist,
 * so an earlier copy is never replaced. Throws when the copy cannot be made;
 * the caller must then leave the record unwritten.
 */
export function preserveDamagedRecord(
	path: string,
	bytes: Uint8Array,
	at: Date = new Date(),
): string {
	const directory = dirname(path);
	const copy = `${path}.damaged-${utcStamp(at)}-${randomBytes(4).toString("hex")}`;
	// Boot cleanup recognizes this temp shape, so a crash leaves no residue.
	const temp = join(directory, `.${basename(copy)}.${process.pid}.tmp`);
	const fd = openSync(temp, "wx", 0o600);
	try {
		let written = 0;
		while (written < bytes.length)
			written += writeSync(fd, bytes, written, bytes.length - written);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		linkSync(temp, copy);
	} finally {
		unlinkSync(temp);
	}
	fsyncDirectory(directory);
	return copy;
}
