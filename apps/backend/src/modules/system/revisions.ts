/*
    CeraUI - web UI for the CERALIVE project
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

/* Read the revision numbers */
import { execSync } from "node:child_process";
import fs from "node:fs";

import { logger } from "../../helpers/logger.ts";

import { belacoderExec, srtlaSendExec } from "../streaming/streamloop.ts";

const revisions: Record<string, string> = {};

function readRevision(cmd: string) {
	try {
		return execSync(cmd).toString().trim();
	} catch (_err) {
		return "unknown revision";
	}
}

export function initRevisions() {
	try {
		revisions.ceralive = fs.readFileSync("revision", "utf8");
	} catch (_err) {
		revisions.ceralive = readRevision("git rev-parse --short HEAD");
	}

	revisions.belacoder = readRevision(`${belacoderExec} -v`);
	revisions.srtla = readRevision(`${srtlaSendExec} -v`);
	revisions.bun = Bun.version;

	// Only show a CERALIVE image version if it exists
	try {
		revisions["CERALIVE image"] = fs
			.readFileSync("/etc/ceralive_img_version", "utf8")
			.trim();
	} catch (_err) {
		// Silently ignore if CERALIVE image version file doesn't exist
	}
	logger.debug("Revisions", revisions);
}

export function getRevisions() {
	return revisions;
}
