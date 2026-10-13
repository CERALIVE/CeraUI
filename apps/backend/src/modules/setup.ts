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

import {
	SETUP_CONFIG_DEFAULTS,
	type SetupConfig,
	setupConfigSchema,
} from "../helpers/config-schemas.ts";
import { logger } from "../helpers/logger.ts";
import {
	readStoredStateJson,
	STORED_STATE_LIMITS,
	StoredStateReadError,
} from "./system/update-orchestrator/stored-state-file.ts";

const SETUP_FILE = "setup.json";

// setup.json is image-baked, read-only required metadata: it is never guessed
// and never defaulted. A transient leaf fault gets a bounded in-process retry
// (about 3 s); after that the typed error escapes and systemd's Restart=always
// is the outer retry owner. Parsed-and-refused bytes are not retried.
const SETUP_RETRY_WAITS_MS = [250, 500, 1000, 1250] as const;
const TRANSIENT_CODES = new Set(["EIO", "EAGAIN"]);

function transient(error: unknown): boolean {
	if (!(error instanceof StoredStateReadError)) return false;
	if (error.reason === "changed") return true;
	const cause = error.cause;
	return (
		error.reason === "read_failed" &&
		cause instanceof Error &&
		"code" in cause &&
		TRANSIENT_CODES.has(String(cause.code))
	);
}

async function readSetupJson(): Promise<unknown> {
	for (const wait of SETUP_RETRY_WAITS_MS) {
		try {
			return await readStoredStateJson(
				SETUP_FILE,
				STORED_STATE_LIMITS.settings,
			);
		} catch (error) {
			if (!transient(error)) throw error;
			logger.warn("Setup: transient setup.json read fault; retrying", {
				error,
			});
			await Bun.sleep(wait);
		}
	}
	return readStoredStateJson(SETUP_FILE, STORED_STATE_LIMITS.settings);
}

/* Read the config and setup files */
export const setup: SetupConfig = {
	...SETUP_CONFIG_DEFAULTS,
	...setupConfigSchema.parse(await readSetupJson()),
};
logger.debug("Setup", setup);
