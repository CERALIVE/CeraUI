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

import { writeFileAtomicSync } from "./config-loader.ts";

export async function readTextFile(file: string) {
	return await Bun.file(file)
		.text()
		.catch(() => undefined);
}

export async function writeTextFile(file: string, contents: string) {
	try {
		await Bun.write(file, contents);
		return true;
	} catch (_) {
		return false;
	}
}

/**
 * Crash-safe variant of {@link writeTextFile} for durable named caches
 * (auth_tokens / relays_cache / dns_cache / gsm_operator_cache). Delegates to the
 * single canonical `writeFileAtomicSync` (sibling `.<basename>.<pid>.tmp` + fsync
 * + rename) and swallows write errors like `writeTextFile` does. Deliberately not
 * folded into `writeTextFile`: the ephemeral tmpfs writers (bcrpt/srtla IP + key
 * files) must stay non-atomic and emit no `.tmp` sidecars.
 */
export function writeTextFileAtomic(file: string, contents: string): boolean {
	try {
		writeFileAtomicSync(file, contents);
		return true;
	} catch (_) {
		return false;
	}
}
