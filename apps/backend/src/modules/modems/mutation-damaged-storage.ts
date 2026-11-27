import { createHash } from "node:crypto";
import {
	type BigIntStats,
	closeSync,
	constants,
	fstatSync,
	openSync,
	readdirSync,
} from "node:fs";
import { modemMutationEntrySchema } from "@ceraui/rpc/schemas";
import { hasPreservedDamagedRecord } from "../../helpers/persistent-record.ts";
import {
	openStoredStateDirectory,
	readStoredStateDescriptor,
	STORED_STATE_LIMITS,
} from "../system/update-orchestrator/stored-state-file.ts";
import {
	decodeAuthorityUtf8,
	parseAuthorityJson,
} from "../system/update-orchestrator/strict-authority-json.ts";

const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const STAGE = /^\.set-aside-([a-f0-9]{64})-([a-f0-9]{64})\.json$/;
const RETAINED = /^\.set-aside-([a-f0-9]{64})-([a-f0-9]{64})\.retained\.json$/;
const STAGED_RECORD = "record";

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function objectId({ dev, ino, birthtimeNs }: BigIntStats): string {
	return `${dev}:${ino}:${birthtimeNs}`;
}

function openedDirectory(fd: number) {
	try {
		return {
			fd,
			anchor: `/proc/self/fd/${fd}`,
			identity: objectId(fstatSync(fd, { bigint: true })),
			[Symbol.dispose]: () => closeSync(fd),
		};
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

function openPrivateStage(path: string): MutationDirectory {
	const fd = openSync(path, READ | constants.O_DIRECTORY);
	try {
		const stats = fstatSync(fd);
		if (stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0)
			throw new MutationDirectoryChangedError("journal staging is not private");
	} catch (error) {
		closeSync(fd);
		throw error;
	}
	return openedDirectory(fd);
}

function openMutationDirectory(path: string): MutationDirectory {
	return openedDirectory(openStoredStateDirectory(path));
}

type MutationDirectory = ReturnType<typeof openedDirectory>;

/** The file stays pinned for the initial check and the move, preventing inode reuse. */
function openDamagedRecord(
	directory: MutationDirectory,
	slot: string,
	path: string,
): OpenDamagedRecord | undefined {
	let fd: number;
	try {
		fd = openSync(path, READ);
	} catch (error) {
		if (hasCode(error, "ENOENT")) return undefined;
		throw error;
	}
	try {
		const bytes = readStoredStateDescriptor(fd, STORED_STATE_LIMITS.agent);
		let valid = false;
		try {
			valid = modemMutationEntrySchema.safeParse(
				parseAuthorityJson(decodeAuthorityUtf8(bytes)),
			).success;
		} catch {
			// A complete byte read rejected by the strict grammar is damage.
		}
		if (valid) {
			closeSync(fd);
			return undefined;
		}
		const stat = fstatSync(fd, { bigint: true });
		const digest = createHash("sha256")
			.update(
				`${directory.identity}:${slot}:${objectId(stat)}:${stat.mtimeNs}:`,
			)
			.update(bytes)
			.digest("hex");
		return { fd, bytes, digest, [Symbol.dispose]: () => closeSync(fd) };
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

interface OpenDamagedRecord extends Disposable {
	readonly fd: number;
	readonly bytes: Buffer;
	readonly digest: string;
}

interface StagedSlot {
	readonly slot: string;
	readonly digest: string;
	readonly name: string;
}

function parseStagedSlot(name: string): StagedSlot | undefined {
	return parseStageName(name, STAGE);
}

function parseStageName(name: string, format: RegExp): StagedSlot | undefined {
	const match = format.exec(name);
	if (match?.[1] === undefined || match[2] === undefined) return undefined;
	return { slot: match[1], digest: match[2], name };
}

class MutationDirectoryChangedError extends Error {
	override readonly name = "MutationDirectoryChangedError";
}

function verifiedRetained(
	dir: MutationDirectory,
	{ slot, digest, name }: StagedSlot,
): boolean {
	using stage = openPrivateStage(`${dir.anchor}/${name}`);
	using record = openDamagedRecord(
		dir,
		slot,
		`${stage.anchor}/${STAGED_RECORD}`,
	);
	return (
		record?.digest === digest &&
		hasPreservedDamagedRecord(`${slot}.json`, record.bytes, dir.fd, record.fd)
	);
}

/** A drifted retained inode is support-only authority, never a replay candidate. */
export function retainedStageIsUnreadable(
	dir: string,
	name: string,
): boolean | undefined {
	const retained = parseStageName(name, RETAINED);
	if (retained === undefined) return undefined;
	try {
		using directory = openMutationDirectory(dir);
		return !verifiedRetained(directory, retained);
	} catch {
		return true;
	}
}

export function retainedMutationEvidenceIsIntact(path: string): boolean {
	let directory: MutationDirectory;
	try {
		directory = openMutationDirectory(path);
	} catch (error) {
		return hasCode(error, "ENOENT");
	}
	using dir = directory;
	try {
		return readdirSync(dir.anchor).every((name) => {
			if (parseStagedSlot(name) !== undefined) return false;
			const record = parseStageName(name, RETAINED);
			return record === undefined || verifiedRetained(dir, record);
		});
	} catch {
		return false;
	}
}
