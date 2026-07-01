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

import fs from "node:fs";
import path from "node:path";

import { logger } from "./logger.ts";

/**
 * Atomic-write temp-file pattern: .<basename>.<pid>.tmp
 * Matches files left behind by writeFileAtomicSync() after a crash.
 * Example: .config.json.12345.tmp
 * Pattern: dot + (non-dot, non-slash char) + (any non-slash chars) + dot + (digits) + .tmp
 */
const ATOMIC_TEMP_PATTERN = /^\.[^./][^/]*\.\d+\.tmp$/;

/**
 * Scan the config working directory for orphaned atomic-write temp files
 * (from a prior crash) and unlink them. Fail-soft: logs errors but never throws.
 *
 * @param configDir - Directory to scan (typically the same dir as config.json)
 */
export function cleanupOrphanedTempFiles(configDir: string): void {
	try {
		const entries = fs.readdirSync(configDir);

		for (const entry of entries) {
			if (ATOMIC_TEMP_PATTERN.test(entry)) {
				const filePath = path.join(configDir, entry);
				try {
					fs.unlinkSync(filePath);
					logger.debug(`Cleaned up orphaned temp file: ${entry}`);
				} catch (err) {
					// Log but don't throw — permission errors or race conditions
					// (another process deleting the file) must not block boot.
					logger.warn(
						`Failed to unlink orphaned temp file ${entry}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}
	} catch (err) {
		// readdirSync failure (e.g., dir doesn't exist, permission denied)
		// is also fail-soft — log and continue.
		logger.warn(
			`Failed to scan config directory for orphaned temp files: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
