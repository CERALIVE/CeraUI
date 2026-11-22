/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { logger } from "../../helpers/logger.ts";

const RUN_DIR = "/run/ceralive";
export const SOFTWARE_UPDATE_OUTPUT_READ_BYTES = 64 * 1024;

export type SoftwareUpdateOutputPaths = {
	readonly stdout: string;
	readonly stderr: string;
};

const ATTEMPT_FILE = "software-update.attempt";
const ATTEMPT_MAX_BYTES = 1024;
const exitCodeSchema = z.number().int().min(0).max(255);
const invocationSchema = z.string().regex(/^[0-9a-f]{32}$/);
const attemptSchema = z
	.object({
		schema: z.literal(2),
		attempt: z
			.string()
			.regex(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			),
		phase: z.enum(["accepted", "launched"]),
		uptimeMs: z.number().int().nonnegative(),
		invocation: invocationSchema.optional(),
		exitCode: exitCodeSchema.optional(),
		/** With the exit: whether the unit's transcript was read to its end. */
		drained: z.boolean().optional(),
		/** With the exit: the stdout file it was read from (inode:size:mtime). */
		transcript: z.string().max(64).optional(),
		leftover: z
			.object({ invocation: invocationSchema, exitCode: exitCodeSchema })
			.strict()
			.optional(),
	})
	.strict();

/**
 * The one durable record of the current update attempt; replay and
 * adjudication read only this. `accepted`: admitted, no unit started yet.
 * `launched`: its unit was about to start; `exitCode` (with the unit's
 * `invocation` and the `transcript` it was read from) once an observer saw it exit. `leftover`: an older attempt's
 * recorded exit, kept only so a launch may retire that finished unit.
 */
export type SoftwareUpdateAttempt = z.infer<typeof attemptSchema>;

export type SoftwareUpdateOutputRead = {
	readonly bytes: Uint8Array;
	readonly nextOffset: number;
};

export class UnsafeSoftwareUpdateOutputPathError extends Error {
	constructor(
		readonly outputPath: string,
		reason: string,
	) {
		super(`unsafe software-update output path: ${reason}`);
		this.name = "UnsafeSoftwareUpdateOutputPathError";
	}
}

export function softwareUpdateOutputPaths(): SoftwareUpdateOutputPaths {
	return {
		stdout: path.join(RUN_DIR, "software-update.stdout"),
		stderr: path.join(RUN_DIR, "software-update.stderr"),
	};
}

function secureOutputDirectory(directory: string, expectedUid: number): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new UnsafeSoftwareUpdateOutputPathError(directory, "not a directory");
	}
	if (stat.uid !== expectedUid) {
		throw new UnsafeSoftwareUpdateOutputPathError(directory, "wrong owner");
	}
	if ((stat.mode & 0o022) !== 0) {
		throw new UnsafeSoftwareUpdateOutputPathError(
			directory,
			"writable by peers",
		);
	}
	chmodSync(directory, 0o700);
}

function writeAll(fd: number, bytes: Uint8Array): void {
	for (let at = 0; at < bytes.byteLength; ) at += writeSync(fd, bytes, at);
}

function createOutputFile(
	filePath: string,
	expectedUid: number,
	text?: string,
): void {
	rmSync(filePath, { force: true });
	const fd = openSync(
		filePath,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_NOFOLLOW,
		0o600,
	);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.uid !== expectedUid || stat.nlink !== 1) {
			throw new UnsafeSoftwareUpdateOutputPathError(
				filePath,
				"not a private regular file",
			);
		}
		fchmodSync(fd, 0o600);
		if (text !== undefined) writeAll(fd, Buffer.from(text));
	} finally {
		closeSync(fd);
	}
}

export async function prepareSoftwareUpdateOutput(
	paths: SoftwareUpdateOutputPaths,
	expectedUid = 0,
): Promise<void> {
	const directory = path.dirname(paths.stdout);
	if (path.dirname(paths.stderr) !== directory) {
		throw new UnsafeSoftwareUpdateOutputPathError(
			paths.stdout,
			"output files do not share a directory",
		);
	}
	secureOutputDirectory(directory, expectedUid);
	createOutputFile(paths.stdout, expectedUid);
	createOutputFile(paths.stderr, expectedUid);
}

export function softwareUpdateAttemptPath(
	paths: SoftwareUpdateOutputPaths,
): string {
	return path.join(path.dirname(paths.stdout), ATTEMPT_FILE);
}

/** Synchronous, so an admission is recorded before anything is published. */
export function writeSoftwareUpdateAttempt(
	paths: SoftwareUpdateOutputPaths,
	record: SoftwareUpdateAttempt,
	expectedUid = 0,
): void {
	const text = JSON.stringify(attemptSchema.parse(record));
	secureOutputDirectory(path.dirname(paths.stdout), expectedUid);
	const target = softwareUpdateAttemptPath(paths);
	const pending = `${target}.part`;
	createOutputFile(pending, expectedUid, text);
	renameSync(pending, target);
}

/** null: no attempt is recorded. A record that is unsafe or malformed throws. */
export function readSoftwareUpdateAttempt(
	paths: SoftwareUpdateOutputPaths,
	expectedUid = 0,
): SoftwareUpdateAttempt | null {
	const file = softwareUpdateAttemptPath(paths);
	let fd: number;
	try {
		fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	try {
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			stat.uid !== expectedUid ||
			stat.nlink !== 1 ||
			(stat.mode & 0o777) !== 0o600 ||
			stat.size > ATTEMPT_MAX_BYTES
		) {
			throw new UnsafeSoftwareUpdateOutputPathError(
				file,
				"not a private root-owned record",
			);
		}
		const bytes = Buffer.alloc(stat.size);
		const read = readSync(fd, bytes, 0, stat.size, 0);
		const parsed = attemptSchema.safeParse(
			JSON.parse(bytes.subarray(0, read).toString("utf8")),
		);
		if (!parsed.success)
			throw new UnsafeSoftwareUpdateOutputPathError(file, "malformed record");
		return parsed.data;
	} finally {
		closeSync(fd);
	}
}

/**
 * Compare-and-set in one synchronous step: `change` sees the record it
 * replaces, and no other writer in this process can run between that read
 * and the rename. A record that cannot be read gives no authority: the write
 * fails, unless the caller replaces whatever is there (`replaceUnreadable`).
 */
export function updateSoftwareUpdateAttempt(
	paths: SoftwareUpdateOutputPaths,
	change: (
		current: SoftwareUpdateAttempt | null,
	) => SoftwareUpdateAttempt | null,
	expectedUid = 0,
	{ replaceUnreadable = false }: { readonly replaceUnreadable?: boolean } = {},
): SoftwareUpdateAttempt | null {
	let current: SoftwareUpdateAttempt | null = null;
	try {
		current = readSoftwareUpdateAttempt(paths, expectedUid);
	} catch (error) {
		if (!replaceUnreadable) throw error;
		logger.warn("Software update: replacing an unreadable attempt record", {
			error,
		});
	}
	const next = change(current);
	if (next) writeSoftwareUpdateAttempt(paths, next, expectedUid);
	return next;
}

export async function readSoftwareUpdateOutput(
	filePath: string,
	offset: number,
): Promise<SoftwareUpdateOutputRead> {
	const paths = softwareUpdateOutputPaths();
	if (filePath !== paths.stdout && filePath !== paths.stderr) {
		throw new UnsafeSoftwareUpdateOutputPathError(
			filePath,
			"runtime paths are fixed",
		);
	}
	const handle = await fs.open(
		filePath,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = await handle.stat();
		if (
			!stat.isFile() ||
			stat.uid !== 0 ||
			stat.nlink !== 1 ||
			(stat.mode & 0o777) !== 0o600
		) {
			throw new UnsafeSoftwareUpdateOutputPathError(
				filePath,
				"not a private root-owned regular file",
			);
		}
		// Shorter than what was read: replaced, so no read here is complete.
		if (stat.size < offset)
			throw new UnsafeSoftwareUpdateOutputPathError(filePath, "file shrank");
		if (stat.size === offset)
			return { bytes: new Uint8Array(), nextOffset: offset };

		const length = Math.min(
			stat.size - offset,
			SOFTWARE_UPDATE_OUTPUT_READ_BYTES,
		);
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, offset);
		return {
			bytes: Uint8Array.from(buffer.subarray(0, bytesRead)),
			nextOffset: offset + bytesRead,
		};
	} finally {
		await handle.close();
	}
}
