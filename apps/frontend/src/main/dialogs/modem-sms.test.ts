/**
 * modem-sms — the SMS-inbox derivations, in isolation.
 *
 * `smsWallClock` is the only place in the app that reads a carrier timestamp, so
 * it is tested against mmcli's REAL rendering rather than against ISO 8601: the
 * board emits an hours-only UTC offset (`2025-08-21T17:20:16-05`), which is not
 * valid ISO 8601 and which `Date.parse` rejects outright. Anything that went
 * through `Date` here would either produce `Invalid Date` or, once widened,
 * silently re-zone the reading to whatever machine happened to render it. The
 * grammar match below is what keeps the displayed time the network's own.
 */

import { describe, expect, it } from "vitest";

import {
	isWithdrawingSmsRefusal,
	smsRefusalKey,
	smsWallClock,
} from "./modem-sms";

describe("smsWallClock", () => {
	it("renders the carrier's wall clock from mmcli's hours-only offset", () => {
		expect(smsWallClock("2025-08-21T17:20:16-05")).toBe("2025-08-21 17:20");
	});

	it("does NOT re-zone: the offset changes the instant, never the reading", () => {
		// Same wall clock, three different offsets — one displayed value. The
		// device knows what the network stamped; it does not know where the
		// operator is standing.
		expect(smsWallClock("2025-08-21T17:20:16-05")).toBe(
			smsWallClock("2025-08-21T17:20:16+09"),
		);
		expect(smsWallClock("2025-08-21T17:20:16Z")).toBe("2025-08-21 17:20");
	});

	it("accepts a full ISO offset and a seconds-less stamp alike", () => {
		expect(smsWallClock("2026-08-16T09:12:44-05:00")).toBe("2026-08-16 09:12");
		expect(smsWallClock("2026-08-16T09:12")).toBe("2026-08-16 09:12");
	});

	it("tolerates surrounding whitespace", () => {
		expect(smsWallClock("  2026-08-16T09:12:44-05 ")).toBe("2026-08-16 09:12");
	});

	it("answers undefined for an absent timestamp", () => {
		expect(smsWallClock(undefined)).toBeUndefined();
	});

	it.each([
		["2026-08-16", "a date with no time"],
		["09:12:44", "a time with no date"],
		["16/08/2026 09:12", "a non-ISO ordering"],
		["", "an empty string"],
		["--", "mmcli's own absent marker"],
		["not a timestamp", "free text"],
	])("answers undefined for %s (%s)", (input) => {
		expect(smsWallClock(input)).toBeUndefined();
	});
});

describe("isWithdrawingSmsRefusal", () => {
	it("is true ONLY for the capability statement", () => {
		expect(isWithdrawingSmsRefusal("unsupported")).toBe(true);
	});

	it.each(["not_enabled", "unknown_modem", "read_failed"] as const)(
		"is false for %s — a state the device can leave",
		(refusal) => {
			expect(isWithdrawingSmsRefusal(refusal)).toBe(false);
		},
	);

	it("is false when there is no refusal at all", () => {
		expect(isWithdrawingSmsRefusal(undefined)).toBe(false);
	});
});

describe("smsRefusalKey", () => {
	it.each(["not_enabled", "unknown_modem", "read_failed"] as const)(
		"%s gets its own sentence — the three facts are not interchangeable",
		(refusal) => {
			expect(smsRefusalKey(refusal)).toBe(
				`network.modem.sms.refused.${refusal}`,
			);
		},
	);

	it("yields distinct keys, never one shared message", () => {
		const keys = (["not_enabled", "unknown_modem", "read_failed"] as const).map(
			smsRefusalKey,
		);
		expect(new Set(keys).size).toBe(3);
	});

	it("has no key for `unsupported` — that section is removed, never explained", () => {
		expect(smsRefusalKey("unsupported")).toBeUndefined();
	});

	it("has no key when nothing was refused", () => {
		expect(smsRefusalKey(undefined)).toBeUndefined();
	});
});
