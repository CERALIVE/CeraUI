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
  Check Internet connectivity and if needed update the default route
*/

import { logger } from "../../helpers/logger.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";

export const CONNECTIVITY_CHECK_DOMAIN = "www.gstatic.com";
const CONNECTIVITY_CHECK_PATH = "/generate_204";
const CONNECTIVITY_CHECK_CODE = 204;
const CONNECTIVITY_CHECK_BODY = "";

type HttpGetOptions = {
	headers?: Record<string, string>;
	path?: string;
	host?: string;
	timeout?: number;
	localAddress?: string;
};

type HttpGetResponse = {
	code: number | undefined;
	body: string;
};

export async function httpGet(options: HttpGetOptions) {
	const { headers, path, host, timeout } = options;

	const url = `http://${host}${path || "/"}`;
	const controller = new AbortController();
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	if (timeout) {
		timeoutId = setTimeout(() => {
			controller.abort();
		}, timeout);
	}

	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: headers || {},
		});

		if (timeoutId) {
			clearTimeout(timeoutId);
		}

		let body = "";
		if (response.body) {
			body = await response.text();
		}

		return { code: response.status, body };
	} catch (error) {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}

		throw error;
	}
}

export async function checkConnectivity(
	remoteAddr: string,
	localAddress?: string,
) {
	// In mock mode, always return true (simulated connectivity)
	if (shouldUseMocks()) {
		return true;
	}

	try {
		const options: HttpGetOptions = {};
		options.headers = { Host: CONNECTIVITY_CHECK_DOMAIN };
		options.path = CONNECTIVITY_CHECK_PATH;
		options.host = remoteAddr;
		options.timeout = 4000;

		if (localAddress) {
			options.localAddress = localAddress;
		}

		const res = await httpGet(options);
		if (
			res.code === CONNECTIVITY_CHECK_CODE &&
			res.body === CONNECTIVITY_CHECK_BODY
		) {
			return true;
		}
	} catch (err) {
		if (err instanceof Error) {
			logger.error(
				`Internet connectivity HTTP check error ${"code" in err ? err.code : err}`,
			);
		}
	}

	return false;
}
