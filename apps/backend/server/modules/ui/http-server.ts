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

import { logger } from "../../helpers/logger.ts";
import { getSystemdSocket } from "../system/systemd.ts";

const staticHttp = serveStatic("public");

export const httpServer = http.createServer((req, res) => {
	const done = finalhandler(req, res);
	staticHttp(req, res, done);
});

const httpListenPorts: Array<number | { fd: number }> = [80, 8080, 81];

export function initHttpServer() {
	if (process.env.PORT) {
		const port = Number.parseInt(process.env.PORT, 10);
		httpListenPorts.unshift(port);
	}

	const systemdSock = getSystemdSocket();
	if (systemdSock) {
		httpListenPorts.unshift(systemdSock);
	}

	httpServer.on("error", (e) => {
		if ("code" in e && e.code === "EADDRINUSE") {
			logger.warn("HTTP server: port already in use, trying the next one...");
			startHttpServer();
		} else {
			logger.error("HTTP server: error");
			logger.error(e);
			process.exit(1);
		}
	});

	startHttpServer();
}

export function startHttpServer() {
	if (httpListenPorts.length === 0) {
		logger.error("HTTP server: no more ports left to try. Exiting...");
		process.exit(1);
	}

	const portOrHandle = httpListenPorts.shift();

	const isPort = typeof portOrHandle === "number";
	const desc = isPort ? `port ${portOrHandle}` : "the systemd socket";
	logger.info(`HTTP server: trying to start on ${desc}...`);

	httpServer.listen(portOrHandle);
}
