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

import { request as nodeHttpRequest } from "node:http";

import { logger } from "../../helpers/logger.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";

export const CONNECTIVITY_CHECK_DOMAIN = "www.gstatic.com";
export const CONNECTIVITY_CHECK_PATH = "/generate_204";
const CONNECTIVITY_CHECK_CODE = 204;
const CONNECTIVITY_CHECK_BODY = "";

type HttpGetOptions = {
	headers?: Record<string, string>;
	path?: string;
	host?: string;
	port?: number;
	timeout?: number;
	localAddress?: string;
};

/**
 * An IPv6 literal must be bracketed or `new URL()` — and so `fetch` — rejects
 * it. Board-confirmed: `www.gstatic.com`'s AAAA records each produced an
 * `ERR_INVALID_URL` before the probe ever left the device.
 */
export function formatUrlHost(host: string): string {
	if (!host.includes(":")) return host;
	return host.startsWith("[") ? host : `[${host}]`;
}

/**
 * Probe FROM a specific source address. Deliberate exception to this app's
 * `fetch`-only rule: Bun's `fetch` has no source-address option and `node:http`
 * does. Without binding, a "per-interface" probe egresses the CURRENT default
 * route, so the fallback loop re-tests the path that just failed and can never
 * elect a working interface — which is what shipped, `httpGet` having dropped
 * `localAddress` in its destructure.
 */
function boundHttpGet(
	options: HttpGetOptions & { localAddress: string },
): Promise<{ code: number; body: string }> {
	const { headers, path, host, port, timeout, localAddress } = options;

	return new Promise((resolve, reject) => {
		const req = nodeHttpRequest(
			{
				host,
				port: port ?? 80,
				path: path || "/",
				method: "GET",
				headers: headers || {},
				localAddress,
				...(timeout ? { timeout } : {}),
			},
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					body += chunk;
				});
				res.on("end", () => {
					resolve({ code: res.statusCode ?? 0, body });
				});
				res.on("error", reject);
			},
		);

		// `timeout` only fires the event; the socket must be destroyed explicitly
		// or a black-holed route holds the probe past the caller's budget.
		req.on("timeout", () => {
			req.destroy(new Error("connectivity probe timed out"));
		});
		req.on("error", reject);
		req.end();
	});
}

export async function httpGet(options: HttpGetOptions) {
	const { headers, path, host, port, timeout, localAddress } = options;

	if (localAddress) {
		return await boundHttpGet({ ...options, localAddress });
	}

	const authority = `${formatUrlHost(host ?? "")}${port ? `:${port}` : ""}`;
	const url = `http://${authority}${path || "/"}`;
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
