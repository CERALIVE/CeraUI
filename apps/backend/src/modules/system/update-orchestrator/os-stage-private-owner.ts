import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { OsStageError } from "./os-stage-error.ts";
import {
	type OsStageJobRecord,
	osStageJobSchema,
	readOsJobFile,
	readOsStageJob,
} from "./os-stage-job-files.ts";

/** Device/inode of the private directory; owner and mode are fixed expectations. */
export type OsStagePrivateIdentity = {
	readonly dev: number;
	readonly ino: number;
};

export async function readOsStagePrivateOwner(input: {
	readonly directory: string;
	readonly uid: number;
	readonly record: OsStageJobRecord;
	readonly identity?: OsStagePrivateIdentity;
}) {
	const before = input.identity ?? (await lstat(input.directory));
	const assertOwner = async (expected = input.record) => {
		const dir = await lstat(input.directory);
		if (
			!dir.isDirectory() ||
			dir.isSymbolicLink() ||
			dir.uid !== input.uid ||
			(dir.mode & 0o777) !== 0o700 ||
			dir.dev !== before.dev ||
			dir.ino !== before.ino ||
			JSON.stringify(await readOsStageJob(input.directory, input.uid)) !==
				JSON.stringify(osStageJobSchema.parse(expected))
		)
			throw new OsStageError("rauc_recovery_unproven");
		for (const name of await readdir(input.directory)) {
			if (
				!["token", "job.json", "ready", "release"].includes(name) &&
				!/^\.(?:token|job\.json|release)\.[a-f0-9-]{36}$/.test(name)
			)
				throw new OsStageError("rauc_recovery_unproven");
			const file = await lstat(join(input.directory, name));
			if (
				!file.isFile() ||
				file.isSymbolicLink() ||
				file.uid !== input.uid ||
				file.nlink !== 1 ||
				(file.mode & 0o777) !== 0o600 ||
				file.size > 262144
			)
				throw new OsStageError("rauc_recovery_unproven");
		}
	};
	const tokens = async () => {
		// The helper's `printf > ready` can be observed empty mid-write: not yet published.
		const ready =
			(await readOsJobFile("ready", input.directory, input.uid)) || null;
		const release = await readOsJobFile("release", input.directory, input.uid);
		if (
			[ready, release].some(
				(token) => token !== null && token !== `${input.record.attemptId}\n`,
			)
		)
			throw new OsStageError("rauc_recovery_unproven");
		return { ready, release };
	};
	await assertOwner();
	await tokens();
	const identity: OsStagePrivateIdentity = { dev: before.dev, ino: before.ino };
	return { assertOwner, tokens, identity };
}
