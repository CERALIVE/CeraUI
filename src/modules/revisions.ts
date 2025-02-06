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

/* Read the revision numbers */
import { execSync } from "node:child_process";
import fs from "node:fs";

import { logger } from "../helpers/logger.ts";
import { belacoderExec, srtlaSendExec } from "./streamloop.ts";

function getRevision(cmd: string) {
	try {
		return execSync(cmd).toString().trim();
	} catch (err) {
		return "unknown revision";
	}
}

const revisions: Record<string, string> = {};

export function initRevisions() {
	try {
		revisions.belaUI = fs.readFileSync("revision", "utf8");
	} catch (err) {
		revisions.belaUI = getRevision("git rev-parse --short HEAD");
	}
	revisions.belacoder = getRevision(`${belacoderExec} -v`);
	revisions.srtla = getRevision(`${srtlaSendExec} -v`);

	// Only show a BELABOX image version if it exists
	try {
		revisions["BELABOX image"] = fs
			.readFileSync("/etc/belabox_img_version", "utf8")
			.trim();
	} catch (err) {}
	logger.debug(revisions);
}

export function getRevisions() {
	return revisions;
}
