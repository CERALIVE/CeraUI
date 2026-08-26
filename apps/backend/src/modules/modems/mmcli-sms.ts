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
 * Read-only SMS inbox, over the existing allowlisted mmcli runner.
 *
 * This is the explicit `modem_backend: "mmcli"` rollback reader. The only two
 * verbs used are `--messaging-list-sms` and a per-message `-s <path>` read.
 * There is deliberately no send, no delete, and no store — that is locked by
 * the grep gate in `tests/modem-sms-readonly-gate.test.ts`, not by memory.
 *
 * WHY this module does not reuse `mmcliParseSep` for the per-message record:
 * that parser logs the OFFENDING LINE VERBATIM whenever a line does not split
 * cleanly, so any drift in how mmcli frames a message body would print message
 * text into `debug.log`. The record parser below is therefore its own splitter
 * — content-free logging is a property of the parser, not of its call sites.
 * The LIST parse does reuse `mmcliParseSep`: that output carries only D-Bus
 * object paths.
 *
 * WHY it still shares `mmcliUnescapeValue` with that parser: the escaping is
 * mmcli's, applied to every `-K` value it prints, so the decode is one rule
 * about the CLI rather than anything SMS-specific. Sharing the decoder — but
 * not the splitter — keeps exactly one definition of mmcli's escape grammar
 * without giving up the content-free splitting above.
 */

import { logger } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import {
	handleMmcliCommand,
	shouldMockModems,
} from "../../mocks/providers/modems.ts";
import {
	describeCliError,
	logParseError,
	type ParseResult,
	parseFail,
	parseOk,
} from "../system/cli-parse.ts";
import {
	MODEM_PATH_RE,
	mmcliBinary,
	mmcliParseSep,
	mmcliUnescapeValue,
} from "./mmcli.ts";
import {
	resolveSmsNormalizer,
	type SmsNormalizeResult,
	type SmsNormalizer,
} from "./sms-port.ts";

export type SmsState =
	| "unknown"
	| "stored"
	| "receiving"
	| "received"
	| "sending"
	| "sent";

export type SmsMessage = {
	id: string;
	from?: string;
	timestamp?: string;
	text: string;
	state: SmsState;
};

/** Mirrors `modemSmsRefusalSchema` in `@ceraui/rpc`; kept local so this
 *  low-level module carries no dependency on the RPC schema layer. */
export type SmsReadRefusal =
	| "unsupported"
	| "not_enabled"
	| "unknown_modem"
	| "read_failed";

export type SmsInboxResult =
	| { ok: true; messages: SmsMessage[] }
	| { ok: false; reason: SmsReadRefusal };

/** Wire cap. Mirrors `SMS_INBOX_CAP` in `@ceraui/rpc` for the same reason as
 *  {@link SmsReadRefusal}. */
export const SMS_INBOX_CAP = 50;

/**
 * SMS selector grammar accepted by `mmcli -s <path>`.
 *
 * This is the {@link MODEM_PATH_RE} precedent applied to the SMS object tree,
 * and it is a SEPARATE regex on purpose: an entry from `--messaging-list-sms`
 * is `/org/freedesktop/ModemManager1/SMS/N`, which `MODEM_PATH_RE` rejects
 * (its path branch is anchored on `/Modem/`). Reusing the modem regex here
 * would refuse every real inbox.
 */
export const SMS_PATH_RE: RegExp =
	/^(?:\/org\/freedesktop\/ModemManager1\/SMS\/\d+|\d+)$/;

const SMS_LIST_KEY = "modem.messaging.sms";
const SMS_PATH_INDEX_RE = /\/org\/freedesktop\/ModemManager1\/SMS\/(\d+)/;

const KNOWN_SMS_STATES: ReadonlySet<string> = new Set<string>([
	"unknown",
	"stored",
	"receiving",
	"received",
	"sending",
	"sent",
]);

/**
 * Classify an mmcli failure into a refusal the operator can act on.
 *
 * The three recognised strings are mmcli 1.24's own, confirmed on the bench
 * board: a modem with no Messaging interface, a radio that has not come up yet,
 * and a selector nothing answers to. Anything else stays `read_failed` rather
 * than being guessed at.
 */
export function classifySmsCliFailure(description: string): SmsReadRefusal {
	if (/no messaging capabilities/i.test(description)) return "unsupported";
	if (/not enabled yet/i.test(description)) return "not_enabled";
	if (/couldn't find modem|cannot find modem/i.test(description)) {
		return "unknown_modem";
	}
	return "read_failed";
}

/**
 * Extract SMS object paths from `mmcli -K -m <id> --messaging-list-sms`.
 *
 * An inbox with no messages is printed as `modem.messaging.sms: --`, which
 * `mmcliParseSep` drops — so an ABSENT key is a legitimate empty inbox, exactly
 * as it is for `--3gpp-scan` (see `parseNetworkScanResults`), NOT drift. What
 * would be drift, and what fails loud here, is output that never mentions the
 * key at all (a renamed field, an error body reaching this parser): returning an
 * empty inbox from that would report "no messages" for a read that never ran.
 */
export function parseSmsList(raw: string): ParseResult<string[]> {
	const parsed = mmcliParseSep(raw);
	const value = parsed[SMS_LIST_KEY];

	if (value === undefined) {
		if (!raw.includes(SMS_LIST_KEY)) {
			return parseFail(
				"parseSmsList",
				`no ${SMS_LIST_KEY} key in the mmcli output`,
				raw,
			);
		}
		return parseOk([]);
	}

	const entries = Array.isArray(value) ? value : [value];
	const paths = entries.filter((entry) => SMS_PATH_INDEX_RE.test(entry));
	if (entries.length > 0 && paths.length === 0) {
		return parseFail(
			"parseSmsList",
			"no SMS paths matched the ModemManager path grammar",
			entries.join("; "),
		);
	}
	return parseOk(paths);
}

/** The trailing `/SMS/<n>` index, or `Number.NaN` when the path carries none. */
export function smsPathIndex(path: string): number {
	const match = path.match(SMS_PATH_INDEX_RE);
	return match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);
}

/**
 * Parse one `mmcli -K -s <path>` record.
 *
 * CONTENT-FREE BY CONSTRUCTION. Unlike every other parser in this tree it never
 * puts a parsed line into a log or into a `ParseError.raw` — a message body is
 * routinely a one-time code (the bench SIM's inbox contains "Tu pin es: …") and
 * a sender is subscriber-identifying. A malformed record therefore reports the
 * KEY NAMES it did find and nothing else, which is enough to diagnose CLI drift
 * and carries no message content.
 */
export function parseSmsRecord(raw: string): ParseResult<SmsMessage> {
	const fields = new Map<string, string>();
	for (const line of raw.split("\n")) {
		const separator = line.indexOf(":");
		if (separator <= 0) continue;
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();
		if (!key.startsWith("sms.") || value === "" || value === "--") continue;
		// mmcli prints every value through g_strescape, so a message body with
		// one accented letter reaches this splitter as the literal characters
		// `\303\241`. Decoded here, at the single mmcli-parse boundary, so no
		// second decoder is ever needed downstream — the schema's "verbatim"
		// contract is about the SMS, and the escaping is the CLI's, not the
		// carrier's. Decoding after the split for the same reason as in
		// mmcliParseSep: a decoded byte must never forge the `:`.
		fields.set(key, mmcliUnescapeValue(value));
	}

	const dbusPath = fields.get("sms.dbus-path");
	if (dbusPath === undefined) {
		return parseFail(
			"parseSmsRecord",
			"no sms.dbus-path key in the mmcli output",
			[...fields.keys()].join(", "),
		);
	}

	const index = smsPathIndex(dbusPath);
	if (Number.isNaN(index)) {
		return parseFail(
			"parseSmsRecord",
			"sms.dbus-path did not match the ModemManager path grammar",
			[...fields.keys()].join(", "),
		);
	}

	const rawState = fields.get("sms.properties.state");
	const state: SmsState =
		rawState !== undefined && KNOWN_SMS_STATES.has(rawState)
			? (rawState as SmsState)
			: "unknown";

	const from = fields.get("sms.content.number");
	const timestamp = fields.get("sms.properties.timestamp");

	return parseOk({
		id: String(index),
		...(from !== undefined ? { from } : {}),
		...(timestamp !== undefined ? { timestamp } : {}),
		// A data-only (WAP/PDU) message has no text at all; "" says so honestly.
		text: fields.get("sms.content.text") ?? "",
		state,
	});
}

/**
 * mmcli prints the service-centre timestamp with an HOURS-ONLY UTC offset —
 * `2025-08-21T17:20:16-05`, verbatim from the bench board. That is not valid
 * ISO 8601, and `Date.parse` returns NaN for it. Left unhandled, EVERY message
 * scores as undated and "newest first" silently degrades to object-index order,
 * which is the one ordering this module explicitly must not trust. The offset is
 * therefore widened to `-05:00` before parsing; the anchor requires a full
 * `T??:??:??` time in front of it so a bare `YYYY-MM-DD` is never mangled.
 */
const HOURS_ONLY_OFFSET_RE = /(T\d{2}:\d{2}:\d{2})([+-]\d{2})$/;

export function smsTimestampEpoch(timestamp: string): number {
	const parsedTime = Date.parse(
		timestamp.replace(HOURS_ONLY_OFFSET_RE, "$1$2:00"),
	);
	return Number.isNaN(parsedTime) ? Number.NEGATIVE_INFINITY : parsedTime;
}

/**
 * Newest first, then capped.
 *
 * Sorted on the carrier timestamp because the object index is only a proxy for
 * arrival order — ModemManager reuses freed indices, so a re-enumerated inbox
 * can hand back a low index for the newest message. A message with no (or an
 * unparseable) timestamp sorts LAST rather than first: promoting an undated
 * message to the top of a "newest first" list would be a claim the device
 * cannot support. Ties fall back to the index, descending.
 */
export function sortAndCapSms(
	messages: SmsMessage[],
	cap = SMS_INBOX_CAP,
): SmsMessage[] {
	const epoch = (message: SmsMessage): number =>
		message.timestamp === undefined
			? Number.NEGATIVE_INFINITY
			: smsTimestampEpoch(message.timestamp);

	return [...messages]
		.sort((a, b) => {
			const delta = epoch(b) - epoch(a);
			if (delta !== 0 && !Number.isNaN(delta)) return delta;
			return Number(b.id) - Number(a.id);
		})
		.slice(0, cap);
}

/**
 * The paths worth reading: the {@link SMS_INBOX_CAP} highest-indexed, each of
 * which must match the path grammar before it can reach mmcli as a selector.
 */
export function selectReadableSmsPaths(paths: readonly string[]): string[] {
	return [...paths]
		.sort((a, b) => smsPathIndex(b) - smsPathIndex(a))
		.slice(0, SMS_INBOX_CAP)
		.filter((path) => SMS_PATH_RE.test(path));
}

/** Fold a fail-loud {@link ParseResult} onto the seam's content-free shape. */
function toNormalizeResult<T>(result: ParseResult<T>): SmsNormalizeResult<T> {
	return result.ok
		? { ok: true, value: result.value }
		: { ok: false, reason: result.reason, detail: result.raw };
}

/**
 * This backend's own parsers, expressed as the seam's normalizer.
 *
 * It is the PARITY ORACLE the port is measured against, and that is now its only
 * role: the `1.3.0` pin carries the port, so nothing falls back to it. Deleting
 * it would delete the differential — see `sms-port.ts`.
 */
export const legacySmsNormalizer: SmsNormalizer = {
	source: "legacy",
	cap: SMS_INBOX_CAP,
	parseList: (raw) => toNormalizeResult(parseSmsList(raw)),
	parseRecord: (raw) => toNormalizeResult(parseSmsRecord(raw)),
	classifyFailure: classifySmsCliFailure,
	selectPaths: selectReadableSmsPaths,
	sortAndCap: (messages) => sortAndCapSms([...messages]),
};

/**
 * The one CLI seam this module talks through.
 *
 * Injectable because `run()` cannot be reliably spied under Bun 1.3.14's ESM
 * re-export binding (the same limit `mmcli.parsers.test.ts` records), and the
 * behaviours worth pinning here — abort-on-drift, ZERO retries, the read cap —
 * are properties of the call SEQUENCE, not of any one parser.
 */
export type SmsCliRunner = (args: string[]) => Promise<string>;

const defaultSmsRunner: SmsCliRunner = async (args) => {
	if (shouldMockModems()) {
		const mockOutput = handleMmcliCommand(args);
		if (mockOutput) return mockOutput;
	}
	return await run(mmcliBinary, args);
};

/**
 * Report normalization drift WITHOUT the offending output.
 *
 * `logParseError` renders a bounded slice of the raw text, which for an SMS
 * record is the message body. Both normalizers answer with key names only, so
 * this re-wraps that answer as the `raw` field — the drift is still diagnosable
 * and no content can reach `debug.log`.
 */
function logSmsNormalizeError(
	parser: string,
	result: { readonly reason: string; readonly detail: string },
): void {
	logParseError(parseFail(parser, result.reason, result.detail));
}

async function readSmsRecord(
	normalize: SmsNormalizer,
	runCli: SmsCliRunner,
	modemPath: string,
	smsPath: string,
): Promise<SmsNormalizeResult<SmsMessage> | undefined> {
	let stdout: string;
	try {
		stdout = await runCli(["-K", "-m", modemPath, "-s", smsPath]);
	} catch (err) {
		// A message that vanished between the list and this read is ordinary
		// (the modem's own storage rotates), so it is SKIPPED rather than failing
		// the whole inbox. describeCliError is safe here: mmcli's error text for a
		// missing SMS names the path, never the content.
		logger.warn(
			`mmcli SMS read skipped for ${smsPath}: ${describeCliError(err)}`,
		);
		return undefined;
	}
	return normalize.parseRecord(stdout);
}

/**
 * Read a modem's stored inbox, newest-first and capped.
 *
 * Bounded by construction: the list is reduced to the {@link SMS_INBOX_CAP}
 * highest-indexed paths BEFORE any per-message read, so a modem holding several
 * hundred stored messages still costs at most 50 mmcli invocations.
 *
 * Fail-loud, zero retries: a record whose `-K` output does not parse aborts the
 * whole read with `read_failed` (a parser that has drifted has drifted for every
 * record, so returning the ones that happened to parse would be a partial lie),
 * and nothing here is ever re-attempted.
 */
export async function readSmsInbox(
	modemPath: string,
	runCli: SmsCliRunner = defaultSmsRunner,
): Promise<SmsInboxResult> {
	if (!MODEM_PATH_RE.test(modemPath)) {
		logger.warn("readSmsInbox: rejected invalid modem path shape");
		return { ok: false, reason: "unknown_modem" };
	}

	const normalize = resolveSmsNormalizer();

	let listOutput: string;
	try {
		listOutput = await runCli(["-K", "-m", modemPath, "--messaging-list-sms"]);
	} catch (err) {
		const description = describeCliError(err);
		const reason = normalize.classifyFailure(description);
		logger.warn(`mmcli SMS list failed for modem ${modemPath}: ${reason}`);
		return { ok: false, reason };
	}

	const list = normalize.parseList(listOutput);
	if (!list.ok) {
		logSmsNormalizeError("parseSmsList", list);
		return { ok: false, reason: "read_failed" };
	}

	const candidates = normalize.selectPaths(list.value);

	const messages: SmsMessage[] = [];
	for (const smsPath of candidates) {
		const record = await readSmsRecord(normalize, runCli, modemPath, smsPath);
		if (record === undefined) continue;
		if (!record.ok) {
			logSmsNormalizeError("parseSmsRecord", record);
			return { ok: false, reason: "read_failed" };
		}
		messages.push(record.value);
	}

	logger.debug(
		`mmcli SMS inbox for modem ${modemPath}: ${messages.length} message(s)`,
	);
	return { ok: true, messages: normalize.sortAndCap(messages) };
}
