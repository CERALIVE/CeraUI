import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eventRingEpochSchema } from "@ceraui/rpc/schemas";
import {
	contain,
	EPOCH_FILE,
	type EventStoreDeps,
	eventsClearGeneration,
	resolveEventsDir,
	warnEventStore,
} from "./store.ts";

type EpochFs = NonNullable<EventStoreDeps["fs"]>;
type EpochRead =
	| { readonly kind: "valid"; readonly epoch: string }
	| { readonly kind: "missing" | "invalid" | "directory" };
const MAX_EPOCH_BYTES = 64;
const {
	O_RDONLY,
	O_NOFOLLOW,
	O_NONBLOCK,
	O_CREAT,
	O_EXCL,
	O_WRONLY,
	O_DIRECTORY,
} = fs.constants;
const cache = new Map<
	string,
	{ readonly epoch: string; readonly generation: number }
>();
const scanned = new Set<string>();
const warnedDirectories = new Set<string>();

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function readEpoch(io: EpochFs, file: string): EpochRead {
	let fd: number;
	try {
		fd = io.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
	} catch (error) {
		if (hasCode(error, "ENOENT")) return { kind: "missing" };
		if (hasCode(error, "ELOOP")) return { kind: "invalid" };
		throw error;
	}
	try {
		const stat = io.fstatSync(fd);
		if (stat.isDirectory()) return { kind: "directory" };
		if (!stat.isFile() || stat.size > MAX_EPOCH_BYTES)
			return { kind: "invalid" };
		const buffer = Buffer.alloc(MAX_EPOCH_BYTES);
		let bytes = 0;
		while (bytes < MAX_EPOCH_BYTES) {
			const count = io.readSync(fd, buffer, {
				offset: bytes,
				length: MAX_EPOCH_BYTES - bytes,
				position: bytes,
			});
			if (count === 0) break;
			bytes += count;
		}
		const parsed = eventRingEpochSchema.safeParse(
			buffer.toString("utf8", 0, bytes),
		);
		return bytes === stat.size && parsed.success
			? { kind: "valid", epoch: parsed.data }
			: { kind: "invalid" };
	} finally {
		io.closeSync(fd);
	}
}

function removeDeadTemps(io: EpochFs, base: string): void {
	try {
		for (const entry of io.readdirSync(base, { withFileTypes: true })) {
			const pid = Number(
				/^events\.epoch\.([1-9]\d*)\.[\da-f-]{36}\.tmp$/.exec(entry.name)?.[1],
			);
			if (!entry.isFile() || !Number.isInteger(pid) || pid > 0x7fffffff)
				continue;
			try {
				process.kill(pid, 0);
			} catch (error) {
				// EPERM still names a live process; only ESRCH proves it is gone.
				if (hasCode(error, "ESRCH"))
					io.rmSync(path.join(base, entry.name), { force: true });
				else if (!hasCode(error, "EPERM")) throw error;
			}
		}
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
	}
}

function installEpoch(
	io: EpochFs,
	base: string,
	file: string,
	repair: boolean,
): void {
	io.mkdirSync(base, { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	const fd = io.openSync(temp, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600);
	try {
		try {
			io.appendFileSync(fd, randomUUID());
			io.fsyncSync(fd);
		} finally {
			io.closeSync(fd);
		}
		if (repair) {
			io.renameSync(temp, file);
			return;
		}
		try {
			io.linkSync(temp, file);
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
		}
	} finally {
		io.rmSync(temp, { force: true });
	}
}

function syncDirectory(io: EpochFs, base: string): void {
	const fd = io.openSync(base, O_RDONLY | O_DIRECTORY);
	try {
		io.fsyncSync(fd);
	} finally {
		io.closeSync(fd);
	}
}

/**
 * The single, non-template ceralive.service stops its old backend before
 * restarting. Only this synchronous writer and clearEvents touch the epoch
 * path, so they cannot interleave and need no writer lock.
 */
export function eventsEpoch(deps: EventStoreDeps = {}): string | undefined {
	const base = path.resolve(deps.baseDir ?? resolveEventsDir());
	const generation = eventsClearGeneration(base);
	const cached = cache.get(base);
	if (cached?.generation === generation) return cached.epoch;

	return contain(deps, undefined, () => {
		const io = deps.fs ?? fs;
		if (!scanned.has(base)) {
			removeDeadTemps(io, base);
			scanned.add(base);
		}
		const file = path.join(base, EPOCH_FILE);
		const prior = readEpoch(io, file);
		if (prior.kind === "directory") {
			if (!warnedDirectories.has(base)) {
				warnEventStore(deps, "events.epoch is a directory; left untouched");
				warnedDirectories.add(base);
			}
			return undefined;
		}
		const repair = prior.kind === "invalid";
		if (prior.kind !== "valid") installEpoch(io, base, file, repair);
		if (repair) warnEventStore(deps, "replaced invalid events.epoch");
		// On a cache miss this also settles a prior installation whose sync failed.
		syncDirectory(io, base);
		const stored = prior.kind === "valid" ? prior : readEpoch(io, file);
		if (stored.kind !== "valid") return undefined;
		cache.set(base, { epoch: stored.epoch, generation });
		return stored.epoch;
	});
}

export function resetEventsEpochForTest(): void {
	cache.clear();
	scanned.clear();
	warnedDirectories.clear();
}
