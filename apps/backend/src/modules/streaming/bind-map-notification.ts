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

/*
  THE OPERATOR-VISIBLE HALF OF THE NORMALIZED DISPOSITION.

  The wording is DRIVEN BY THE TYPED DISPOSITION and never inferred, and the
  three degraded arms say three genuinely different things:

    retained_last_valid          the map went degraded on a RELOAD, so the sender
                                 kept the last valid mapped pool — BOTH twins are
                                 still carrying traffic. Degraded, not lost.
    startup_collision_excluded   the map was degraded from the first read, so one
                                 representative of each same-IP group runs and
                                 the rest are excluded. It names the group, and
                                 it does NOT claim which physical twin survived,
                                 because in legacy mode nothing can know that.
    legacy_unique_only           every link is unique, so every link runs — the
                                 only thing lost is the ABILITY to bond a same-IP
                                 group, which is worth saying before an operator
                                 plugs in a second identical modem.

  The second link is NEVER dropped in silence. That is the whole reason this
  notification exists rather than a log line.
*/

import {
	notificationBroadcast,
	notificationRemove,
} from "../ui/notifications.ts";

import {
	getNormalizedBindMapReport,
	isOperatorVisibleDegradation,
	type NormalizedBindMapReport,
} from "./bind-map-disposition.ts";

export const BIND_MAP_NOTIFICATION = "srtla_bind_map";

function describeCollisions(report: NormalizedBindMapReport): string {
	const groups = report.disposition.collisions ?? [];
	if (groups.length === 0) return "";
	return groups
		.map(
			(group) =>
				`${group.ip} (line ${group.effective_index} is carrying it; ${group.excluded_indices
					.map((index) => `line ${index}`)
					.join(", ")} excluded)`,
		)
		.join("; ");
}

export function bindMapBandMessage(
	report: NormalizedBindMapReport,
): string | undefined {
	const reason = report.status.reason;
	const suffix = reason === undefined ? "" : ` (${reason})`;

	switch (report.disposition.state) {
		case "mapped":
			return undefined;
		case "retained_last_valid":
			return `Link mapping is degraded${suffix}, but every bonded link is still running on the last valid mapping. Reconnect or restart the stream to refresh it.`;
		case "startup_collision_excluded":
			return `Link mapping is unavailable${suffix}, so links sharing an address cannot be told apart: ${describeCollisions(report)}. One of them is carrying the bond and the device cannot tell which physical modem it is.`;
		case "legacy_unique_only":
			return `Link mapping is unavailable${suffix}. Every link with its own address is bonded normally; two modems sharing one address could not be bonded together.`;
	}
}

/**
 * Publish (or retract) the band for whatever the normalized stream now says.
 *
 * Retraction is not optional: a persistent notification never expires on its
 * own, so a bond that recovers into `mapped` — or a session that ends — must
 * actively clear the claim or it stands for the rest of the process.
 */
export function announceBindMapReport(
	report: NormalizedBindMapReport | undefined = getNormalizedBindMapReport(),
): void {
	if (!isOperatorVisibleDegradation(report) || report === undefined) {
		notificationRemove(BIND_MAP_NOTIFICATION);
		return;
	}

	const message = bindMapBandMessage(report);
	if (message === undefined) {
		notificationRemove(BIND_MAP_NOTIFICATION);
		return;
	}

	notificationBroadcast(
		BIND_MAP_NOTIFICATION,
		"warning",
		message,
		0,
		true,
		true,
	);
}
