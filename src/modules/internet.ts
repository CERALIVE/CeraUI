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

function httpGet(options: HttpGetOptions) {
	return new Promise<HttpGetResponse>(function (resolve, reject) {
		let to: NodeJS.Timeout | undefined;

		if (options.timeout) {
			to = setTimeout(function () {
				req.destroy();
				reject("timeout");
			}, options.timeout);
		}

		const req = http.get(options, function (res) {
			let response = "";
			res.on("data", function (d) {
				response += d;
			});
			res.on("end", function () {
				if (to) {
					clearTimeout(to);
				}
				resolve({ code: res.statusCode, body: response });
			});
		});

		req.on("error", function (e) {
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
		let url: HttpGetOptions = {};
		url.headers = { Host: CONNECTIVITY_CHECK_DOMAIN };
		url.path = CONNECTIVITY_CHECK_PATH;
		url.host = remoteAddr;
		url.timeout = 4000;

		if (localAddress) {
			url.localAddress = localAddress;
		}

		const res = await httpGet(url);
		if (
			res.code === CONNECTIVITY_CHECK_CODE &&
			res.body === CONNECTIVITY_CHECK_BODY
		) {
			return true;
		}
	} catch (err) {
		if (err instanceof Error) {
			console.log(
				"Internet connectivity HTTP check error " +
					("code" in err ? err.code : err),
			);
		}
	}

	return false;
}
