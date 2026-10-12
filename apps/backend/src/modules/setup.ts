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
} from "./system/update-orchestrator/stored-state-file.ts";

const SETUP_FILE = "setup.json";

/* Read the config and setup files */
export const setup: SetupConfig = {
	...SETUP_CONFIG_DEFAULTS,
	...setupConfigSchema.parse(
		await readStoredStateJson(SETUP_FILE, STORED_STATE_LIMITS.settings),
	),
};
logger.debug("Setup", setup);
