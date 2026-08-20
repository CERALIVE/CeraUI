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
 * USSD status, initiate, respond, and cancel over the allowlisted mmcli runner —
 * the same ModemManager daemon both cellular backends talk to, so this behaves
 * identically under either selection.
 *
 * CONTENT-FREE BY CONSTRUCTION, for the same reason `mmcli-sms.ts` is: a USSD
 * exchange carries balances, subscriber numbers, one-time codes, and — in the
 * COMMAND direction — prepaid voucher codes. No parser here puts a parsed line
 * into a log or into an error, and `mmcliParseSep` is deliberately NOT reused for
 * the reply: it logs the offending line verbatim when a line does not split.
 * `--3gpp-ussd-status` DOES reuse it — that output is a session-state token.
 *
 * WHY THE REPLY PARSER ACCEPTS TWO SHAPES. mmcli renders an action command's
 * result as human output, and the exact framing of a USSD reply has NOT been
 * verified against a real carrier answer on the bench (BLOCKER B4: no
 * SMS/USSD-capable registered SIM). Both the `-K` key form and the human
 * `Reply: '…'` form are therefore accepted, and an unrecognised shape yields NO
 * reply rather than a guess — the session state still advances from the modem's
 * own `--3gpp-ussd-status`, so a missed reply degrades the render, never the
 * state machine.
 */

import type { UssdRefusal } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import {
	handleMmcliCommand,
	shouldMockModems,
} from "../../mocks/providers/modems.ts";
import { describeCliError } from "../system/cli-parse.ts";
import { MODEM_PATH_RE, mmcliBinary, mmcliParseSep } from "./mmcli.ts";
import type { UssdRepliedState } from "./ussd-session.ts";

/** What the modem says about its own USSD surface right now. */
export type UssdStatus = {
	/** Did the modem answer a USSD status read at all? */
	readonly supported: boolean;
	readonly sessionState: UssdRepliedState;
};

export type UssdStatusResult =
	| { ok: true; status: UssdStatus }
	| { ok: false; reason: UssdRefusal };

export type UssdTurnResult =
	| { ok: true; ussdReply?: string; sessionState: UssdRepliedState }
	| { ok: false; reason: UssdRefusal };

export type UssdCancelResult =
	| { ok: true }
	| { ok: false; reason: UssdRefusal };

/** The registration evidence the LTE-only refusal is allowed to be claimed from. */
export type UssdRegistration = {
	readonly registered: boolean;
	readonly csDomain?: boolean;
	readonly accessTechnologies?: readonly string[];
};

export const UNKNOWN_USSD_REGISTRATION: UssdRegistration = {
	registered: false,
};

const STATUS_KEYS = [
	"modem.3gpp.ussd.status",
	"modem.3gpp.ussd.state",
] as const;

/** `MMModem3gppUssdSessionState` as mmcli spells it. */
const SESSION_STATE_TOKENS: Readonly<Record<string, UssdRepliedState>> = {
	"user-response": "awaiting-reply",
	user_response: "awaiting-reply",
	active: "active",
	idle: "released",
	unknown: "released",
};

/**
 * Access technologies that carry no circuit-switched domain of their own. USSD is
 * a circuit-switched supplementary service, so this list is the whole basis of
 * the `lte-only-unsupported` claim.
 */
const PACKET_ONLY_RATS: ReadonlySet<string> = new Set<string>([
	"lte",
	"5gnr",
	"lte-cat-m",
	"lte-nb-iot",
]);

/** mmcli registration-state tokens that mean the modem is on a network. */
const REGISTERED_TOKENS: ReadonlySet<string> = new Set<string>([
	"home",
	"roaming",
	"home-sms-only",
	"roaming-sms-only",
	"home-csfb-not-preferred",
	"roaming-csfb-not-preferred",
]);

/** …and the two that positively advertise a circuit-switched fallback. */
const CSFB_TOKENS: ReadonlySet<string> = new Set<string>([
	"home-csfb-not-preferred",
	"roaming-csfb-not-preferred",
]);

export function decodeUssdSessionState(
	token: string | undefined,
): UssdRepliedState {
	if (token === undefined) return "released";
	return SESSION_STATE_TOKENS[token.trim().toLowerCase()] ?? "released";
}

/**
 * Is this registration positively incapable of carrying a circuit-switched
 * service? Requires evidence in BOTH directions — an unread field can only ever
 * make the refusal LESS specific, never more.
 */
export function isPacketSwitchedOnly(registration: UssdRegistration): boolean {
	if (!registration.registered || registration.csDomain !== false) return false;
	const rats = registration.accessTechnologies;
	if (rats === undefined || rats.length === 0) return false;
	return rats.every((rat) => PACKET_ONLY_RATS.has(rat.toLowerCase()));
}

/** Derive the registration facts from a parsed `mmcli -K -m <id>` record. */
export function ussdRegistrationFromRecord(
	parsed: Record<string, string | Array<string>>,
): UssdRegistration {
	const rawState = parsed["modem.3gpp.registration-state"];
	const state =
		typeof rawState === "string" ? rawState.toLowerCase() : undefined;
	const rawTechs = parsed["modem.generic.access-technologies"];
	const technologies =
		rawTechs === undefined
			? undefined
			: (Array.isArray(rawTechs) ? rawTechs : [rawTechs]).map((tech) =>
					tech.toLowerCase(),
				);

	let csDomain: boolean | undefined;
	if (state !== undefined && CSFB_TOKENS.has(state)) {
		csDomain = true;
	} else if (technologies !== undefined && technologies.length > 0) {
		csDomain = technologies.some((rat) => !PACKET_ONLY_RATS.has(rat));
	}

	return {
		registered: state !== undefined && REGISTERED_TOKENS.has(state),
		...(csDomain === undefined ? {} : { csDomain }),
		...(technologies === undefined ? {} : { accessTechnologies: technologies }),
	};
}

/**
 * Classify an mmcli failure into a typed refusal.
 *
 * The PS-only promotion runs LAST and applies only to the two reasons that are
 * genuinely ambiguous between a device limit and a carrier policy. A
 * not-registered answer, a busy session, or a spawn failure is neither, and is
 * left alone.
 */
export function classifyUssdCliFailure(
	description: string,
	registration: UssdRegistration = UNKNOWN_USSD_REGISTRATION,
): UssdRefusal {
	const reason = ((): UssdRefusal => {
		if (/couldn't find modem|cannot find modem/i.test(description)) {
			return "unknown_modem";
		}
		if (/no ussd support|not supported|unsupported/i.test(description)) {
			return "unsupported";
		}
		if (/no active.*ussd session|no ussd session/i.test(description)) {
			return "no-session";
		}
		if (
			/already (?:active|in progress)|operation in progress/i.test(description)
		) {
			return "session-busy";
		}
		if (/not enabled yet|not registered|no network/i.test(description)) {
			return "not-registered";
		}
		if (/timed? ?out/i.test(description)) return "timeout";
		if (/rejected|refused|denied|network error/i.test(description)) {
			return "carrier-rejected";
		}
		return "transport-failed";
	})();

	const ambiguous = reason === "unsupported" || reason === "carrier-rejected";
	return ambiguous && isPacketSwitchedOnly(registration)
		? "lte-only-unsupported"
		: reason;
}

/**
 * Extract the carrier's reply from an mmcli action's output.
 *
 * NEVER logs, and never reports the raw output on a miss — every line here is
 * carrier text. Returns `undefined` when neither recognised shape is present.
 */
export function parseUssdReply(raw: string): string | undefined {
	for (const line of raw.split("\n")) {
		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		const key = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();
		if (value === "" || value === "--") continue;
		const isKeyForm =
			key.startsWith("modem.3gpp.ussd.") && key.endsWith("reply");
		if (!isKeyForm && key !== "reply") continue;
		return value.replace(/^'(.*)'$/s, "$1");
	}
	return undefined;
}

export type UssdCliRunner = (args: string[]) => Promise<string>;

const defaultUssdRunner: UssdCliRunner = async (args) => {
	if (shouldMockModems()) {
		const mockOutput = handleMmcliCommand(args);
		if (mockOutput) return mockOutput;
	}
	return await run(mmcliBinary, args);
};

/**
 * Read the modem's registration, for the failure path only.
 *
 * Fail-soft: a read that did not land yields {@link UNKNOWN_USSD_REGISTRATION},
 * which can only ever make a refusal less specific.
 */
export async function readUssdRegistration(
	modemPath: string,
	runCli: UssdCliRunner = defaultUssdRunner,
): Promise<UssdRegistration> {
	try {
		const stdout = await runCli(["-K", "-m", modemPath]);
		return ussdRegistrationFromRecord(mmcliParseSep(stdout));
	} catch {
		return UNKNOWN_USSD_REGISTRATION;
	}
}

async function classifyFailure(
	modemPath: string,
	err: unknown,
	runCli: UssdCliRunner,
): Promise<UssdRefusal> {
	const description = describeCliError(err);
	const registration = await readUssdRegistration(modemPath, runCli);
	const reason = classifyUssdCliFailure(description, registration);
	// The REASON only — mmcli's USSD failure text can quote the command back.
	logger.warn(`mmcli USSD call failed for modem ${modemPath}: ${reason}`, {
		module: "modems",
	});
	return reason;
}

export async function readUssdStatus(
	modemPath: string,
	runCli: UssdCliRunner = defaultUssdRunner,
): Promise<UssdStatusResult> {
	if (!MODEM_PATH_RE.test(modemPath)) {
		logger.warn("readUssdStatus: rejected invalid modem path shape");
		return { ok: false, reason: "unknown_modem" };
	}
	let stdout: string;
	try {
		stdout = await runCli(["-K", "-m", modemPath, "--3gpp-ussd-status"]);
	} catch (err) {
		return { ok: false, reason: await classifyFailure(modemPath, err, runCli) };
	}
	const parsed = mmcliParseSep(stdout);
	const token = STATUS_KEYS.map((key) => parsed[key]).find(
		(value): value is string => typeof value === "string",
	);
	// A status read that answered but named no state key is drift, and answering
	// "no session" from it would tell an operator a live dialogue is closed.
	if (token === undefined) {
		return { ok: false, reason: "transport-failed" };
	}
	return {
		ok: true,
		status: { supported: true, sessionState: decodeUssdSessionState(token) },
	};
}

async function runTurn(
	modemPath: string,
	flag: string,
	runCli: UssdCliRunner,
): Promise<UssdTurnResult> {
	if (!MODEM_PATH_RE.test(modemPath)) {
		return { ok: false, reason: "unknown_modem" };
	}
	let stdout: string;
	try {
		stdout = await runCli(["-m", modemPath, flag]);
	} catch (err) {
		return { ok: false, reason: await classifyFailure(modemPath, err, runCli) };
	}

	const ussdReply = parseUssdReply(stdout);
	// The modem's OWN post-call state decides whether the dialogue continues —
	// never the presence or absence of reply text.
	const status = await readUssdStatus(modemPath, runCli);
	return {
		ok: true,
		...(ussdReply === undefined ? {} : { ussdReply }),
		sessionState: status.ok ? status.status.sessionState : "released",
	};
}

export function initiateUssd(
	modemPath: string,
	ussdCommand: string,
	runCli: UssdCliRunner = defaultUssdRunner,
): Promise<UssdTurnResult> {
	return runTurn(modemPath, `--3gpp-ussd-initiate=${ussdCommand}`, runCli);
}

export function respondUssd(
	modemPath: string,
	ussdResponse: string,
	runCli: UssdCliRunner = defaultUssdRunner,
): Promise<UssdTurnResult> {
	return runTurn(modemPath, `--3gpp-ussd-respond=${ussdResponse}`, runCli);
}

export async function cancelUssd(
	modemPath: string,
	runCli: UssdCliRunner = defaultUssdRunner,
): Promise<UssdCancelResult> {
	if (!MODEM_PATH_RE.test(modemPath)) {
		return { ok: false, reason: "unknown_modem" };
	}
	try {
		await runCli(["-m", modemPath, "--3gpp-ussd-cancel"]);
		return { ok: true };
	} catch (err) {
		return { ok: false, reason: await classifyFailure(modemPath, err, runCli) };
	}
}
