/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * The DURABLE modem-mutation journal.
 *
 * One file per physical device, at the pinned location
 * `/data/ceralive/modem-mutations/<sha256(stable-key)>.json` — `/data` because it
 * is the device-persistent partition that survives an OTA slot swap, hashed
 * because a udev `ID_PATH` is not a safe filename, and one-file-per-device
 * because two devices' mutations are independent and must never contend for one
 * document.
 *
 * THE DURABILITY SEQUENCE IS THE CONTRACT, in this exact order per transition:
 *
 *   write temp file → fsync(temp) → rename() over the journal path → fsync(parent)
 *
 * and a durable deletion is `unlink()` + `fsync(parent)`. `rename` over an
 * existing path is atomic on every filesystem the device ships, so NO injection
 * point can leave a torn or half-written document: a reader either sees the whole
 * previous entry or the whole new one.
 *
 * A failure ANYWHERE in that sequence rejects, and the caller must treat that as
 * "the mutation may not proceed". The parent-directory fsync is deliberately
 * inside the boundary rather than best-effort after it: until the directory entry
 * is durable the rename can be lost by a power cut, and a mutation whose armed
 * record can vanish is exactly the case this journal exists to prevent. That
 * makes the failure mode fail-CLOSED — the on-disk state may already be the new,
 * more-restrictive one while the caller is told the write did not commit.
 *
 * Every filesystem primitive is injected so the fault-injection harness can fail
 * each of the four steps independently against a real temp directory.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	unlink,
} from "node:fs/promises";
import { join } from "node:path";

import {
	MODEM_MUTATION_HISTORY_CAP,
	MODEM_MUTATION_JOURNAL_VERSION,
	type ModemMutationEntry,
	type ModemMutationState,
	modemMutationEntrySchema,
} from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";

/**
 * The PINNED device location. `/data` is the device-persistent partition, so a
 * journal written here survives an OTA slot swap — which is the whole point: a
 * mutation armed before an update must still be recoverable after it.
 */
export const MUTATION_JOURNAL_DIR = "/data/ceralive/modem-mutations";

/**
 * A dev host has no `/data`, and refusing every mutation there would make the
 * whole subsystem unexercisable off-device. The override is read from the
 * environment (the `CERALIVE_RUN_DIR` precedent) and the dev fallback is
 * cwd-relative, exactly like the config files. Production reads neither: a real
 * device sets no override and is not in development mode, so it gets the pin.
 */
function resolveJournalDir(): string {
	const override = process.env.CERALIVE_MODEM_MUTATION_DIR;
	if (override !== undefined && override !== "") return override;
	const development =
		process.env.NODE_ENV === "development" || process.env.MOCK_MODE === "true";
	return development
		? join(process.cwd(), "modem-mutations")
		: MUTATION_JOURNAL_DIR;
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** The four durability primitives, plus the reads. Injected for fault injection. */
export interface MutationJournalFs {
	ensureDir(dir: string): Promise<void>;
	writeTemp(path: string, data: string): Promise<void>;
	fsyncFile(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	fsyncDir(dir: string): Promise<void>;
	readText(path: string): Promise<string | undefined>;
	unlink(path: string): Promise<void>;
	listDir(dir: string): Promise<readonly string[]>;
}

async function fsyncPath(path: string, flags: number): Promise<void> {
	const handle = await open(path, flags);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export const defaultMutationJournalFs: MutationJournalFs = {
	ensureDir: async (dir) => {
		await mkdir(dir, { recursive: true, mode: DIR_MODE });
	},
	writeTemp: async (path, data) => {
		const handle = await open(path, "w", FILE_MODE);
		try {
			await handle.writeFile(data, "utf8");
			// A file created by an earlier run under a different umask keeps its old
			// mode through `open`, so the mode is re-asserted rather than assumed.
			await handle.chmod(FILE_MODE);
		} finally {
			await handle.close();
		}
	},
	fsyncFile: (path) => fsyncPath(path, fsConstants.O_RDONLY),
	rename: async (from, to) => {
		await rename(from, to);
	},
	// A directory fsync needs a read-only descriptor on the directory itself; the
	// entry the rename created is only durable once this returns.
	fsyncDir: (dir) => fsyncPath(dir, fsConstants.O_RDONLY),
	readText: async (path) => {
		try {
			return await readFile(path, "utf8");
		} catch {
			return undefined;
		}
	},
	unlink: async (path) => {
		await unlink(path);
	},
	listDir: async (dir) => {
		try {
			return await readdir(dir);
		} catch {
			return [];
		}
	},
};

export interface MutationJournalDeps {
	readonly fs: MutationJournalFs;
	readonly dir: string;
	now(): number;
}

export const defaultMutationJournalDeps: MutationJournalDeps = {
	fs: defaultMutationJournalFs,
	get dir(): string {
		return resolveJournalDir();
	},
	now: () => Date.now(),
};

let activeDeps: MutationJournalDeps = defaultMutationJournalDeps;

export function setMutationJournalDeps(
	deps: Partial<MutationJournalDeps>,
): void {
	activeDeps = { ...defaultMutationJournalDeps, ...deps };
}

export function resetMutationJournalDeps(): void {
	activeDeps = defaultMutationJournalDeps;
}

export function mutationSlotName(stableKey: string): string {
	return createHash("sha256").update(stableKey, "utf8").digest("hex");
}

function entryPath(deps: MutationJournalDeps, stableKey: string): string {
	return join(deps.dir, `${mutationSlotName(stableKey)}.json`);
}

/**
 * Commit `entry` through the full durability sequence. Rejects on ANY step, and
 * a rejection means the caller must not perform (or continue) the mutation.
 */
export async function commitMutationEntry(
	entry: ModemMutationEntry,
	deps: MutationJournalDeps = activeDeps,
): Promise<void> {
	const target = entryPath(deps, entry.stableKey);
	const temp = `${target}.${process.pid}.tmp`;
	await deps.fs.ensureDir(deps.dir);
	const payload = `${JSON.stringify(modemMutationEntrySchema.parse(entry))}\n`;
	try {
		await deps.fs.writeTemp(temp, payload);
		await deps.fs.fsyncFile(temp);
	} catch (err) {
		await deps.fs.unlink(temp).catch(() => undefined);
		throw err;
	}
	await deps.fs.rename(temp, target);
	await deps.fs.fsyncDir(deps.dir);
}

/** Durable deletion: `unlink()` then `fsync(parent)`. */
export async function removeMutationEntry(
	stableKey: string,
	deps: MutationJournalDeps = activeDeps,
): Promise<void> {
	await deps.fs.unlink(entryPath(deps, stableKey)).catch(() => undefined);
	await deps.fs.fsyncDir(deps.dir);
}

/**
 * Read one entry. An unparseable or wrong-version document answers `undefined`
 * AND is reported, never silently repaired: the caller treats an unreadable
 * mutation record the same way it treats a failed rollback.
 */
export async function readMutationEntry(
	stableKey: string,
	deps: MutationJournalDeps = activeDeps,
): Promise<ModemMutationEntry | undefined> {
	const raw = await deps.fs.readText(entryPath(deps, stableKey));
	if (raw === undefined) return undefined;
	return parseEntry(raw, stableKey);
}

function parseEntry(
	raw: string,
	slotHint: string,
): ModemMutationEntry | undefined {
	try {
		const parsed = modemMutationEntrySchema.safeParse(JSON.parse(raw));
		if (parsed.success) return parsed.data;
		logger.warn("modem mutation journal entry did not validate", {
			module: "modems",
			slot: slotHint,
			version: MODEM_MUTATION_JOURNAL_VERSION,
		});
	} catch {
		logger.warn("modem mutation journal entry is unparseable", {
			module: "modems",
			slot: slotHint,
		});
	}
	return undefined;
}

/** Every readable entry on disk, for startup replay. */
export async function listMutationEntries(
	deps: MutationJournalDeps = activeDeps,
): Promise<readonly ModemMutationEntry[]> {
	const names = await deps.fs.listDir(deps.dir);
	const entries: ModemMutationEntry[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const raw = await deps.fs.readText(join(deps.dir, name));
		if (raw === undefined) continue;
		const entry = parseEntry(raw, name);
		if (entry !== undefined) entries.push(entry);
	}
	return entries;
}

/** Names of journal files that exist but could not be read back as an entry. */
export async function listUnreadableSlots(
	deps: MutationJournalDeps = activeDeps,
): Promise<readonly string[]> {
	const names = await deps.fs.listDir(deps.dir);
	const bad: string[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const raw = await deps.fs.readText(join(deps.dir, name));
		if (raw === undefined || parseEntry(raw, name) === undefined)
			bad.push(name);
	}
	return bad;
}

export function nextEntry(
	entry: ModemMutationEntry,
	state: ModemMutationState,
	at: number,
	detail?: string,
): ModemMutationEntry {
	const history = [
		...entry.history,
		detail === undefined ? { state, at } : { state, at, detail },
	].slice(-MODEM_MUTATION_HISTORY_CAP);
	return {
		...entry,
		state,
		updatedAt: at,
		history,
		...(detail === undefined ? {} : { detail }),
	};
}

export function journalNow(deps: MutationJournalDeps = activeDeps): number {
	return deps.now();
}
