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
 * The HiLink dialect's session handshake and endpoint vocabulary, in ONE place.
 *
 * It sits BELOW both halves of the dialect on purpose. `router-cellular-admin.ts`
 * reads and `router-cellular-control.ts` writes, and before Stage B they were one
 * 808-pure-LOC module precisely because the session helper and the path constants
 * had nowhere else to live. Extracting them is what let the write path move out
 * without either side importing the other.
 *
 * `HilinkTransport` is deliberately NARROWER than `RouterAdminProbeDeps`: this
 * module needs exactly two capabilities, and taking the whole probe-deps type
 * would make the read module import the write module's dependency shape (or the
 * reverse) for no gain. The full deps object satisfies it structurally.
 */

import { xmlValue } from "./vendor-xml.ts";

/** Every HiLink endpoint this build talks to, read or write. */
export const HILINK_SESSION_PATH = "/api/webserver/SesTokInfo";
export const HILINK_DATA_SWITCH_PATH = "/api/dialup/mobile-dataswitch";
export const HILINK_CONNECTION_PATH = "/api/dialup/connection";
export const HILINK_SIGNAL_PATH = "/api/device/signal";
export const HILINK_NET_MODE_LIST_PATH = "/api/net/net-mode-list";
export const HILINK_NET_MODE_PATH = "/api/net/net-mode";
export const HILINK_DHCP_SETTINGS_PATH = "/api/dhcp/settings";
export const HILINK_USER_STATE_PATH = "/api/user/state-login";
export const HILINK_LOGIN_PATH = "/api/user/login";

/** Every HiLink request document opens with it; the firmware rejects one without. */
export const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

export type HilinkSession = {
	readonly cookie: string;
	readonly token: string;
};

/**
 * The two calls this dialect needs from the probe transport.
 *
 * `fetchViaInterface` binds `curl --interface`, which is the only steering on
 * this box that can name ONE of two twin dongles sharing a factory MAC, a LAN
 * subnet and an admin address — so it is not an implementation detail that a
 * caller may substitute with `fetch`.
 */
export type HilinkTransport = {
	fetchViaInterface: (
		ifname: string,
		urls: readonly string[],
		headers?: readonly string[],
	) => Promise<readonly string[]>;
	postViaInterface: (
		ifname: string,
		url: string,
		body: string,
		headers?: readonly string[],
	) => Promise<string>;
};

/**
 * `SesInfo` is a whole `Cookie:` header value and `TokInfo` the verification
 * token; without BOTH, every HiLink endpoint answers error `125002`.
 */
export function parseHilinkSession(body: string): HilinkSession | undefined {
	const cookie = xmlValue(body, "SesInfo");
	const token = xmlValue(body, "TokInfo");
	if (cookie === undefined || token === undefined) return undefined;
	return { cookie, token };
}

/**
 * Open a session against one dongle, bound to its own interface.
 *
 * A HiLink verification token is SINGLE-USE, so every read cycle and every write
 * opens its own; a caller that needs to prove a write landed must open a SECOND
 * session for the read-back rather than reusing the one that carried the write.
 */
export async function openHilinkSession(
	ifname: string,
	adminUrl: string,
	transport: HilinkTransport,
): Promise<HilinkSession | undefined> {
	const [body] = await transport.fetchViaInterface(ifname, [
		`${adminUrl}${HILINK_SESSION_PATH}`,
	]);
	return body === undefined ? undefined : parseHilinkSession(body);
}

export function hilinkHeaders(session: HilinkSession): readonly string[] {
	return [
		`Cookie: ${session.cookie}`,
		`__RequestVerificationToken: ${session.token}`,
	];
}
