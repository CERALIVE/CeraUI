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

import type WebSocket from "ws";

import { getRecentLogLines, logger } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";

import { notificationSend } from "../ui/notifications.ts";
import { buildMsg, getSocketSenderId } from "../ui/websocket-server.ts";

export interface LogResult {
	name: string;
	contents: string;
}

// Dev/CI hosts have no systemd journal: serve the in-memory ring buffer (the
// same backend records `journalctl -u ceralive.service` surfaces on a real
// device) so the observable-logs path works without hardware.
function buildMockJournal(service?: string): string {
	const header = service
		? `-- Logs begin for unit ${service} (CeraUI mock journal) --`
		: "-- Logs begin, full CeraUI system journal (mock) --";
	return [header, ...getRecentLogLines()].join("\n");
}

export async function getLog(
	conn: WebSocket,
	service?: string,
): Promise<LogResult | undefined> {
	const senderId = getSocketSenderId(conn);
	// Argv-only: each token is a discrete element, so a `service` value can never
	// be re-parsed as shell syntax (no `sh -c`, so `;`/spaces/`$()` are inert).
	const args = ["-b"];
	let name = "ceralive_system_log.txt";

	if (service) {
		args.push("-u", service);
		name = `${service.replace("CeraLive", "ceralive")}_log.txt`;
	}

	try {
		const contents = shouldUseMocks()
			? buildMockJournal(service)
			: await run("journalctl", args, { maxBuffer: 10 * 1024 * 1024 });
		// Pushed as a `log` event the frontend turns into a file download; also
		// returned so the getLog/getSyslog RPC is itself a real data source.
		conn.send(buildMsg("log", { name, contents }, senderId));
		return { name, contents };
	} catch (err) {
		const msg = `Failed to fetch the log: ${err}`;
		notificationSend(conn, "log_error", "error", msg, 10);
		logger.error(msg);
		return undefined;
	}
}
