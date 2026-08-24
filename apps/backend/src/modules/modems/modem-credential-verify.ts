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
  PRESENTING A STORED LOGIN TO ONE DEVICE, EXACTLY ONCE.

  The device-facing half of the five-state lock model. It resolves a wire id to
  the physical device behind it, asks the dialect whether a login is required at
  all, and — only when one is — presents the stored credential a SINGLE time.

  ── ONE ATTEMPT, AND NEVER A RETRY ────────────────────────────────────────

  Every dialect here counts failed logins toward a lockout the operator then
  cannot clear, so a retry does not improve the odds — it spends the attempts
  that would have let the operator correct a typo. `auth-failed` is therefore
  terminal for this call, and `locked-out` is refused BEFORE a transport is
  opened, so a locked-out device costs zero requests.

  ── THE LOGIN IS A PORT, BECAUSE ONLY ONE DIALECT HAS A PROVEN ONE ────────

  The HiLink login derivation carried here is modem-stack's certified one
  (`providers/huawei-hilink/session.ts`, password types 3 and 4), re-derived
  rather than imported for Rule D. ZTE goform and Qualcomm HIMI answer
  `protocol-mismatch` — this build ships no login for them that anybody has
  observed working, and an unproven credential derivation would burn a real
  operator's attempts against a real lockout counter. That refusal is honest and
  reaches the operator as `unsupported-profile`, not as a rejected password.
*/

import { createHash } from "node:crypto";

import type {
	ModemCredentialsRefusal,
	ModemLockState,
} from "@ceraui/rpc/schemas";

import {
	HILINK_LOGIN_PATH,
	HILINK_USER_STATE_PATH,
	hilinkHeaders,
	openHilinkSession,
	XML_HEADER,
} from "../network/hilink-session.ts";
import type { RouterAdminDialect } from "../network/router-cellular-admin.ts";
import {
	defaultRouterAdminProbeDeps,
	dialectForVidPid,
	getRouterCellularAdmin,
} from "../network/router-cellular-admin.ts";
import { getRouterCellularMarker } from "../network/router-cellular-scan.ts";
import { xmlValue } from "../network/vendor-xml.ts";
import { isRealDevice } from "../system/device-detection.ts";
import type { ModemCredential } from "./modem-credentials.ts";
import {
	readModemCredential,
	recordModemCredentialOutcome,
} from "./modem-credentials.ts";
import type { AuthAttemptDetail } from "./modem-lock-state.ts";
import {
	classifyAuthAttempt,
	classifyHilinkLoginState,
	lockoutRemainingMs,
	noteLockOpenEvidence,
	noteLockOutcome,
} from "./modem-lock-state.ts";
import { routerCellularIfnameForWireId } from "./modem-wire-producer.ts";
import type { PhysicalDeviceRecord } from "./physical-identity.ts";
import { resolveModemPhysicalIdentity } from "./physical-identity-source.ts";

/** The two transport calls a login needs — the probe deps satisfy it structurally. */
export interface CredentialTransport {
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
}

export interface CredentialTarget {
	readonly ifname: string;
	readonly adminUrl: string;
	readonly dialect: RouterAdminDialect | undefined;
	readonly device: PhysicalDeviceRecord;
}

export interface RouterLoginPort {
	detectOpen: (
		target: CredentialTarget,
		transport: CredentialTransport,
	) => Promise<"open" | "locked" | undefined>;
	attempt: (
		target: CredentialTarget,
		credential: ModemCredential,
		transport: CredentialTransport,
	) => Promise<AuthAttemptDetail>;
}

/**
 * Resolve a `router-ethernet` wire id to the device behind it.
 *
 * The admin URL comes from the cached READING rather than a fresh `ip route`
 * read: that cache is what proved the address is this interface's own default
 * gateway, and re-deriving it here would be a second opinion about which address
 * belongs to which twin — the exact ambiguity `curl --interface` exists to end.
 */
export function resolveCredentialTarget(
	device: string,
): CredentialTarget | undefined {
	const ifname = routerCellularIfnameForWireId(Number(device));
	if (ifname === undefined || ifname === "") return undefined;
	const marker = getRouterCellularMarker(ifname);
	if (marker === undefined) return undefined;
	const admin = getRouterCellularAdmin(ifname);
	if (admin === undefined) return undefined;
	return {
		ifname,
		adminUrl: admin.admin_url,
		dialect: dialectForVidPid(marker.vid_pid),
		device: resolveModemPhysicalIdentity(ifname, {
			...(marker.serial !== undefined ? { unitLabel: marker.serial } : {}),
		}),
	};
}

function base64(value: string): string {
	return Buffer.from(value).toString("base64");
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * modem-stack's certified HiLink derivation, re-stated (Rule D forbids reaching
 * into the sibling checkout). Password type 3 is a bare base64; type 4 salts the
 * hashed password with the username and the session's single-use token.
 */
export function hilinkLoginDocument(
	passwordType: 3 | 4,
	username: string,
	password: string,
	token: string,
): string {
	const derived =
		passwordType === 3
			? base64(password)
			: base64(sha256Hex(`${username}${base64(sha256Hex(password))}${token}`));
	return `${XML_HEADER}<request><Username>${escapeXml(username)}</Username><Password>${derived}</Password><password_type>${passwordType}</password_type></request>`;
}

/**
 * Huawei's own error codes, mapped onto the four attempt outcomes.
 *
 * `108007` is the lockout code and is the reason the vocabulary needs a member
 * distinct from a rejection: the device is refusing to READ a password, not
 * reporting that this one was wrong. Anything unrecognised is a
 * `protocol-mismatch` rather than a rejection, because a code we cannot place is
 * not evidence about the operator's password.
 */
export function classifyHilinkLoginResponse(body: string): AuthAttemptDetail {
	if (/<response>\s*OK\s*<\/response>/i.test(body)) return "auth-accepted";
	const code = xmlValue(body, "code");
	if (code === "108003") return "auth-accepted";
	if (code === "108001" || code === "108002" || code === "108006") {
		return "auth-rejection";
	}
	if (code === "108007") return "lockout";
	return "protocol-mismatch";
}

function hilinkPasswordType(body: string): 3 | 4 | undefined {
	const raw = xmlValue(body, "password_type");
	if (raw === "3") return 3;
	if (raw === "4") return 4;
	return undefined;
}

export const defaultRouterLoginPort: RouterLoginPort = {
	detectOpen: async (target, transport) => {
		if (target.dialect !== "hilink") return undefined;
		const session = await openHilinkSession(
			target.ifname,
			target.adminUrl,
			transport,
		);
		if (session === undefined) return undefined;
		const [body] = await transport.fetchViaInterface(
			target.ifname,
			[`${target.adminUrl}${HILINK_USER_STATE_PATH}`],
			hilinkHeaders(session),
		);
		return body === undefined ? undefined : classifyHilinkLoginState(body);
	},

	attempt: async (target, credential, transport) => {
		if (target.dialect !== "hilink") return "protocol-mismatch";
		const session = await openHilinkSession(
			target.ifname,
			target.adminUrl,
			transport,
		);
		if (session === undefined) return "protocol-mismatch";
		const [state] = await transport.fetchViaInterface(
			target.ifname,
			[`${target.adminUrl}${HILINK_USER_STATE_PATH}`],
			hilinkHeaders(session),
		);
		const passwordType =
			state === undefined ? undefined : hilinkPasswordType(state);
		if (passwordType === undefined) return "protocol-mismatch";
		const body = await transport.postViaInterface(
			target.ifname,
			`${target.adminUrl}${HILINK_LOGIN_PATH}`,
			hilinkLoginDocument(
				passwordType,
				credential.username,
				credential.password,
				session.token,
			),
			hilinkHeaders(session),
		);
		return classifyHilinkLoginResponse(body);
	},
};

export const defaultCredentialTransport: CredentialTransport = {
	fetchViaInterface: defaultRouterAdminProbeDeps.fetchViaInterface,
	postViaInterface: defaultRouterAdminProbeDeps.postViaInterface,
};

export interface CredentialVerifyDeps {
	isRealDevice: () => Promise<boolean>;
	resolveTarget: (device: string) => CredentialTarget | undefined;
	readCredential: (device: PhysicalDeviceRecord) => ModemCredential | undefined;
	loginPort: RouterLoginPort;
	transport: CredentialTransport;
	now: () => number;
}

export const defaultCredentialVerifyDeps: CredentialVerifyDeps = {
	isRealDevice: () => isRealDevice(),
	resolveTarget: resolveCredentialTarget,
	readCredential: readModemCredential,
	loginPort: defaultRouterLoginPort,
	transport: defaultCredentialTransport,
	now: () => Date.now(),
};

export interface VerifyOutcome {
	readonly success: boolean;
	readonly error?: ModemCredentialsRefusal;
	readonly target?: CredentialTarget;
}

function refusalFor(
	state: ModemLockState,
	sub?: string,
): ModemCredentialsRefusal {
	if (state === "auth-failed") return "auth_failed";
	if (state === "locked-out") return "locked_out";
	return sub === "unsupported-profile" ? "unsupported_profile" : "unreachable";
}

/**
 * Present the stored credential to one device, at most once.
 *
 * The gate ORDER is the safety contract. The lockout check runs FIRST and reads
 * only local state, so a device inside its own lockout window costs ZERO
 * requests — presenting a credential there is precisely what spends the attempts
 * that keep the window open. Open-detection then runs before the credential is
 * read at all, so a device that needs no login is never handed one.
 */
export async function verifyModemCredential(
	device: string,
	deps: CredentialVerifyDeps = defaultCredentialVerifyDeps,
): Promise<VerifyOutcome> {
	const target = deps.resolveTarget(device);
	if (target === undefined) return { success: false, error: "unknown_device" };

	const now = deps.now();
	if (lockoutRemainingMs(target.device.identityKey, now) !== undefined) {
		return { success: false, error: "locked_out", target };
	}

	if (!(await deps.isRealDevice())) {
		return { success: false, error: "unavailable_in_emulated_mode", target };
	}

	let evidence: "open" | "locked" | undefined;
	try {
		evidence = await deps.loginPort.detectOpen(target, deps.transport);
	} catch {
		noteLockOpenEvidence(target.ifname, undefined);
		return { success: false, error: "unreachable", target };
	}
	noteLockOpenEvidence(target.ifname, evidence);
	if (evidence === "open") {
		return { success: false, error: "device_open", target };
	}

	const credential = deps.readCredential(target.device);
	if (credential === undefined) {
		return { success: false, error: "no_credential", target };
	}

	let detail: AuthAttemptDetail;
	try {
		detail = await deps.loginPort.attempt(target, credential, deps.transport);
	} catch {
		return { success: false, error: "unreachable", target };
	}
	const classification = classifyAuthAttempt(detail);
	noteLockOutcome(target.device.identityKey, classification, now);
	recordModemCredentialOutcome(
		target.device,
		classification.state,
		classification.state === "unlocked" ? now : undefined,
	);

	return classification.state === "unlocked"
		? { success: true, target }
		: {
				success: false,
				error: refusalFor(classification.state, classification.subReason),
				target,
			};
}
