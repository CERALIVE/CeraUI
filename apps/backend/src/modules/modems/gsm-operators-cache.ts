/*
    belaUI - web UI for the BELABOX project
    Copyright (C) 2020-2022 BELABOX project

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

import { logger } from "../../helpers/logger.ts";
import { writeTextFile } from "../../helpers/text-files.ts";

const GSM_OPERATORS_CACHE_FILE = "gsm_operator_cache.json";

type OperatorId = string;
type OperatorName = string;

let gsmOperatorsCache: Record<OperatorId, OperatorName> = {};
try {
	gsmOperatorsCache = JSON.parse(fs.readFileSync(GSM_OPERATORS_CACHE_FILE, "utf8"));
} catch (err) {
	logger.warn("Failed to load the persistent GSM operators cache, starting with an empty cache");

	writeGsmOperatorsCache().catch(() => {
		logger.warn("Failed to write the persistent GSM operators cache, the cache will not be saved");
		logger.debug(err);
	});
}

async function writeGsmOperatorsCache() {
	await writeTextFile(GSM_OPERATORS_CACHE_FILE, JSON.stringify(gsmOperatorsCache));
}

export async function setGsmOperatorName(id: OperatorId, name: OperatorName) {
	const cachedOperator = gsmOperatorsCache[id];

	if (!cachedOperator || cachedOperator !== name) {
		gsmOperatorsCache[id] = name;
		await writeGsmOperatorsCache();
	}
}

export function getGsmOperatorName(id: OperatorId): OperatorName | undefined {
	return gsmOperatorsCache[id];
}
