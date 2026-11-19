import {
	type BigIntStats,
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	unlinkSync,
} from "node:fs";
import { openStoredStateDirectory } from "../system/update-orchestrator/stored-state-file.ts";
import { JournalReadError } from "./reader.ts";

const archiveName =
	/^[a-zA-Z0-9_-]+@(?:[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{16}\.journal|[0-9a-f]{16}-[0-9a-f]{16}\.journal~)$/;

export function journalArchiveScope() {
	const machine = readFileSync("/etc/machine-id", "utf8").trim();
	if (!/^[0-9a-f]{32}$/.test(machine))
		throw new JournalReadError("READ_FAILED");
	return {
		machine,
		directories: [`/run/log/journal/${machine}`, `/var/log/journal/${machine}`],
	};
}

type SnapshotEntry = {
	readonly name: string;
	readonly original: BigIntStats;
};
type Archive = {
	readonly path: string;
	readonly unclean: boolean;
	remove(): void;
};

function sameArchive(before: BigIntStats, after: BigIntStats): boolean {
	return (
		after.isFile() &&
		after.nlink === 1n &&
		before.dev === after.dev &&
		before.ino === after.ino &&
		before.ctimeNs === after.ctimeNs &&
		before.mtimeNs === after.mtimeNs &&
		before.size === after.size
	);
}

function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function withJournalArchiveSnapshot(
	directories: readonly string[],
	visit: (archive: Archive) => Promise<void>,
): Promise<void> {
	const snapshots: {
		readonly fd: number;
		readonly entries: SnapshotEntry[];
	}[] = [];
	try {
		for (const directory of directories) {
			let fd: number;
			try {
				fd = openStoredStateDirectory(directory, true);
			} catch (error) {
				if (missing(error)) continue;
				throw error;
			}
			const entries: SnapshotEntry[] = [];
			snapshots.push({ fd, entries });
			const anchor = `/proc/self/fd/${fd}`;
			for (const name of readdirSync(anchor)) {
				if (!archiveName.test(name)) continue;
				const original = lstatSync(`${anchor}/${name}`, {
					bigint: true,
					throwIfNoEntry: false,
				});
				if (original?.isFile() && original.nlink === 1n)
					entries.push({ name, original });
			}
		}
		for (const { fd, entries } of snapshots) {
			for (const { name, original } of entries) {
				const path = `/proc/self/fd/${fd}/${name}`;
				const current = lstatSync(path, {
					bigint: true,
					throwIfNoEntry: false,
				});
				if (current === undefined || !sameArchive(original, current)) continue;
				let file: number;
				try {
					file = openSync(
						path,
						constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
					);
				} catch (error) {
					if (missing(error)) continue;
					throw error;
				}
				try {
					if (!sameArchive(original, fstatSync(file, { bigint: true })))
						continue;
					await visit({
						path: `/proc/${process.pid}/fd/${file}`,
						unclean: name.endsWith(".journal~"),
						remove() {
							const latest = lstatSync(path, {
								bigint: true,
								throwIfNoEntry: false,
							});
							if (latest === undefined || !sameArchive(original, latest))
								return;
							try {
								unlinkSync(path);
							} catch (error) {
								if (missing(error)) return;
								throw error;
							}
							fsyncSync(fd);
						},
					});
				} finally {
					closeSync(file);
				}
			}
		}
	} finally {
		for (const { fd } of snapshots) closeSync(fd);
	}
}
