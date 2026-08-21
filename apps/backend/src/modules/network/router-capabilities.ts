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
 * What a HiLink dongle's own firmware says it CAN do — read, before anything
 * is offered (todo 22, STAGE A).
 *
 * ── WHY A CAPABILITY IS A SEPARATE READING FROM A CONTROL ────────────────────
 *
 * `router-cellular-admin.ts` publishes `controls` only for a setting whose
 * write was PROVEN by round-trip on real hardware, and `/api/net/net-mode` is
 * the one that failed that bar: the bench unit answered error `112008` rather
 * than applying it, so its success could never be observed and no control was
 * shipped. That left the operator with no statement at all about the dongle's
 * radio-mode selection — neither the modes it advertises nor the fact that this
 * firmware refuses to move between them.
 *
 * This module reads that statement. `/api/net/net-mode-list` is the firmware's
 * OWN catalog of the modes it will discuss, and `/api/net/net-mode` reports the
 * one currently selected; both are GETs. The result is published as
 * `router_admin.capabilities`, and it is a READING, never an affordance.
 *
 * ── STAGE A SHIPS NO WRITE, FOR ANY FIRMWARE ────────────────────────────────
 *
 * There is deliberately no `writable` field and no net-mode entry in
 * `RouterAdminControls`. Proving a setting writable requires WRITING it, which
 * this stage does not do, so a `writable: true` here could only ever be a
 * repetition of the vendor's own claim — the exact hearsay
 * `applyRouterCellularControl` was built to refuse. A firmware that advertises
 * five modes and a firmware that refuses to name any are therefore rendered the
 * same way in one respect: neither gets a control. What differs is WHAT each is
 * reported to have said, which is the whole point — an operator who taps a
 * control that then fails is worse off than one who was told the truth first.
 *
 * (The net-mode WRITE, and the LAN-subnet rewrite beside it, are STAGE B. They
 * execute only under the mutation interlock, which does not exist yet.)
 *
 * Everything here is pure, so the whole matrix is provable against the exact
 * documents a dongle returns — including the verbatim `112008` refusal.
 */

import { xmlValue } from "./vendor-xml.ts";

/** One entry of the firmware's own network-mode catalog, verbatim. */
export type RouterNetMode = {
	/** The vendor's own index (`<Index>`), e.g. `03`. Never re-based. */
	readonly id: string;
	/** The vendor's own label (`<Name>`), e.g. `LTE`. Absent when unstated. */
	readonly name?: string;
};

/**
 * Why a capability could not be read. The vocabulary is `routerSignalMetric`'s,
 * plus `refused` — and the members are not synonyms: `refused` is the FIRMWARE
 * declining the question (it carries the vendor's own error code),
 * `auth-expired` is about the session, `malformed` about the body,
 * `not-reported` about this cycle's reading, and `unreachable` about the device.
 */
export type RouterCapabilityUnavailable =
	| "refused"
	| "auth-expired"
	| "not-reported"
	| "malformed"
	| "unreachable";

export type RouterNetModeCapability =
	| {
			readonly state: "reported";
			readonly modes: readonly RouterNetMode[];
			/** The mode the device says is selected now, where it stated one. */
			readonly current?: string;
	  }
	| {
			readonly state: "unavailable";
			readonly reason: RouterCapabilityUnavailable;
			/** The vendor's own error code — present exactly when `refused`. */
			readonly code?: string;
	  };

/** What this build DISCOVERED about a dongle, ahead of offering anything. */
export type RouterAdminCapabilities = {
	readonly net_mode: RouterNetModeCapability;
};

/** The capability-discovery bodies one HiLink read cycle collects. */
export type HilinkCapabilityBodies = {
	/** `/api/net/net-mode-list` — the firmware's own catalog. */
	readonly netModeList: string;
	/** `/api/net/net-mode` — which entry of that catalog is selected. */
	readonly netMode?: string;
};

/**
 * `<error><code>NNNNNN</code>…` — how EVERY HiLink endpoint declines. `112008`
 * is the code the bench unit answered for net-mode; `125002` is the session
 * refusal every endpoint gives without a valid token, and it is a statement
 * about the token rather than about the capability, so it is split out below.
 */
const HILINK_ERROR_CODE_RE = /<error>[\s\S]*?<code>\s*(\d+)\s*<\/code>/i;
const HILINK_AUTH_CODE = "125002";
const HILINK_RESPONSE_RE = /<response>/i;

import { modemControlFunction } from "../modem-control-compat.ts";

const packagedParseHilinkCapabilities = modemControlFunction<
	typeof parseHilinkCapabilities | undefined
>("parseHilinkCapabilities", undefined);

/** Each `<NetworkMode>` block of a `<NetworkModeList>` document. */
const NET_MODE_BLOCK = "<NetworkMode>";

function errorCode(body: string): string | undefined {
	return HILINK_ERROR_CODE_RE.exec(body)?.[1];
}

/**
 * The catalog, in the order the firmware listed it. An entry with no `<Index>`
 * is DROPPED rather than given a synthetic id: the index is what a Stage-B
 * write would have to name, so an entry we could not name is not a capability
 * this build may report.
 */
export function parseHilinkNetModeList(body: string): readonly RouterNetMode[] {
	const modes: RouterNetMode[] = [];
	for (const block of body.split(NET_MODE_BLOCK).slice(1)) {
		const id = xmlValue(block, "Index");
		if (id === undefined) continue;
		const name = xmlValue(block, "Name");
		modes.push(name === undefined ? { id } : { id, name });
	}
	return modes;
}

/**
 * Which mode the device says is selected, from `/api/net/net-mode`.
 *
 * A refusal or an unreadable body yields NOTHING rather than a guess — the
 * catalog is still worth reporting without it, and an invented "current" would
 * be a claim about the radio nobody made.
 */
function currentNetMode(body: string | undefined): string | undefined {
	if (body === undefined || errorCode(body) !== undefined) return undefined;
	return xmlValue(body, "NetworkMode");
}

function netModeCapability(
	bodies: HilinkCapabilityBodies,
): RouterNetModeCapability {
	const list = bodies.netModeList;
	if (list.trim() === "") {
		return { state: "unavailable", reason: "unreachable" };
	}

	const code = errorCode(list);
	if (code === HILINK_AUTH_CODE) {
		return { state: "unavailable", reason: "auth-expired" };
	}
	if (code !== undefined) {
		return { state: "unavailable", reason: "refused", code };
	}
	if (!HILINK_RESPONSE_RE.test(list)) {
		// Something answered, and it was not this API — a login page, a proxy
		// error document. That is a statement about the BODY, not the firmware.
		return { state: "unavailable", reason: "malformed" };
	}

	const modes = parseHilinkNetModeList(list);
	if (modes.length === 0) {
		return { state: "unavailable", reason: "not-reported" };
	}
	const current = currentNetMode(bodies.netMode);
	return current === undefined
		? { state: "reported", modes }
		: { state: "reported", modes, current };
}

/**
 * Discover what this HiLink firmware will discuss, before any control renders.
 *
 * ALWAYS answers — a dongle that refused, said nothing, or never replied is a
 * capability we HAVE a reading for, and reporting it is the difference between
 * an honest read-only surface and a blank one. `undefined` is reserved for a
 * cycle that never ran the discovery reads at all (a dialect that has none).
 */
export function parseHilinkCapabilities(
	bodies: HilinkCapabilityBodies,
): RouterAdminCapabilities {
	if (packagedParseHilinkCapabilities !== undefined) {
		return packagedParseHilinkCapabilities(bodies);
	}
	return { net_mode: netModeCapability(bodies) };
}
