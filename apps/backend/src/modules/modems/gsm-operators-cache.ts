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

import { loadCacheFile } from "../../helpers/config-loader.ts";
import {
	type GsmOperatorCache,
	gsmOperatorCacheSchema,
} from "../../helpers/config-schemas.ts";
import { writeTextFile } from "../../helpers/text-files.ts";

const GSM_OPERATORS_CACHE_FILE = "gsm_operator_cache.json";

type OperatorId = string;
type OperatorName = string;

const gsmOperatorsCache: GsmOperatorCache = loadCacheFile(
	GSM_OPERATORS_CACHE_FILE,
	gsmOperatorCacheSchema,
);

async function writeGsmOperatorsCache() {
	await writeTextFile(
		GSM_OPERATORS_CACHE_FILE,
		JSON.stringify(gsmOperatorsCache),
	);
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
