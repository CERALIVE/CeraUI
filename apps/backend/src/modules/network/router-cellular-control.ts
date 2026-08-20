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
 * Everything this build WRITES to a router-mode dongle (todo 22 Stage B).
 *
 * ── WHY A WRITE IS NEVER REPORTED FROM THE VENDOR'S OWN `OK` ─────────────────
 *
 * Every function here ends with a fresh READ of the field it just wrote, in a
 * NEW session, and answers `not_applied` when the device did not move. A HiLink
 * verification token is single-use, so reusing the write's session for the proof
 * would read back through a refused request and report the refusal as the value.
 * `<response>OK</response>` is hearsay — the exact "control that shows success
 * and changes nothing" this project treats as worse than no control at all.
 *
 * ── THE NET-MODE WRITE IS CAPABILITY-GATED, NOT VERSION-GATED ───────────────
 *
 * Stage A shipped the READ that says what a firmware will discuss:
 * `/api/net/net-mode-list` either names a catalog (`state: "reported"`) or says
 * why it will not (`state: "unavailable"`, carrying the vendor's own code — the
 * bench unit answers `112008`). Stage B writes ONLY into a `reported` catalog,
 * and only for an index that catalog actually contains. So on the bench unit,
 * which refuses the question, this build offers nothing and asks nothing; on a
 * firmware that names its modes, the same code path activates with no version
 * check, no allowlist, and no assumption about which firmwares exist.
 *
 * The gate is re-read IN THE SAME CYCLE as the write rather than taken from the
 * 30 s poll cache: a capability is a statement about the device now, and acting
 * on a cached one is how a control outlives the firmware that offered it.
 *
 * ── REPLACE, NEVER PATCH ────────────────────────────────────────────────────
 *
 * Both HiLink write endpoints REPLACE the record they receive. Posting one field
 * therefore resets every other field to whatever the firmware defaults to — MTU,
 * idle timeout and the auto-dial flags for `/api/dialup/connection`; the band
 * masks for `/api/net/net-mode`. Every request document below echoes the values
 * the device just reported, and each echo has a stated fallback so a partial
 * read cannot silently write a zero.
 */

import { logger } from "../../helpers/logger.ts";
import { hilinkConnectionBody, hilinkNetModeBody } from "./hilink-documents.ts";
import {
	HILINK_CONNECTION_PATH,
	HILINK_DATA_SWITCH_PATH,
	HILINK_NET_MODE_LIST_PATH,
	HILINK_NET_MODE_PATH,
	hilinkHeaders,
	openHilinkSession,
	XML_HEADER,
} from "./hilink-session.ts";
import {
	parseHilinkCapabilities,
	type RouterAdminCapabilities,
} from "./router-capabilities.ts";
import {
	defaultRouterAdminProbeDeps,
	dialectForVidPid,
	parseDefaultGateways,
	parseHilinkControls,
	type RouterAdminControls,
	type RouterAdminProbeDeps,
} from "./router-cellular-admin.ts";

export type RouterAdminControlId = keyof RouterAdminControls;

/**
 * The result of asking a dongle to change one of its own settings.
 *
 * `applied` is issued ONLY after a fresh read of the same field returned the
 * requested value.
 */
export type RouterAdminWriteResult =
	| { status: "applied"; controls: RouterAdminControls }
	| {
			status: "refused";
			reason: "unsupported" | "unreachable" | "not_applied";
	  };

/**
 * The result of asking a dongle to change its radio-mode selection.
 *
 * `capability_unavailable` is DISTINCT from `unsupported`, and the distinction is
 * the whole Stage-A/Stage-B seam: `unsupported` means this build has no net-mode
 * write for that dialect at all, while `capability_unavailable` means the dialect
 * has one and THIS firmware declined to name a catalog — it carries the vendor's
 * own code so an operator is told `112008` rather than a CeraLive euphemism.
 * `not_offered` is a third thing again: the firmware named a catalog and the
 * requested index is not in it.
 */
export type RouterNetModeWriteResult =
	| { status: "applied"; capabilities: RouterAdminCapabilities }
	| {
			status: "refused";
			reason:
				| "unsupported"
				| "capability_unavailable"
				| "not_offered"
				| "unreachable"
				| "not_applied";
			/** The vendor's own error code, when the firmware supplied one. */
			code?: string;
	  };

/** Resolve a dongle's admin URL from the routing table, never from a default. */
async function resolveAdminUrl(
	ifname: string,
	deps: RouterAdminProbeDeps,
): Promise<string | undefined> {
	try {
		const gateway = parseDefaultGateways(
			await deps.runIpRouteShowDefault(),
		).get(ifname);
		return gateway === undefined ? undefined : `http://${gateway}`;
	} catch {
		return undefined;
	}
}

/**
 * Apply one proven-writable setting to one dongle, then PROVE it landed.
 *
 * Only the HiLink dialect gets here; every other device answers `unsupported`,
 * which is a statement about what this build has measured, not about what the
 * vendor's firmware might theoretically accept.
 */
export async function applyRouterCellularControl(
	ifname: string,
	vidPid: string,
	control: RouterAdminControlId,
	value: boolean,
	deps: RouterAdminProbeDeps = defaultRouterAdminProbeDeps,
): Promise<RouterAdminWriteResult> {
	if (dialectForVidPid(vidPid) !== "hilink") {
		return { status: "refused", reason: "unsupported" };
	}
	if (!(await deps.isRealDevice())) {
		return { status: "refused", reason: "unsupported" };
	}

	const adminUrl = await resolveAdminUrl(ifname, deps);
	if (adminUrl === undefined)
		return { status: "refused", reason: "unreachable" };

	try {
		const session = await openHilinkSession(ifname, adminUrl, deps);
		if (session === undefined) {
			return { status: "refused", reason: "unreachable" };
		}
		const headers = hilinkHeaders(session);

		if (control === "mobile_data") {
			await deps.postViaInterface(
				ifname,
				`${adminUrl}${HILINK_DATA_SWITCH_PATH}`,
				`${XML_HEADER}<request><dataswitch>${value ? 1 : 0}</dataswitch></request>`,
				headers,
			);
		} else {
			const [current] = await deps.fetchViaInterface(
				ifname,
				[`${adminUrl}${HILINK_CONNECTION_PATH}`],
				headers,
			);
			await deps.postViaInterface(
				ifname,
				`${adminUrl}${HILINK_CONNECTION_PATH}`,
				hilinkConnectionBody(current ?? "", value),
				headers,
			);
		}

		// The proof. A NEW session, because the token is single-use, and a real
		// read of both fields rather than of the one just written — a device that
		// silently reset its sibling setting must not be reported as clean.
		const verifySession = await openHilinkSession(ifname, adminUrl, deps);
		if (verifySession === undefined) {
			return { status: "refused", reason: "not_applied" };
		}
		const [dataSwitch, connection] = await deps.fetchViaInterface(
			ifname,
			[
				`${adminUrl}${HILINK_DATA_SWITCH_PATH}`,
				`${adminUrl}${HILINK_CONNECTION_PATH}`,
			],
			hilinkHeaders(verifySession),
		);
		const controls = parseHilinkControls(dataSwitch ?? "", connection ?? "");
		if (controls === undefined || controls[control] !== value) {
			return { status: "refused", reason: "not_applied" };
		}
		return { status: "applied", controls };
	} catch (error) {
		logger.debug("router-cellular control write failed", {
			ifname,
			control,
			error,
		});
		return { status: "refused", reason: "unreachable" };
	}
}

/** Read the firmware's own catalog + selection in one bound fetch. */
async function readNetMode(
	ifname: string,
	adminUrl: string,
	deps: RouterAdminProbeDeps,
	headers: readonly string[],
): Promise<{
	readonly capabilities: RouterAdminCapabilities;
	readonly netMode: string;
}> {
	const [netModeList, netMode] = await deps.fetchViaInterface(
		ifname,
		[
			`${adminUrl}${HILINK_NET_MODE_LIST_PATH}`,
			`${adminUrl}${HILINK_NET_MODE_PATH}`,
		],
		headers,
	);
	return {
		capabilities: parseHilinkCapabilities({
			netModeList: netModeList ?? "",
			netMode: netMode ?? "",
		}),
		netMode: netMode ?? "",
	};
}

/**
 * Select one of the radio modes the firmware itself advertised.
 *
 * The ordering is the contract: the capability is READ FIRST, in this cycle's own
 * session, and a firmware that will not name a catalog is refused BEFORE any
 * request document is built — so a device that answers `112008` is never posted
 * to, and the operator is told the firmware's own code rather than a generic
 * failure. A catalog that exists but does not contain the requested index is
 * refused just as firmly: the index is the vendor's own, and inventing one is the
 * fabrication Stage A's `<Index>`-less drop rule already refuses on the read side.
 */
export async function applyRouterNetMode(
	ifname: string,
	vidPid: string,
	modeId: string,
	deps: RouterAdminProbeDeps = defaultRouterAdminProbeDeps,
): Promise<RouterNetModeWriteResult> {
	if (dialectForVidPid(vidPid) !== "hilink") {
		return { status: "refused", reason: "unsupported" };
	}
	if (!(await deps.isRealDevice())) {
		return { status: "refused", reason: "unsupported" };
	}

	const adminUrl = await resolveAdminUrl(ifname, deps);
	if (adminUrl === undefined)
		return { status: "refused", reason: "unreachable" };

	try {
		const session = await openHilinkSession(ifname, adminUrl, deps);
		if (session === undefined) {
			return { status: "refused", reason: "unreachable" };
		}
		const before = await readNetMode(
			ifname,
			adminUrl,
			deps,
			hilinkHeaders(session),
		);
		const capability = before.capabilities.net_mode;
		if (capability.state !== "reported") {
			const refusal: RouterNetModeWriteResult = {
				status: "refused",
				reason: "capability_unavailable",
			};
			return capability.code === undefined
				? refusal
				: { ...refusal, code: capability.code };
		}
		if (!capability.modes.some((mode) => mode.id === modeId)) {
			return { status: "refused", reason: "not_offered" };
		}

		await deps.postViaInterface(
			ifname,
			`${adminUrl}${HILINK_NET_MODE_PATH}`,
			hilinkNetModeBody(before.netMode, modeId),
			hilinkHeaders(session),
		);

		// The proof, in a new session for the same single-use-token reason as
		// every other write here.
		const verifySession = await openHilinkSession(ifname, adminUrl, deps);
		if (verifySession === undefined) {
			return { status: "refused", reason: "not_applied" };
		}
		const after = await readNetMode(
			ifname,
			adminUrl,
			deps,
			hilinkHeaders(verifySession),
		);
		const applied = after.capabilities.net_mode;
		if (applied.state !== "reported" || applied.current !== modeId) {
			return { status: "refused", reason: "not_applied" };
		}
		return { status: "applied", capabilities: after.capabilities };
	} catch (error) {
		logger.debug("router-cellular net-mode write failed", {
			ifname,
			modeId,
			error,
		});
		return { status: "refused", reason: "unreachable" };
	}
}
