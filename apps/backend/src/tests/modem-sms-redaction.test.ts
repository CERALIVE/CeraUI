/*
 * Read-only SMS inbox — redaction proof.
 *
 * An SMS body is a credential class in practice: the bench SIM's own inbox
 * contains a literal "Tu pin es: 9113", and the sender number identifies the
 * subscriber. Neither may reach ANY transport, so this drives the REAL logger
 * (via its capture ring, which sits downstream of `redact()`) rather than
 * asserting on a mock.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
	clearRecentLogLines,
	getRecentLogLines,
	isSmsSensitiveKey,
	logger,
	logRedact,
	REDACTED,
} from "../helpers/logger.ts";
import {
	legacySmsNormalizer,
	parseSmsRecord,
	readSmsInbox,
} from "../modules/modems/mmcli-sms.ts";
import { setSmsNormalizerForTest } from "../modules/modems/sms-port.ts";
import { isParseError, logParseError } from "../modules/system/cli-parse.ts";

const BODY = "Tu pin es: 9113 - responde STOP";
const SENDER = "+573001112233";

const LEAKY_RECORD = [
	"sms.dbus-path      : /org/freedesktop/ModemManager1/SMS/36",
	`sms.content.number : ${SENDER}`,
	`sms.content.text   : ${BODY}`,
	"sms.properties.state : received",
].join("\n");

function expectNoContent(haystack: string, where: string): void {
	for (const secret of [BODY, SENDER, "9113"]) {
		if (haystack.includes(secret)) {
			throw new Error(`${where} leaked SMS content: ${secret}`);
		}
	}
}

describe("isSmsSensitiveKey — anchored, not substring", () => {
	it("matches the keys that genuinely name message content or a sender", () => {
		for (const key of [
			"smsText",
			"sms_text",
			"sms-body",
			"smsFrom",
			"smsSender",
			"smsNumber",
			"messageText",
			"msisdn",
			"sender",
			"sms.content.text",
			"sms.content.number",
		]) {
			expect(isSmsSensitiveKey(key)).toBe(true);
		}
	});

	it("does NOT over-redact ordinary keys a substring rule would eat", () => {
		for (const key of [
			"smsCount",
			"smsSupported",
			"from",
			"text",
			"number",
			"timestamp",
			"state",
		]) {
			expect(isSmsSensitiveKey(key)).toBe(false);
		}
	});
});

describe("logRedact — SMS metadata never survives", () => {
	it("scrubs message text and sender by key", () => {
		const redacted = logRedact({
			modem: "2",
			smsCount: 3,
			smsText: BODY,
			smsFrom: SENDER,
			nested: { messageText: BODY, msisdn: SENDER },
		}) as Record<string, unknown>;

		expect(redacted.smsText).toBe(REDACTED);
		expect(redacted.smsFrom).toBe(REDACTED);
		expect(redacted.smsCount).toBe(3);
		expect(redacted.modem).toBe("2");
		expectNoContent(JSON.stringify(redacted), "logRedact");
	});

	it("scrubs a raw mmcli SMS record that arrives as a bare string value", () => {
		const redacted = logRedact({ output: LEAKY_RECORD }) as Record<
			string,
			unknown
		>;
		expect(redacted.output).toBe(REDACTED);
		expectNoContent(JSON.stringify(redacted), "logRedact value-shape");
	});
});

describe("the REAL logger emits no SMS content", () => {
	beforeEach(() => {
		clearRecentLogLines();
	});

	it("scrubs an SMS record logged as a free-text message", () => {
		logger.warn(LEAKY_RECORD);
		const emitted = getRecentLogLines().join("\n");
		expect(emitted).toContain(REDACTED);
		expectNoContent(emitted, "logger message");
	});

	it("scrubs SMS metadata attached to an ordinary log line", () => {
		logger.info("mmcli SMS inbox read", {
			modem: "2",
			smsCount: 1,
			smsText: BODY,
			sender: SENDER,
		});
		const emitted = getRecentLogLines().join("\n");
		expect(emitted).toContain("mmcli SMS inbox read");
		expectNoContent(emitted, "logger metadata");
	});

	it("a malformed-record parse error reaches the log with keys only", () => {
		const parsed = parseSmsRecord(
			[`sms.content.number : ${SENDER}`, `sms.content.text   : ${BODY}`].join(
				"\n",
			),
		);
		expect(isParseError(parsed)).toBe(true);
		if (parsed.ok) return;

		logParseError(parsed);
		const emitted = getRecentLogLines().join("\n");
		expect(emitted).toContain("parseSmsRecord");
		expectNoContent(emitted, "parse-error log");
	});
});

describe("the port seam carries the redaction contract too", () => {
	beforeEach(() => {
		clearRecentLogLines();
		setSmsNormalizerForTest(null);
	});

	// The override is process-wide and `bun test` runs one process, so a test
	// that leaves one installed breaks every later FILE, not just this one.
	afterEach(() => {
		setSmsNormalizerForTest(null);
	});

	it("drift reported through the seam reaches the log with keys only", async () => {
		// The seam re-wraps a normalizer's answer as the parse error's `raw`
		// field, which is the one place a body could re-enter a log line that
		// the module is otherwise content-free by construction.
		const result = await readSmsInbox("2", async (args) =>
			args.includes("--messaging-list-sms")
				? "modem.messaging.sms.length : 1\nmodem.messaging.sms.value[1] : /org/freedesktop/ModemManager1/SMS/36"
				: LEAKY_RECORD.replace("sms.dbus-path      :", "sms.drifted-path   :"),
		);

		expect(result).toEqual({ ok: false, reason: "read_failed" });
		const emitted = getRecentLogLines().join("\n");
		expect(emitted).toContain("parseSmsRecord");
		expectNoContent(emitted, "seam parse-error log");
	});

	it("a successful read logs a COUNT and never a body", async () => {
		const result = await readSmsInbox("2", async (args) =>
			args.includes("--messaging-list-sms")
				? "modem.messaging.sms.length : 1\nmodem.messaging.sms.value[1] : /org/freedesktop/ModemManager1/SMS/36"
				: LEAKY_RECORD,
		);

		expect(result.ok).toBe(true);
		expectNoContent(getRecentLogLines().join("\n"), "successful-read log");
	});

	it("a PORT-side normalizer cannot smuggle content into the log either", async () => {
		setSmsNormalizerForTest({
			...legacySmsNormalizer,
			source: "port",
			parseRecord: () => ({
				ok: false,
				reason: "drift",
				// A hostile/naive port answering with the body itself must still be
				// caught by the logger's value-side backstop.
				detail: LEAKY_RECORD,
			}),
		});

		const result = await readSmsInbox("2", async (args) =>
			args.includes("--messaging-list-sms")
				? "modem.messaging.sms.length : 1\nmodem.messaging.sms.value[1] : /org/freedesktop/ModemManager1/SMS/36"
				: LEAKY_RECORD,
		);

		expect(result).toEqual({ ok: false, reason: "read_failed" });
		expectNoContent(getRecentLogLines().join("\n"), "hostile-port log");
	});
});
