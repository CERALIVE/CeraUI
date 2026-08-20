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

/*
  THE WRITER SIDE OF ADR-003 — effectful half.

  ADR-003 §5.1 fixes five rules and every one of them is load-bearing:

    1. each file is written to a UNIQUE temp sibling (`<target>.<pid>.<n>.tmp`),
       fsync-ed, then `rename(2)`-d into place — so a reader never sees a torn
       write, and two writers cannot clobber one temp;
    2. `BIND_IPS_FILE` is published FIRST, because the sidecar names the digest
       of the exact bytes that rename committed;
    3. THE SIDECAR RENAME IS THE COMMIT POINT — the mapping does not exist until
       it lands;
    4. `SIGHUP` comes last, after both renames (the caller's job);
    5. at startup BOTH files are republished BEFORE the sender is spawned.

  The window between renames — new IP bytes against an old sidecar — is real,
  named, and absorbed by the reader's bounded retry. The guarantee runs one way
  only: a reader seeing the NEW sidecar is guaranteed the content it names is on
  disk. We do not claim the converse, and we do not pretend the window is absent.

  PERMISSIONS ARE PART OF THE CONTRACT. §5.3 makes the reader REFUSE a sidecar
  that is a symlink, is not a regular file, or is group- or world-writable — the
  mapping decides where device traffic egresses. So the sidecar is created 0600
  and its temp sibling is too, or the very first read answers `unreadable`.
*/

import { createHash } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";

import { logger } from "../../helpers/logger.ts";

import {
	type BondEntry,
	buildBindMapDocument,
	isMappableEntry,
	renderIpsFile,
	sameMapping,
} from "./bind-map.ts";

/** Why a publication could not put a usable mapping on disk. */
export type BindMapPublishFailure =
	| "unmappable"
	| "ips_write_failed"
	| "sidecar_write_failed";

export type BindMapPublication =
	| {
			readonly ok: true;
			readonly generation: number;
			readonly changed: boolean;
			readonly sidecarPath: string;
	  }
	| {
			readonly ok: false;
			readonly reason: BindMapPublishFailure;
			readonly changed: boolean;
	  };

export interface BindMapWriterDeps {
	readonly ipsFile: string;
	readonly sidecarFile: string;
	readonly writeFile: (path: string, contents: string) => Promise<void>;
	readonly renameFile: (from: string, to: string) => Promise<void>;
	readonly removeFile: (path: string) => Promise<void>;
}

const SIDECAR_MODE = 0o600;

/**
 * Write + fsync + close. `Bun.write` is deliberately NOT used here: it does not
 * fsync, and an unsynced rename can leave an empty file behind a power cut on
 * the very device this exists for.
 */
async function writeFileSynced(path: string, contents: string): Promise<void> {
	const handle = await open(path, "w", SIDECAR_MODE);
	try {
		await handle.writeFile(contents);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export function defaultBindMapWriterDeps(
	ipsFile: string,
	sidecarFile: string,
): BindMapWriterDeps {
	return {
		ipsFile,
		sidecarFile,
		writeFile: writeFileSynced,
		renameFile: rename,
		removeFile: (path) => unlink(path),
	};
}

/** Derive the sidecar path from the ips-file path when none is configured. */
export function defaultSidecarPath(ipsFile: string): string {
	return `${ipsFile}.bindmap.json`;
}

/**
 * Writer-session state. `generation` is monotonic per WRITER PROCESS lifetime
 * and restarts at 1, which the reader tolerates by comparing with `!=` rather
 * than `>` — a decrease is indistinguishable from a legitimate restart, so it is
 * never a rejection. It is incremented on EVERY publication, including one whose
 * IP bytes did not change, because that is the only signal a mapping-only change
 * can produce.
 */
let generation = 0;
let tempCounter = 0;
let lastPublished: readonly BondEntry[] | undefined;

/** Drop the writer session (test isolation). Never call from production code. */
export function resetBindMapWriter(): void {
	generation = 0;
	tempCounter = 0;
	lastPublished = undefined;
}

/** The generation the last successful publication carried, or 0 if none. */
export function currentBindMapGeneration(): number {
	return generation;
}

function tempPath(target: string): string {
	tempCounter += 1;
	return `${target}.${process.pid}.${tempCounter}.tmp`;
}

async function publishAtomically(
	deps: BindMapWriterDeps,
	target: string,
	contents: string,
): Promise<void> {
	const temp = tempPath(target);
	await deps.writeFile(temp, contents);
	await deps.renameFile(temp, target);
}

/**
 * Publish the IP list and its sidecar, in that order.
 *
 * `changed` answers "does the sender need a SIGHUP" and is true for a
 * MAPPING-ONLY change as well as an IP-list change — moving a link from one
 * interface to another leaves the IP bytes byte-identical, so a digest-only
 * comparison would silently skip the reload that is the entire point.
 */
export async function publishBondMapping(
	entries: readonly BondEntry[],
	deps: BindMapWriterDeps,
): Promise<BindMapPublication> {
	const changed =
		lastPublished === undefined || !sameMapping(lastPublished, entries);
	const ipsContent = renderIpsFile(entries);

	try {
		await publishAtomically(deps, deps.ipsFile, ipsContent);
	} catch (error) {
		logger.error("bind-map: failed to publish the IP list", { error });
		return { ok: false, reason: "ips_write_failed", changed };
	}

	// The IP list is what the legacy path runs on, so it is published even when
	// the mapping cannot be: an undescribable link still carries traffic, it just
	// cannot be told apart from a same-IP twin.
	if (!entries.every(isMappableEntry)) {
		lastPublished = [...entries];
		await retireSidecar(deps);
		return { ok: false, reason: "unmappable", changed };
	}

	generation += 1;
	const digest = createHash("sha256").update(ipsContent, "utf8").digest("hex");
	const document = buildBindMapDocument(entries, generation, digest);

	try {
		await publishAtomically(deps, deps.sidecarFile, JSON.stringify(document));
	} catch (error) {
		logger.error("bind-map: failed to publish the sidecar", { error });
		lastPublished = [...entries];
		// A sidecar that survives its own failed republication describes bytes that
		// are no longer on disk, which the reader can only report as a hash
		// mismatch. Retiring it makes the state honest: `missing_file`.
		await retireSidecar(deps);
		return { ok: false, reason: "sidecar_write_failed", changed };
	}

	lastPublished = [...entries];
	return {
		ok: true,
		generation,
		changed,
		sidecarPath: deps.sidecarFile,
	};
}

async function retireSidecar(deps: BindMapWriterDeps): Promise<void> {
	try {
		await deps.removeFile(deps.sidecarFile);
	} catch {
		// Absent is the state we wanted; anything else is already logged above.
	}
}
