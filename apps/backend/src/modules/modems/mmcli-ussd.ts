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
 * THE REPLY FRAMING IS NOW MEASURED, not guessed. BLOCKER B4 is resolved by a
 * live `*611#` dialogue on the bench (Movistar Colombia, MM 1.24.2): an action
 * prints `… new reply from network: '<raw text>'`, and `-K --3gpp-ussd-status`
 * keys the same text `modem.3gpp.ussd.network-request` — mmcli uses the word
 * "reply" as a key NOWHERE. `--3gpp-ussd-respond` additionally prints an EMPTY
 * reply and delivers the real text asynchronously to the D-Bus property, so the
 * status read is not a nicety on that path but the only source there is. An
 * unrecognised shape still yields NO reply rather than a guess — the session
 * state advances from the modem's own status either way, so a missed reply
 * degrades the render, never the state machine.
 */

import type { UssdRefusal } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import {
	handleMmcliCommand,
	shouldMockModems,
} from "../../mocks/providers/modems.ts";
import { describeCliError } from "../system/cli-parse.ts";
import {
	MODEM_PATH_RE,
	mmcliBinary,
	mmcliParseSep,
	mmcliUnescapeValue,
} from "./mmcli.ts";
import type { UssdRepliedState } from "./ussd-session.ts";

/** What the modem says about its own USSD surface right now. */
export type UssdStatus = {
	/** Did the modem answer a USSD status read at all? */
	readonly supported: boolean;
	readonly sessionState: UssdRepliedState;
	/**
	 * The network's own text, from the modem's retained D-Bus property.
	 *
	 * This is the ONLY source for a `respond` turn's reply: mmcli prints an EMPTY
	 * one on stdout there and the text lands asynchronously in the property, so a
	 * stdout-only parser is structurally insufficient however its keys are matched.
	 */
	readonly networkRequest?: string;
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
 * The ONE framing mmcli uses for an action's reply, measured rather than assumed.
 *
 * `--3gpp-ussd-initiate` prints `USSD session initiated; new reply from network:
 * '<text>'` and `--3gpp-ussd-respond` prints `response successfully sent in USSD
 * session; new reply from network: '<text>'`. The text is RAW, so a menu spans
 * real newlines and the quoted run is closed by the LAST `'` in the output —
 * hence `[\s\S]` and a greedy body, so a carrier apostrophe cannot truncate it.
 */
const HUMAN_REPLY_RE = /new reply from network:\s*'([\s\S]*)'/;

/** `-K` keys that carry the network's text. mmcli names it a *request*. */
const REPLY_KEY_SUFFIXES = ["network-request", "reply"] as const;

/**
 * Extract the carrier's reply from an mmcli action's output.
 *
 * NEVER logs, and never reports the raw output on a miss — every line here is
 * carrier text. Returns `undefined` when no recognised shape carries text.
 *
 * WHY BOTH SHAPES, and why the retired pair matched NEITHER. This parser
 * previously accepted a literal `reply:` line or a `-K` key ending in `reply`.
 * Board-measured against a real `*611#` dialogue: the human line's key is the
 * whole sentence `USSD session initiated; new reply from network`, and the `-K`
 * key is `modem.3gpp.ussd.network-request` — mmcli uses the word "reply" as a
 * KEY nowhere at all, so every real carrier answer parsed to `undefined` and the
 * session advanced with no text to render. The legacy `reply` suffix is retained
 * only so a future mmcli that does spell it that way is not a regression.
 */
export function parseUssdReply(raw: string): string | undefined {
	const human = HUMAN_REPLY_RE.exec(raw)?.[1];
	if (human !== undefined) return human === "" ? undefined : human;
	return parseUssdNetworkRequest(raw);
}

/**
 * Extract the network's text from a `-K --3gpp-ussd-status` read.
 *
 * Key-form only, deliberately: this output is machine-framed, and letting the
 * human-sentence pattern loose on it would let carrier text that happens to
 * quote that sentence be mistaken for the framing around it.
 *
 * It does NOT route through `mmcliParseSep`, for this module's standing reason —
 * that parser logs an unsplittable line VERBATIM, and every value here is
 * carrier text.
 */
export function parseUssdNetworkRequest(raw: string): string | undefined {
	for (const line of raw.split("\n")) {
		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		const key = line.slice(0, separator).trim().toLowerCase();
		if (!key.startsWith("modem.3gpp.ussd.")) continue;
		if (!REPLY_KEY_SUFFIXES.some((suffix) => key.endsWith(suffix))) continue;
		const value = line.slice(separator + 1).trim();
		if (value === "" || value === "--") continue;
		// `-K` values are g_strescape()d, so a multi-line menu arrives as the
		// literal characters of its escapes and must be rebuilt byte-wise.
		return mmcliUnescapeValue(value.replace(/^'(.*)'$/s, "$1"));
	}
	return undefined;
}

export type UssdCliRunner = (args: string[]) => Promise<string>;

/**
 * How long a turn waits for the network's ASYNCHRONOUS answer, and how often it
 * looks. Both are derived from a measured `*611#` dialogue on bench `ceralive2`
 * (Movistar Colombia, MM 1.24.2, 2026-08-18):
 *
 *   21:27:56.894  --3gpp-ussd-respond=4 dispatched
 *   21:27:56.954  returned — 60 ms, reply EMPTY
 *   21:27:56.958  status: idle,          request = the PREVIOUS turn's menu
 *   21:27:57.238  status: idle,          request = the PREVIOUS turn's menu
 *   21:27:57.524  status: user-response, request = this turn's answer   (+570 ms)
 *
 * So `respond` does not block on the network at all. Reading the status once,
 * immediately, is wrong TWICE OVER: the state is transiently `idle`, so a live
 * dialogue is reported closed, and the retained property still holds the
 * previous turn's text, so that text is served as this turn's reply — a
 * plausible, wrong menu, which is worse than no menu. `initiate` is different:
 * it BLOCKS (2.2 s measured) and prints the reply on stdout.
 *
 * 8 s is ~14x the measured arrival and bounds the case where no answer comes.
 */
const REPLY_WAIT_MS = 8_000;
const REPLY_POLL_MS = 250;

/** Injectable clock so the wait above is provable without spending it. */
export type UssdWaitDeps = {
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

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
	const networkRequest = parseUssdNetworkRequest(stdout);
	return {
		ok: true,
		status: {
			supported: true,
			sessionState: decodeUssdSessionState(token),
			...(networkRequest === undefined ? {} : { networkRequest }),
		},
	};
}

/**
 * Poll the modem until the network's answer to the turn just dispatched lands.
 *
 * ARRIVAL IS DETECTED TWO WAYS, and the second is not redundant. The text
 * CHANGING is the primary signal. But a menu can legitimately repeat itself —
 * answering `00:inicio` re-serves the root menu byte-identically — and a
 * text-only test would then wait out the whole bound and report no reply for a
 * turn the network answered. The measured transient covers it: the state dips to
 * `idle` while the answer is in flight and leaves it when the answer lands, so
 * an observed `idle → not-idle` edge is arrival independent of the text.
 */
async function awaitNetworkAnswer(
	modemPath: string,
	runCli: UssdCliRunner,
	priorText: string | undefined,
	wait: UssdWaitDeps,
): Promise<UssdStatusResult> {
	const now = wait.now ?? Date.now;
	const sleep = wait.sleep ?? defaultSleep;
	const deadline = now() + REPLY_WAIT_MS;
	let sawIdle = false;
	let latest = await readUssdStatus(modemPath, runCli);
	while (true) {
		if (latest.ok) {
			const text = latest.status.networkRequest;
			if (text !== undefined && text !== priorText) return latest;
			if (latest.status.sessionState === "released") sawIdle = true;
			else if (sawIdle) return latest;
		}
		if (now() >= deadline) return latest;
		await sleep(REPLY_POLL_MS);
		latest = await readUssdStatus(modemPath, runCli);
	}
}

async function runTurn(
	modemPath: string,
	flag: string,
	runCli: UssdCliRunner,
	wait: UssdWaitDeps = {},
): Promise<UssdTurnResult> {
	if (!MODEM_PATH_RE.test(modemPath)) {
		return { ok: false, reason: "unknown_modem" };
	}

	// Read BEFORE dispatching: the property is retained across turns and even
	// across a cancel, so the value already in it is the only thing that can tell
	// this turn's answer apart from the last one's.
	const before = await readUssdStatus(modemPath, runCli);
	const priorText = before.ok ? before.status.networkRequest : undefined;

	let stdout: string;
	try {
		stdout = await runCli(["-m", modemPath, flag]);
	} catch (err) {
		return { ok: false, reason: await classifyFailure(modemPath, err, runCli) };
	}

	// stdout FIRST, and when it carries text the turn is already settled — only
	// the blocking `initiate` answers that way, so nothing is left in flight.
	const printed = parseUssdReply(stdout);
	const status =
		printed === undefined
			? await awaitNetworkAnswer(modemPath, runCli, priorText, wait)
			: await readUssdStatus(modemPath, runCli);

	const answered = status.ok ? status.status.networkRequest : undefined;
	// A property that never moved is the PREVIOUS turn's answer, not this one's.
	const ussdReply = printed ?? (answered === priorText ? undefined : answered);

	// The modem's OWN post-call state decides whether the dialogue continues —
	// never the presence or absence of reply text.
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
	wait: UssdWaitDeps = {},
): Promise<UssdTurnResult> {
	return runTurn(
		modemPath,
		`--3gpp-ussd-initiate=${ussdCommand}`,
		runCli,
		wait,
	);
}

export function respondUssd(
	modemPath: string,
	ussdResponse: string,
	runCli: UssdCliRunner = defaultUssdRunner,
	wait: UssdWaitDeps = {},
): Promise<UssdTurnResult> {
	return runTurn(
		modemPath,
		`--3gpp-ussd-respond=${ussdResponse}`,
		runCli,
		wait,
	);
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
