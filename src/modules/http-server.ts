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

/* Initialize the server */
import http from "node:http";

import finalhandler from "finalhandler";
import serveStatic from "serve-static";

import { logger } from "../helpers/logger.ts";
import { getSystemdSocket } from "./systemd.ts";

const staticHttp = serveStatic("public");

export const httpServer = http.createServer((req, res) => {
	const done = finalhandler(req, res);
	staticHttp(req, res, done);
});

const httpListenPorts: Array<number | { fd: number }> = [80, 8080, 81];

	if (process.env.PORT) {
		const port = Number.parseInt(process.env.PORT, 10);
		httpListenPorts.unshift(port);
	}

	const systemdSock = getSystemdSocket();
	if (systemdSock) {
		httpListenPorts.unshift(systemdSock);
	}

	if (httpListenPorts.length === 0) {
		logger.crit("HTTP server: no more ports left to try. Exiting...");
		process.exit(1);
	}

	const port = httpListenPorts.shift();
	const desc = typeof port === "number" ? `port ${port}` : "the systemd socket";
	console.log(`HTTP server: trying to start on ${desc}...`);
	httpServer.listen(port);
}
