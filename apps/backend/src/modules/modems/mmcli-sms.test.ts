/*
 * Read-only SMS inbox — parser + ordering contract.
 *
 * Fixtures are VERBATIM `mmcli 1.24.2 -K` output captured from the bench board
 * (Quectel RM530N-GL, 37 stored messages), with the message bodies replaced by
 * neutral copy. Everything about the SHAPE — key names, the `--` empties, the
 * `modem.messaging.sms.length` / `.value[N]` array form, the `-05`-offset
 * timestamp, the alphanumeric sender — is the real thing, because that shape is
 * the whole subject of these tests.
 */

import { describe, expect, it } from "bun:test";

import { isParseError } from "../system/cli-parse.ts";
import { MODEM_PATH_RE } from "./mmcli.ts";
import {
	classifySmsCliFailure,
	parseSmsList,
	parseSmsRecord,
	readSmsInbox,
	SMS_INBOX_CAP,
	SMS_PATH_RE,
	type SmsMessage,
	smsPathIndex,
	smsTimestampEpoch,
	sortAndCapSms,
} from "./mmcli-sms.ts";

const POPULATED_LIST = [
	"modem.messaging.sms.length    : 3",
	"modem.messaging.sms.value[1]  : /org/freedesktop/ModemManager1/SMS/36",
	"modem.messaging.sms.value[2]  : /org/freedesktop/ModemManager1/SMS/35",
	"modem.messaging.sms.value[3]  : /org/freedesktop/ModemManager1/SMS/0",
].join("\n");

// mmcli renders an empty list the same way it renders an empty `--3gpp-scan`:
// the key is present with a `--` value, which mmcliParseSep drops.
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

function message(id: string, timestamp?: string): SmsMessage {
	return {
		id,
		text: `body ${id}`,
		state: "received",
		...(timestamp !== undefined ? { timestamp } : {}),
	};
}

describe("parseSmsList — SMS object paths", () => {
	it("extracts every path from a populated inbox listing", () => {
		const r = parseSmsList(POPULATED_LIST);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value).toEqual([
				"/org/freedesktop/ModemManager1/SMS/36",
				"/org/freedesktop/ModemManager1/SMS/35",
				"/org/freedesktop/ModemManager1/SMS/0",
			]);
		}
	});

	it("treats a `--` list as a genuinely empty inbox, not drift", () => {
		const r = parseSmsList(EMPTY_LIST);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value).toEqual([]);
	});

	it("fails loud when the output never mentions the sms list key (drift)", () => {
		const r = parseSmsList("modem.generic.state : connected");
		expect(isParseError(r)).toBe(true);
		if (!r.ok) expect(r.reason).toContain("modem.messaging.sms");
	});

	it("fails loud when entries match no SMS path grammar (drift)", () => {
		const r = parseSmsList(
			[
				"modem.messaging.sms.length    : 1",
				"modem.messaging.sms.value[1]  : totally-different-format",
			].join("\n"),
		);
		expect(isParseError(r)).toBe(true);
		if (!r.ok) expect(r.reason).toContain("path grammar");
	});
});

describe("SMS_PATH_RE — the MODEM_PATH_RE precedent, retargeted", () => {
	it("accepts a real SMS object path and a bare index", () => {
		expect(SMS_PATH_RE.test("/org/freedesktop/ModemManager1/SMS/36")).toBe(
			true,
		);
		expect(SMS_PATH_RE.test("36")).toBe(true);
	});

	it("is REQUIRED because MODEM_PATH_RE rejects every SMS path", () => {
		// The precision note this whole regex exists for: an /SMS/N path is not a
		// bare numeric id, and the modem regex's path branch is anchored on
		// /Modem/, so reusing it would refuse every message on the device.
		expect(MODEM_PATH_RE.test("/org/freedesktop/ModemManager1/SMS/36")).toBe(
			false,
		);
	});

	it("rejects anything that could escape the argv boundary", () => {
		for (const hostile of [
			"--send",
			"-s",
			"36; rm -rf /",
			"/org/freedesktop/ModemManager1/SMS/36 --delete",
			"",
		]) {
			expect(SMS_PATH_RE.test(hostile)).toBe(false);
		}
	});
});

describe("parseSmsRecord — one stored message", () => {
	it("parses the real -K record shape", () => {
		const r = parseSmsRecord(RECORD);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value.id).toBe("36");
			expect(r.value.from).toBe("85573");
			expect(r.value.timestamp).toBe("2025-08-21T17:20:16-05");
			expect(r.value.state).toBe("received");
			expect(r.value.text).toBe("Neutral fixture body with a colon: and more");
		}
	});

	it("keeps an alphanumeric sender id verbatim", () => {
		const r = parseSmsRecord(
			RECORD.replace(
				"sms.content.number                 : 85573",
				"sms.content.number : CLARO",
			),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value.from).toBe("CLARO");
	});

	it("omits `from` and `timestamp` when mmcli printed `--`", () => {
		const r = parseSmsRecord(
			[
				"sms.dbus-path                 : /org/freedesktop/ModemManager1/SMS/7",
				"sms.content.number            : --",
				"sms.content.text              : body",
				"sms.properties.state          : stored",
				"sms.properties.timestamp      : --",
			].join("\n"),
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(Object.hasOwn(r.value, "from")).toBe(false);
			expect(Object.hasOwn(r.value, "timestamp")).toBe(false);
		}
	});

	it("reports an empty text for a data-only message rather than dropping it", () => {
		const r = parseSmsRecord(
			[
				"sms.dbus-path                 : /org/freedesktop/ModemManager1/SMS/8",
				"sms.content.text              : --",
				"sms.content.data              : 01 02 03",
				"sms.properties.state          : received",
			].join("\n"),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value.text).toBe("");
	});

	it("degrades an unknown MM state token instead of rejecting the message", () => {
		const r = parseSmsRecord(
			RECORD.replace("state               : received", "state : teleported"),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value.state).toBe("unknown");
	});

	it("fails loud on malformed output, and never crashes", () => {
		for (const malformed of [
			"",
			"error: couldn't find modem",
			"garbage without colons",
			"sms.content.text : orphaned body with no dbus path",
		]) {
			const r = parseSmsRecord(malformed);
			expect(isParseError(r)).toBe(true);
		}
	});

	it("fails loud when the dbus-path grammar drifts", () => {
		const r = parseSmsRecord("sms.dbus-path : /some/renamed/Object/Path");
		expect(isParseError(r)).toBe(true);
		if (!r.ok) expect(r.reason).toContain("path grammar");
	});

	it("REDACTION: a parse error carries key names only, never content", () => {
		const secret = "Tu pin es 9113 desde +573001112233";
		const r = parseSmsRecord(
			[
				`sms.content.text   : ${secret}`,
				"sms.content.number : +573001112233",
			].join("\n"),
		);
		expect(isParseError(r)).toBe(true);
		if (!r.ok) {
			const rendered = JSON.stringify(r);
			expect(rendered).not.toContain(secret);
			expect(rendered).not.toContain("9113");
			expect(rendered).not.toContain("+573001112233");
			expect(r.raw).toBe("sms.content.text, sms.content.number");
		}
	});
});

/*
 * mmcli never prints non-ASCII text — `cli/mmcli-output.c` runs every `-K`
 * value through `g_strescape()`, so an accented letter arrives as the LITERAL
 * characters of its octal escape. The three fixtures below are byte-verbatim
 * board captures (`mmcli 1.24.2`, Quectel RM530N-GL, `od -c` confirmed): a
 * Claro promo, a Tigo promo carrying a currency sign, and a bank OTP whose real
 * newline mmcli folded into a two-character `\n`. Only these can catch the bug —
 * an ASCII-only fixture parses identically before and after the decoder.
 */
const CLARO_ESCAPED = String.raw`\302\241Disfruta sin pagar mas! Claro club te da cupones con descuentos en tus marcas favoritas. Desc\303\241rgalos aqu\303\255 bit.ly/4gGmOPx  Aplican TyC`;
const CLARO_DECODED =
	"¡Disfruta sin pagar mas! Claro club te da cupones con descuentos en tus marcas favoritas. Descárgalos aquí bit.ly/4gGmOPx  Aplican TyC";

function recordWithText(text: string): string {
	return [
		"sms.dbus-path      : /org/freedesktop/ModemManager1/SMS/33",
		"sms.content.number : CLAROPARATI",
		`sms.content.text   : ${text}`,
		"sms.properties.state     : received",
		"sms.properties.timestamp : 2025-08-06T09:03:13-05",
	].join("\n");
}

function textOf(raw: string): string {
	const r = parseSmsRecord(raw);
	expect(r.ok).toBe(true);
	return r.ok ? r.value.text : "";
}

describe("parseSmsRecord — mmcli escapes every value it prints", () => {
	it("decodes the board's real Spanish message to correct UTF-8", () => {
		expect(textOf(recordWithText(CLARO_ESCAPED))).toBe(CLARO_DECODED);
	});

	it("leaves no escape marker behind for the operator to read", () => {
		const text = textOf(recordWithText(CLARO_ESCAPED));
		expect(text).not.toContain("\\");
		expect(text).not.toContain("302");
		expect(text).not.toContain("241");
	});

	it("rebuilds multi-byte characters from their BYTES, not their code units", () => {
		// `\303\241` is 0xC3 0xA1 — one `á`. Decoding each escape as a code unit
		// instead would yield the two-character mojibake `Ã¡`.
		expect(textOf(recordWithText(String.raw`Desc\303\241rgalos`))).toBe(
			"Descárgalos",
		);
		expect(textOf(recordWithText(String.raw`Tigo por \302\244139.900`))).toBe(
			"Tigo por ¤139.900",
		);
	});

	it("restores a real newline the CLI folded into a literal `\\n`", () => {
		const text = textOf(
			recordWithText(String.raw`Sabadell: 244080 es tu codigo para\nfinalizar`),
		);
		expect(text).toBe("Sabadell: 244080 es tu codigo para\nfinalizar");
	});

	it("leaves a pure-ASCII body byte-identical", () => {
		const plain = "Neutral fixture body with a colon: and more";
		expect(textOf(recordWithText(plain))).toBe(plain);
	});

	it("does not let a decoded byte forge the key/value separator", () => {
		// \072 is ':' — decoding runs AFTER the split, so a body that decodes
		// into something key-shaped can never be mistaken for another field.
		const text = textOf(recordWithText(String.raw`a\072 sms.dbus-path\072 /x`));
		expect(text).toBe("a: sms.dbus-path: /x");
	});

	it("decodes the sender field too, not only the body", () => {
		const r = parseSmsRecord(
			recordWithText("body").replace(
				"sms.content.number : CLAROPARATI",
				String.raw`sms.content.number : Telef\303\263nica`,
			),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value.from).toBe("Telefónica");
	});

	it("REDACTION: decoded text still never reaches a parse error", () => {
		const r = parseSmsRecord(`sms.content.text : ${CLARO_ESCAPED}`);
		expect(isParseError(r)).toBe(true);
		if (!r.ok) {
			const rendered = JSON.stringify(r);
			expect(rendered).not.toContain("Disfruta");
			expect(rendered).not.toContain("Descárgalos");
			expect(r.raw).toBe("sms.content.text");
		}
	});
});

describe("smsPathIndex", () => {
	it("reads the trailing object index", () => {
		expect(smsPathIndex("/org/freedesktop/ModemManager1/SMS/36")).toBe(36);
		expect(smsPathIndex("/org/freedesktop/ModemManager1/SMS/0")).toBe(0);
	});

	it("returns NaN for a path with no index", () => {
		expect(Number.isNaN(smsPathIndex("nonsense"))).toBe(true);
	});
});

describe("smsTimestampEpoch — mmcli's hours-only UTC offset", () => {
	it("parses the board's real `-05` offset that Date.parse rejects outright", () => {
		expect(Number.isNaN(Date.parse("2025-08-21T17:20:16-05"))).toBe(true);
		expect(smsTimestampEpoch("2025-08-21T17:20:16-05")).toBe(
			Date.parse("2025-08-21T17:20:16-05:00"),
		);
	});

	it("leaves a fully-specified offset and a Z suffix alone", () => {
		expect(smsTimestampEpoch("2025-08-21T17:20:16-05:00")).toBe(
			Date.parse("2025-08-21T17:20:16-05:00"),
		);
		expect(smsTimestampEpoch("2025-08-21T17:20:16Z")).toBe(
			Date.parse("2025-08-21T17:20:16Z"),
		);
	});

	it("does not mangle a bare date into an unparseable string", () => {
		expect(smsTimestampEpoch("2025-08-21")).toBe(Date.parse("2025-08-21"));
	});

	it("scores an unparseable timestamp as oldest rather than throwing", () => {
		expect(smsTimestampEpoch("not-a-date")).toBe(Number.NEGATIVE_INFINITY);
	});
});

describe("sortAndCapSms — newest first, capped", () => {
	it("orders by carrier timestamp, newest first", () => {
		const sorted = sortAndCapSms([
			message("1", "2025-01-28T19:37:33-05"),
			message("2", "2026-08-16T09:12:44-05"),
			message("3", "2025-08-21T17:20:16-05"),
		]);
		expect(sorted.map((m) => m.id)).toEqual(["2", "3", "1"]);
	});

	it("does NOT trust the object index as arrival order", () => {
		// ModemManager reuses freed indices, so a low index can be the newest
		// message — the reason this sorts on the timestamp at all.
		const sorted = sortAndCapSms([
			message("40", "2025-01-01T00:00:00+00"),
			message("2", "2026-01-01T00:00:00+00"),
		]);
		expect(sorted[0]?.id).toBe("2");
	});

	it("sinks undated and unparseable-date messages to the bottom", () => {
		const sorted = sortAndCapSms([
			message("1"),
			message("2", "not-a-date"),
			message("3", "2025-08-21T17:20:16-05"),
		]);
		expect(sorted[0]?.id).toBe("3");
		expect(
			sorted
				.slice(1)
				.map((m) => m.id)
				.sort(),
		).toEqual(["1", "2"]);
	});

	it("caps at 50 and keeps the newest 50", () => {
		const many = Array.from({ length: 120 }, (_, i) =>
			message(
				String(i),
				`2025-01-01T00:00:${String(i % 60).padStart(2, "0")}+00`,
			),
		);
		const sorted = sortAndCapSms(many);
		expect(SMS_INBOX_CAP).toBe(50);
		expect(sorted).toHaveLength(50);
		expect(sorted.length).toBeLessThanOrEqual(SMS_INBOX_CAP);
	});

	it("does not mutate its input", () => {
		const input = [message("1", "2025-01-01T00:00:00+00"), message("2")];
		const snapshot = JSON.stringify(input);
		sortAndCapSms(input);
		expect(JSON.stringify(input)).toBe(snapshot);
	});
});

function cliError(message: string): Error & { stderr: string; code: number } {
	return Object.assign(new Error(message), { stderr: message, code: 1 });
}

function recordFixture(index: number, timestamp: string): string {
	return [
		`sms.dbus-path        : /org/freedesktop/ModemManager1/SMS/${index}`,
		`sms.content.number   : 8557${index}`,
		`sms.content.text     : neutral body ${index}`,
		"sms.properties.state : received",
		`sms.properties.timestamp : ${timestamp}`,
	].join("\n");
}

function listFixture(indices: number[]): string {
	return [
		`modem.messaging.sms.length: ${indices.length}`,
		...indices.map(
			(index, i) =>
				`modem.messaging.sms.value[${i + 1}]: /org/freedesktop/ModemManager1/SMS/${index}`,
		),
	].join("\n");
}

describe("readSmsInbox — the whole read, over a scripted mmcli", () => {
	it("returns a populated inbox newest-first", async () => {
		const result = await readSmsInbox("2", async (args) => {
			if (args.includes("--messaging-list-sms")) return listFixture([0, 1, 2]);
			const index = Number(args[args.indexOf("-s") + 1]?.replace(/^.*\//, ""));
			return recordFixture(index, `2025-0${index + 1}-01T10:00:00-05`);
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages.map((m) => m.id)).toEqual(["2", "1", "0"]);
			expect(result.messages[0]?.text).toBe("neutral body 2");
		}
	});

	it("reports a genuinely empty inbox as success with zero messages", async () => {
		const result = await readSmsInbox(
			"2",
			async () => "modem.messaging.sms : --",
		);
		expect(result).toEqual({ ok: true, messages: [] });
	});

	it("answers a typed `unsupported`, never an empty-list lie", async () => {
		const result = await readSmsInbox("2", () => {
			throw cliError("error: modem has no messaging capabilities");
		});
		expect(result).toEqual({ ok: false, reason: "unsupported" });
	});

	it("keeps a not-yet-enabled radio distinct from unsupported", async () => {
		const result = await readSmsInbox("2", () => {
			throw cliError("error: modem not enabled yet");
		});
		expect(result).toEqual({ ok: false, reason: "not_enabled" });
	});

	it("rejects a modem selector that could escape the argv boundary", async () => {
		let spawned = 0;
		const result = await readSmsInbox("2; rm -rf /", async () => {
			spawned += 1;
			return "";
		});
		expect(result).toEqual({ ok: false, reason: "unknown_modem" });
		expect(spawned).toBe(0);
	});

	it("aborts on a malformed record with a typed error and ZERO retries", async () => {
		const calls: string[][] = [];
		const result = await readSmsInbox("2", async (args) => {
			calls.push(args);
			if (args.includes("--messaging-list-sms")) return listFixture([0, 1, 2]);
			return "error: couldn't parse anything at all";
		});

		expect(result).toEqual({ ok: false, reason: "read_failed" });
		// One list call, then ONE record read that failed — and it stopped there.
		expect(calls).toHaveLength(2);
		expect(calls[0]).toContain("--messaging-list-sms");
		expect(calls[1]).toContain("-s");
	});

	it("fails loud on list-output drift rather than reporting an empty inbox", async () => {
		const result = await readSmsInbox(
			"2",
			async () => "modem.generic.state : connected",
		);
		expect(result).toEqual({ ok: false, reason: "read_failed" });
	});

	it("skips a message that vanished between the list and the read", async () => {
		const result = await readSmsInbox("2", async (args) => {
			if (args.includes("--messaging-list-sms")) return listFixture([0, 1]);
			if (args.includes("/org/freedesktop/ModemManager1/SMS/1")) {
				throw cliError("error: couldn't find SMS");
			}
			return recordFixture(0, "2025-01-01T10:00:00-05");
		});

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.messages.map((m) => m.id)).toEqual(["0"]);
	});

	it("never issues more than SMS_INBOX_CAP record reads", async () => {
		const all = Array.from({ length: 137 }, (_, i) => i);
		let reads = 0;
		const result = await readSmsInbox("2", async (args) => {
			if (args.includes("--messaging-list-sms")) return listFixture(all);
			reads += 1;
			const index = Number(args[args.indexOf("-s") + 1]?.replace(/^.*\//, ""));
			return recordFixture(index, "2025-01-01T10:00:00-05");
		});

		expect(reads).toBe(SMS_INBOX_CAP);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.messages).toHaveLength(SMS_INBOX_CAP);
	});
});

describe("classifySmsCliFailure — capability honesty", () => {
	it("names a modem with no Messaging interface `unsupported`", () => {
		expect(
			classifySmsCliFailure("error: modem has no messaging capabilities"),
		).toBe("unsupported");
	});

	it("keeps a not-yet-enabled radio DISTINCT from unsupported", () => {
		expect(classifySmsCliFailure("error: modem not enabled yet")).toBe(
			"not_enabled",
		);
	});

	it("names a missing modem", () => {
		expect(classifySmsCliFailure("error: couldn't find modem")).toBe(
			"unknown_modem",
		);
	});

	it("does not guess at anything else", () => {
		expect(classifySmsCliFailure("error: something entirely new")).toBe(
			"read_failed",
		);
	});
});
