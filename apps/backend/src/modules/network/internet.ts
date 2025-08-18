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

/*
  Check Internet connectivity and if needed update the default route
*/

import http, { type RequestOptions } from "node:http";

import { logger } from "../../helpers/logger.ts";

export const CONNECTIVITY_CHECK_DOMAIN = "www.gstatic.com";
const CONNECTIVITY_CHECK_PATH = "/generate_204";
const CONNECTIVITY_CHECK_CODE = 204;
const CONNECTIVITY_CHECK_BODY = "";

type HttpGetOptions = RequestOptions & {
	timeout?: number;
};

type HttpGetResponse = {
	code: number | undefined;
	body: string;
};

export function httpGet(options: HttpGetOptions) {
	return new Promise<HttpGetResponse>((resolve, reject) => {
		let to: ReturnType<typeof setTimeout> | undefined;

		if (options.timeout) {
			to = setTimeout(() => {
				req.destroy();
				reject("timeout");
			}, options.timeout);
		}

		const req = http.get(options, (res) => {
			let response = "";
			res.on("data", (d) => {
				response += d;
			});
			res.on("end", () => {
				if (to) {
					clearTimeout(to);
				}
				resolve({ code: res.statusCode, body: response });
			});
		});

		req.on("error", (e) => {
			if (to) {
				clearTimeout(to);
			}
			reject(e);
		});
	});
}

export async function checkConnectivity(
	remoteAddr: string,
	localAddress?: string,
) {
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
