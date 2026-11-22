/*
 * A cheap token for "the local APT state is still the one a read observed".
 * It hashes the identity of every file APT and dpkg decide a plan from (dpkg's
 * status and pending journal, the package lists, auto-install marks, sources,
 * pins and configuration). dpkg, apt-mark and apt-get update replace these files
 * by rename, so any change gives a new inode, size or timestamp. A read that saw
 * the same token before and after it observed one state.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { logger } from "../../helpers/logger.ts";

export type AptStatePaths = {
	readonly files: readonly string[];
	// Each directory's own entry and every entry directly inside it.
	readonly dirs: readonly string[];
};

const APT_STATE_PATHS: AptStatePaths = {
	files: [
		"/var/lib/dpkg/status",
		"/var/lib/apt/extended_states",
		"/etc/apt/sources.list",
		"/etc/apt/preferences",
	],
	dirs: [
		"/var/lib/dpkg/updates",
		"/var/lib/apt/lists",
		"/var/lib/apt/lists/partial",
		"/etc/apt/sources.list.d",
		"/etc/apt/preferences.d",
		"/etc/apt/apt.conf.d",
	],
};

function absent(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

function stamp(path: string): string {
	try {
		const s = statSync(path, { bigint: true });
		return `${path}\t${s.ino}\t${s.size}\t${s.mtimeNs}\t${s.ctimeNs}`;
	} catch (error) {
		if (absent(error)) return `${path}\tabsent`;
		throw error;
	}
}

function entries(dir: string): string[] {
	try {
		return readdirSync(dir).sort();
	} catch (error) {
		if (absent(error)) return [];
		throw error;
	}
}

/** The current APT state token, or undefined when it cannot be read (never a match). */
export function aptStateGeneration(
	paths: AptStatePaths = APT_STATE_PATHS,
): string | undefined {
	try {
		const stamps = paths.files.map(stamp);
		for (const dir of paths.dirs) {
			stamps.push(stamp(dir));
			for (const name of entries(dir)) stamps.push(stamp(join(dir, name)));
		}
		return new Bun.CryptoHasher("sha256")
			.update(stamps.join("\n"))
			.digest("hex");
	} catch (error) {
		logger.warn("APT state generation unreadable", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}
