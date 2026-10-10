import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { OS_UPDATE_STATE_DIR } from "./os-manifest.ts";
import { OsStageError } from "./os-stage-error.ts";

const decimal = z.string().regex(/^(?:0|[1-9][0-9]*)$/);
export const receiptFileIdentitySchema = z
	.object({
		dev: decimal,
		ino: decimal,
		size: decimal,
		mtimeNs: decimal,
		birthtimeNs: decimal,
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict()
	.readonly();
export type ReceiptFileIdentity = z.infer<typeof receiptFileIdentitySchema>;
export type ReceiptFileEvidence = {
	readonly identity: ReceiptFileIdentity;
	readonly bytes: Buffer;
};

export function receiptFileAbsent(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function openReceiptDirectory(dir: string): number {
	const flags =
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
	const uid = process.getuid?.() ?? 0;
	let fd = openSync("/", flags);
	try {
		for (const component of resolve(dir).split("/").filter(Boolean)) {
			const child = openSync(`/proc/self/fd/${fd}/${component}`, flags);
			try {
				const info = fstatSync(child);
				const stickyRoot = info.uid === 0 && (info.mode & 0o1000) !== 0;
				if (
					(info.uid !== 0 && info.uid !== uid) ||
					((info.mode & 0o022) !== 0 && !stickyRoot)
				)
					throw new OsStageError("rauc_recovery_unproven");
			} catch (error) {
				closeSync(child);
				throw error;
			}
			closeSync(fd);
			fd = child;
		}
		const info = fstatSync(fd);
		if (info.uid !== uid || (info.mode & 0o022) !== 0)
			throw new OsStageError("rauc_recovery_unproven");
		return fd;
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

export function receiptEntryPath(
	parent: number,
	name: "os-staged.json" | "os-staged.consumed.json",
): string {
	return `/proc/self/fd/${parent}/${name}`;
}

export function readReceiptEntry(
	parent: number,
	name: "os-staged.json" | "os-staged.consumed.json" = "os-staged.json",
): ReceiptFileEvidence | null {
	const path = receiptEntryPath(parent, name);
	let fd: number;
	try {
		fd = openSync(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (error) {
		if (receiptFileAbsent(error)) return null;
		throw error;
	}
	try {
		const info = fstatSync(fd, { bigint: true });
		if (
			!info.isFile() ||
			info.nlink !== 1n ||
			info.uid !== BigInt(process.getuid?.() ?? 0) ||
			(info.mode & 0o022n) !== 0n ||
			info.size > 16_384n
		)
			throw new OsStageError("rauc_recovery_unproven");
		const bytes = readFileSync(fd);
		const after = fstatSync(fd, { bigint: true });
		const entry = lstatSync(path, { bigint: true });
		if (
			info.size !== BigInt(bytes.length) ||
			info.mtimeNs !== after.mtimeNs ||
			info.size !== after.size ||
			info.dev !== entry.dev ||
			info.ino !== entry.ino
		)
			throw new OsStageError("rauc_recovery_unproven");
		return {
			bytes,
			identity: {
				dev: info.dev.toString(),
				ino: info.ino.toString(),
				size: info.size.toString(),
				mtimeNs: info.mtimeNs.toString(),
				birthtimeNs: info.birthtimeNs.toString(),
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
		};
	} finally {
		closeSync(fd);
	}
}

export function readReceiptFile(
	dir = OS_UPDATE_STATE_DIR,
): ReceiptFileEvidence | null {
	let parent: number;
	try {
		parent = openReceiptDirectory(dir);
	} catch (error) {
		if (receiptFileAbsent(error)) return null;
		throw error;
	}
	try {
		return readReceiptEntry(parent);
	} finally {
		closeSync(parent);
	}
}

export function sameReceiptFile(
	expected: ReceiptFileIdentity | null | undefined,
	current: ReceiptFileIdentity | null | undefined,
): boolean {
	return (
		expected !== undefined &&
		current !== undefined &&
		isDeepStrictEqual(expected, current)
	);
}
