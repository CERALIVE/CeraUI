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

/**
 * One field out of a vendor dongle's flat XML document.
 *
 * Huawei's HiLink API emits a non-nested element per field, so an anchored
 * single-tag match is sufficient and avoids pulling an XML parser onto the
 * netif-adjacent poll path. It lives in its own module because BOTH the admin
 * reader and the signal normalizer parse the same documents, and a second copy
 * of the regex is a second place for the trim/empty rule to drift.
 *
 * An element the device emitted EMPTY (`<rsrp></rsrp>` — what every SIM-less
 * bench unit returns) is indistinguishable from an absent one on purpose:
 * neither states a value, and the caller must report both as unknown rather
 * than as a reading.
 */
import { modemControlFunction } from "../modem-control-compat.ts";

const packagedXmlValue = modemControlFunction<typeof xmlValue | undefined>(
	"parseHilinkXmlValue",
	undefined,
);

export function xmlValue(body: string, tag: string): string | undefined {
	if (packagedXmlValue !== undefined) return packagedXmlValue(body, tag);
	const match = new RegExp(`<${tag}>([^<]*)</${tag}>`, "i").exec(body);
	const value = match?.[1]?.trim();
	return value === undefined || value === "" ? undefined : value;
}
