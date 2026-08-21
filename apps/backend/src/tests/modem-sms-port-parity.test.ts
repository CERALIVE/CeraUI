/*
 * The migrate-then-remove gate for the read-only SMS inbox.
 *
 * WHY THE PARITY IS EXPRESSED THROUGH GOLDEN VALUES RATHER THAN AN IMPORT.
 * Rule D forbids this repo from reaching into the sibling `modem-stack`
 * checkout, and the pinned `@ceralive/modem-control` release predates the SMS
 * port — so there is no build in which BOTH implementations are importable at
 * once, and a differential that ran them side by side could not exist. What CAN
 * exist, and is strictly as strong, is a SHARED SET OF GOLDEN VALUES: every
 * fixture and every expectation below is byte-identical to the one
 * `modem-stack`'s `control/src/sms/parse.test.ts` pins for the port. Either side
 * drifting reddens a test on both sides.
 *
 * The fixtures themselves are VERBATIM `mmcli 1.24.2 -K` output captured from
 * the bench board (Quectel RM530N-GL), bodies replaced with neutral copy.
 *
 * The second half of this file proves the SEAM: `readSmsInbox` really does route
 * its normalization through whatever `resolveSmsNormalizer` answers, so the day
 * the pin carries the port the switch is a pin bump and not a rewrite.
 */

import { afterEach, describe, expect, it } from "bun:test";

import {
	classifySmsCliFailure,
	legacySmsNormalizer,
	parseSmsList,
	parseSmsRecord,
	readSmsInbox,
	SMS_INBOX_CAP,
	SMS_PATH_RE,
	type SmsMessage,
	selectReadableSmsPaths,
	smsTimestampEpoch,
	sortAndCapSms,
} from "../modules/modems/mmcli-sms.ts";
import {
	type SmsNormalizer,
	setSmsNormalizerForTest,
} from "../modules/modems/sms-port.ts";

const POPULATED_LIST = [
	"modem.messaging.sms.length    : 3",
	"modem.messaging.sms.value[1]  : /org/freedesktop/ModemManager1/SMS/36",
	"modem.messaging.sms.value[2]  : /org/freedesktop/ModemManager1/SMS/35",
	"modem.messaging.sms.value[3]  : /org/freedesktop/ModemManager1/SMS/0",
].join("\n");

const EMPTY_LIST = "modem.messaging.sms           : --";

const RECORD = [
	"sms.dbus-path                      : /org/freedesktop/ModemManager1/SMS/36",
	"sms.content.number                 : 85573",
	"sms.content.text                   : Neutral fixture body with a colon: and more",
	"sms.content.data                   : --",
	"sms.properties.pdu-type            : deliver",
	"sms.properties.state               : received",
	"sms.properties.validity            : --",
	"sms.properties.storage             : me",
	"sms.properties.smsc                : +573103154363",
	"sms.properties.class               : --",
	"sms.properties.timestamp           : 2025-08-21T17:20:16-05",
	"sms.properties.delivery-state      : --",
].join("\n");

const message = (id: string, timestamp?: string): SmsMessage => ({
	id,
	text: `body ${id}`,
	state: "received",
	...(timestamp !== undefined ? { timestamp } : {}),
});

afterEach(() => {
	setSmsNormalizerForTest(null);
});

describe("golden values shared with the modem-stack SMS port", () => {
	it("the list parse yields the same three paths", () => {
		const result = parseSmsList(POPULATED_LIST);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual([
				"/org/freedesktop/ModemManager1/SMS/36",
				"/org/freedesktop/ModemManager1/SMS/35",
				"/org/freedesktop/ModemManager1/SMS/0",
			]);
		}
	});

	it("a `--` list is the same EMPTY inbox on both sides", () => {
		const result = parseSmsList(EMPTY_LIST);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toEqual([]);
	});

	it("the record parse yields the same message", () => {
		const result = parseSmsRecord(RECORD);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({
				id: "36",
				from: "85573",
				text: "Neutral fixture body with a colon: and more",
				timestamp: "2025-08-21T17:20:16-05",
				state: "received",
			});
		}
	});

	it("the hours-only offset widens identically", () => {
		expect(smsTimestampEpoch("2025-08-21T17:20:16-05")).toBe(
			Date.parse("2025-08-21T17:20:16-05:00"),
		);
		expect(smsTimestampEpoch("2025-08-21")).toBe(Date.parse("2025-08-21"));
		expect(smsTimestampEpoch("not a timestamp")).toBe(Number.NEGATIVE_INFINITY);
	});

	it("ordering, the undated rule, and the tie-break agree", () => {
		expect(
			sortAndCapSms([
				message("1", "2025-08-21T10:00:00-05"),
				message("99", "2025-08-20T10:00:00-05"),
				message("50", "2025-08-22T10:00:00-05"),
			]).map((entry) => entry.id),
		).toEqual(["50", "1", "99"]);

		expect(
			sortAndCapSms([message("5"), message("1", "2025-08-21T10:00:00-05")]).map(
				(entry) => entry.id,
			),
		).toEqual(["1", "5"]);

		const stamp = "2025-08-21T10:00:00-05";
		expect(
			sortAndCapSms([
				message("3", stamp),
				message("9", stamp),
				message("7", stamp),
			]).map((entry) => entry.id),
		).toEqual(["9", "7", "3"]);
	});

	it("the cap is 50 on both sides, and it bounds the candidate list", () => {
		expect(SMS_INBOX_CAP).toBe(50);
		const paths = Array.from(
			{ length: 120 },
			(_, index) => `/org/freedesktop/ModemManager1/SMS/${index}`,
		);
		const selected = selectReadableSmsPaths(paths);
		expect(selected).toHaveLength(50);
		expect(selected[0]).toBe("/org/freedesktop/ModemManager1/SMS/119");
		expect(
			selectReadableSmsPaths([
				"/org/freedesktop/ModemManager1/SMS/1; rm -rf /",
			]),
		).toEqual([]);
	});

	it("the path grammar accepts and refuses the same strings", () => {
		expect(SMS_PATH_RE.test("/org/freedesktop/ModemManager1/SMS/36")).toBe(
			true,
		);
		expect(SMS_PATH_RE.test("36")).toBe(true);
		for (const hostile of [
			"--send",
			"36; rm -rf /",
			"/org/freedesktop/ModemManager1/Modem/0",
			"",
			"/org/freedesktop/ModemManager1/SMS/",
		]) {
			expect(SMS_PATH_RE.test(hostile)).toBe(false);
		}
	});

	it("the four refusals classify identically", () => {
		expect(
			classifySmsCliFailure("error: modem has no messaging capabilities"),
		).toBe("unsupported");
		expect(classifySmsCliFailure("error: modem not enabled yet")).toBe(
			"not_enabled",
		);
		expect(classifySmsCliFailure("couldn't find modem 'nope'")).toBe(
			"unknown_modem",
		);
		expect(classifySmsCliFailure("something else entirely")).toBe(
			"read_failed",
		);
	});
});

describe("the migration seam is real, in both directions", () => {
	it("the legacy normalizer reproduces the module's own answers", () => {
		expect(legacySmsNormalizer.source).toBe("legacy");
		expect(legacySmsNormalizer.cap).toBe(SMS_INBOX_CAP);
		expect(legacySmsNormalizer.parseList(POPULATED_LIST)).toEqual({
			ok: true,
			value: [
				"/org/freedesktop/ModemManager1/SMS/36",
				"/org/freedesktop/ModemManager1/SMS/35",
				"/org/freedesktop/ModemManager1/SMS/0",
			],
		});
		expect(legacySmsNormalizer.parseRecord(RECORD).ok).toBe(true);
		expect(
			legacySmsNormalizer.classifyFailure("error: modem not enabled yet"),
		).toBe("not_enabled");
	});

	it("readSmsInbox routes EVERY normalization step through the resolved port", async () => {
		const seen: string[] = [];
		const spy: SmsNormalizer = {
			source: "port",
			cap: SMS_INBOX_CAP,
			parseList: (raw) => {
				seen.push("parseList");
				return legacySmsNormalizer.parseList(raw);
			},
			parseRecord: (raw) => {
				seen.push("parseRecord");
				return legacySmsNormalizer.parseRecord(raw);
			},
			classifyFailure: (description) => {
				seen.push("classifyFailure");
				return legacySmsNormalizer.classifyFailure(description);
			},
			selectPaths: (paths) => {
				seen.push("selectPaths");
				return legacySmsNormalizer.selectPaths(paths);
			},
			sortAndCap: (messages) => {
				seen.push("sortAndCap");
				return legacySmsNormalizer.sortAndCap(messages);
			},
		};
		setSmsNormalizerForTest(spy);

		const result = await readSmsInbox("2", async (args) =>
			args.includes("--messaging-list-sms") ? POPULATED_LIST : RECORD,
		);

		expect(result.ok).toBe(true);
		expect(seen).toEqual([
			"parseList",
			"selectPaths",
			"parseRecord",
			"parseRecord",
			"parseRecord",
			"sortAndCap",
		]);
	});

	it("a port-side refusal is the refusal the operator is told about", async () => {
		setSmsNormalizerForTest({
			...legacySmsNormalizer,
			source: "port",
			classifyFailure: () => "unsupported",
		});

		const result = await readSmsInbox("2", async () => {
			throw new Error("anything at all");
		});
		expect(result).toEqual({ ok: false, reason: "unsupported" });
	});

	it("the resolved normalizer produces the SAME inbox as the legacy one", async () => {
		const run = async (args: readonly string[]): Promise<string> =>
			args.includes("--messaging-list-sms") ? POPULATED_LIST : RECORD;

		setSmsNormalizerForTest(null);
		const viaResolved = await readSmsInbox("2", run);

		setSmsNormalizerForTest(legacySmsNormalizer);
		const viaLegacy = await readSmsInbox("2", run);

		expect(viaResolved).toEqual(viaLegacy);
	});
});
