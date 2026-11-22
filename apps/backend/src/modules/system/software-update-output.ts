/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { logger } from "../../helpers/logger.ts";

const RUN_DIR = "/run/ceralive";
export const SOFTWARE_UPDATE_OUTPUT_READ_BYTES = 64 * 1024;

export type SoftwareUpdateOutputPaths = {
	readonly stdout: string;
	readonly stderr: string;
	/** APT::Status-Fd records; only units that declare the channel write it. */
	readonly status: string;
};

/** The exit status an observer saw, kept beside its unit's logs until the next launch. */
export type RecordedSoftwareUpdateOutcome = {
	readonly exitCode: number;
	readonly at: number;
};

const OUTCOME_FILE = "software-update.outcome";
const OUTCOME_MAX_BYTES = 1024;
const recordedOutcomeSchema = z.object({
	schema: z.literal(1),
	exitCode: z.number().int().min(0).max(255),
	at: z.number().int().nonnegative(),
});

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
		status: path.join(RUN_DIR, "software-update.status"),
	};
}

async function secureOutputDirectory(
	directory: string,
	expectedUid: number,
): Promise<void> {
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const stat = await fs.lstat(directory);
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
	await fs.chmod(directory, 0o700);
}

async function createOutputFile(
	filePath: string,
	expectedUid: number,
	content?: string,
): Promise<void> {
	await fs.rm(filePath, { force: true });
	const handle = await fs.open(
		filePath,
		constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_NOFOLLOW,
		0o600,
	);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.uid !== expectedUid || stat.nlink !== 1) {
			throw new UnsafeSoftwareUpdateOutputPathError(
				filePath,
				"not a private regular file",
			);
		}
		await handle.chmod(0o600);
		if (content !== undefined) await handle.write(content);
	} finally {
		await handle.close();
	}
}

export async function prepareSoftwareUpdateOutput(
	paths: SoftwareUpdateOutputPaths,
	expectedUid = 0,
): Promise<{ readonly status: boolean }> {
	const files = [paths.stdout, paths.stderr, paths.status];
	const directories = new Set(files.map((file) => path.dirname(file)));
	if (directories.size !== 1) {
		throw new UnsafeSoftwareUpdateOutputPathError(
			paths.stdout,
			"output files do not share a directory",
		);
	}
	const directory = directories.values().next().value;
	if (directory === undefined) {
		throw new UnsafeSoftwareUpdateOutputPathError(
			paths.stdout,
			"missing directory",
		);
	}
	await secureOutputDirectory(directory, expectedUid);
	// A new unit's outcome is unknown until its own observer records it.
	await fs.rm(softwareUpdateOutcomePath(paths), { force: true });
	await createOutputFile(paths.stdout, expectedUid);
	await createOutputFile(paths.stderr, expectedUid);
	// Progress is display only: a status file that cannot be made never blocks apt.
	try {
		await createOutputFile(paths.status, expectedUid);
		return { status: true };
	} catch (error) {
		logger.warn(
			"Software update status file unavailable; showing phases only",
			{
				error,
			},
		);
		return { status: false };
	}
}

export function softwareUpdateOutcomePath(
	paths: SoftwareUpdateOutputPaths,
): string {
	return path.join(path.dirname(paths.stdout), OUTCOME_FILE);
}

export async function writeSoftwareUpdateOutcome(
	paths: SoftwareUpdateOutputPaths,
	outcome: RecordedSoftwareUpdateOutcome,
	expectedUid = 0,
): Promise<void> {
	const target = softwareUpdateOutcomePath(paths);
	const pending = `${target}.part`;
	await createOutputFile(
		pending,
		expectedUid,
		JSON.stringify({ schema: 1, ...outcome }),
	);
	await fs.rename(pending, target);
}

/** null: no observer recorded this unit's exit. */
export async function readSoftwareUpdateOutcome(
	paths: SoftwareUpdateOutputPaths,
	expectedUid = 0,
): Promise<RecordedSoftwareUpdateOutcome | null> {
	const file = softwareUpdateOutcomePath(paths);
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	try {
		const stat = await handle.stat();
		if (
			!stat.isFile() ||
			stat.uid !== expectedUid ||
			stat.nlink !== 1 ||
			(stat.mode & 0o777) !== 0o600 ||
			stat.size > OUTCOME_MAX_BYTES
		) {
			throw new UnsafeSoftwareUpdateOutputPathError(
				file,
				"not a private root-owned record",
			);
		}
		const parsed = recordedOutcomeSchema.safeParse(
			JSON.parse(await handle.readFile("utf8")),
		);
		if (!parsed.success)
			throw new UnsafeSoftwareUpdateOutputPathError(file, "malformed record");
		return { exitCode: parsed.data.exitCode, at: parsed.data.at };
	} finally {
		await handle.close();
	}
}

export async function readSoftwareUpdateOutput(
	filePath: string,
	offset: number,
): Promise<SoftwareUpdateOutputRead> {
	const paths = softwareUpdateOutputPaths();
	if (
		filePath !== paths.stdout &&
		filePath !== paths.stderr &&
		filePath !== paths.status
	) {
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
		if (stat.size < offset) return { bytes: new Uint8Array(), nextOffset: 0 };
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
