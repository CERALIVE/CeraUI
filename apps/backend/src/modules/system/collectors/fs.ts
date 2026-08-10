/*
    CeraUI - web UI for the CERALIVE project
    Copyright (C) 2024-2026 CeraLive project


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
 * The ONE filesystem seam every device-stats collector reads through.
 *
 * WHAT IT IS
 *
 *   Two functions — `readText` and `readDir` — and nothing else. Collectors ask
 *   for the ABSOLUTE KERNEL path they would use on a real board
 *   (`/proc/meminfo`, `/sys/devices/system/cpu/cpufreq`), and the seam resolves
 *   it under a configured ROOT whose production value is `/`, i.e. the identity
 *   mapping. `createCollectorFs()` with no argument is byte-for-byte the
 *   behaviour the collectors had before the root existed.
 *
 * WHY A ROOT AT ALL
 *
 *   So a test can point the whole collector at a fixture TREE instead of
 *   stubbing each read. A stubbed `readText` proves the parser; a fixture root
 *   proves the parser AND the paths AND the directory enumeration AND the ENOENT
 *   behaviour of the real filesystem — which is where sysfs collectors actually
 *   break. `createCollectorFs(fixtureDir)` is the only sanctioned way to do it.
 *
 * WHY IT IS THIS NARROW
 *
 *   It is deliberately NOT a filesystem abstraction: no write, no stat, no glob,
 *   no streaming. Everything under /proc and /sys that these collectors want is
 *   either a small text node or a directory listing, so two functions cover it,
 *   and a surface that small cannot grow into an ambient file API that some
 *   later module uses to write config.
 *
 *   The root is a BUILD-TIME/TEST-TIME fact, never operator-controlled: nothing
 *   routes an RPC argument, a config value, or a query parameter into
 *   `createCollectorFs`. Paths are compile-time constants in the collectors, and
 *   the resolver still refuses relative paths and `..` segments so a future
 *   caller cannot climb out of the root it was given.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * The injected I/O surface shared by every device-stats collector. Paths are
 * absolute kernel paths; the implementation decides what they resolve against.
 */
export type CollectorFs = {
	/** Read a file as text. Rejects (ENOENT) when the node is not there. */
	readText: (path: string) => Promise<string>;
	/** List a directory's entry names. Rejects (ENOENT) when it is not there. */
	readDir: (path: string) => Promise<string[]>;
};

/** Production root — the identity mapping. */
export const COLLECTOR_FS_DEFAULT_ROOT = "/";

/**
 * Resolve an absolute kernel path under `root`.
 *
 * Refuses anything that is not absolute, and anything carrying a `..` segment,
 * so the mapping can only ever land inside the root it was handed.
 */
export function resolveUnderRoot(root: string, path: string): string {
	if (!path.startsWith("/")) {
		throw new Error(`collector fs: path must be absolute, got "${path}"`);
	}
	if (path.split("/").includes("..")) {
		throw new Error(`collector fs: path must not traverse upward: "${path}"`);
	}
	return root === COLLECTOR_FS_DEFAULT_ROOT ? path : join(root, path);
}

/**
 * Build the collector filesystem seam. With the default root this is a plain
 * `Bun.file().text()` / `readdir` pair against the real /proc and /sys.
 *
 * Directory listing stays on `node:fs/promises` — `Bun.file()` is file-only
 * (same reasoning as `fan.ts`'s `defaultFanDeps`).
 */
export function createCollectorFs(
	root: string = COLLECTOR_FS_DEFAULT_ROOT,
): CollectorFs {
	return {
		readText: (path) => Bun.file(resolveUnderRoot(root, path)).text(),
		readDir: (path) => readdir(resolveUnderRoot(root, path)),
	};
}
