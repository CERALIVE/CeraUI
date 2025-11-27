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
import { writeFile } from "node:fs/promises";
import util from "node:util";

export async function readTextFile(file: string) {
	const readFile = util.promisify(fs.readFile);
	const contents = await readFile(file).catch(() => undefined);
	if (contents === undefined) return;
	return contents.toString("utf8");
}

export async function writeTextFile(file: string, contents: string) {
	try {
		await writeFile(file, contents);
		return true;
	} catch (_) {
		return false;
	}
}
