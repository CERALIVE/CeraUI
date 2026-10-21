import type { UpdateCredentials } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	CREDENTIAL_EXPIRY_COPY_KEYS,
	CREDENTIAL_EXPIRY_STATE_KEYS,
	credentialExpiryView,
	credentialRemainingCopy,
	DAY_MS,
	formatDayCount,
	msUntilDaysLeftChanges,
	wholeDaysLeft,
} from "./credential-expiry";

const NOW = Date.UTC(2026, 9, 20, 12);

function view(credentials: UpdateCredentials | undefined, now = NOW) {
	return credentialExpiryView(credentials, now);
}

describe("wholeDaysLeft — floor of whole days, never negative", () => {
	it.each([90, 30, 7])("exactly %i days left is %i", (days) => {
		// Given an expiry exactly N days ahead; Then N whole days remain.
		expect(wholeDaysLeft(NOW + days * DAY_MS, NOW)).toBe(days);
	});

	it.each([90, 30, 7])("%i days minus 1 ms is one whole day fewer", (days) => {
		expect(wholeDaysLeft(NOW + days * DAY_MS - 1, NOW)).toBe(days - 1);
	});

	it.each([90, 30, 7])("%i days plus 1 ms still floors to %i", (days) => {
		expect(wholeDaysLeft(NOW + days * DAY_MS + 1, NOW)).toBe(days);
	});

	it("one millisecond left is less than a whole day (0)", () => {
		expect(wholeDaysLeft(NOW + 1, NOW)).toBe(0);
	});

	it.each([
		["at the expiry instant", 0],
		["1 ms after it", -1],
		["three days after it", -3 * DAY_MS],
	])("%s nothing is left (undefined, never a negative count)", (_, delta) => {
		expect(wholeDaysLeft(NOW + delta, NOW)).toBeUndefined();
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"an unusable timestamp %s has no count",
		(value) => {
			expect(wholeDaysLeft(value, NOW)).toBeUndefined();
			expect(wholeDaysLeft(NOW + DAY_MS, value)).toBeUndefined();
		},
	);
});

describe("msUntilDaysLeftChanges — when an open row must recount", () => {
	it.each([
		["exactly on a day boundary", 30 * DAY_MS],
		["an hour past a boundary", 30 * DAY_MS + 3_600_000],
		["one millisecond before a boundary", 30 * DAY_MS - 1],
		["two days and a second", 2 * DAY_MS + 1_000],
	])(
		"%s: the count is unchanged until the delay and changes at it",
		(_, left) => {
			const expiresAt = NOW + left;
			const delay = msUntilDaysLeftChanges(expiresAt, NOW);
			expect(delay).toBeGreaterThan(0);
			const before = wholeDaysLeft(expiresAt, NOW);
			expect(wholeDaysLeft(expiresAt, NOW + (delay as number) - 1)).toBe(
				before,
			);
			expect(wholeDaysLeft(expiresAt, NOW + (delay as number))).toBe(
				(before as number) - 1,
			);
		},
	);

	it("on the last day the next change is the expiry itself", () => {
		const expiresAt = NOW + 3_600_000;
		expect(msUntilDaysLeftChanges(expiresAt, NOW)).toBe(3_600_000);
		expect(wholeDaysLeft(expiresAt, NOW + 3_600_000)).toBeUndefined();
	});

	it("never waits longer than one day", () => {
		expect(msUntilDaysLeftChanges(NOW + 400 * DAY_MS, NOW)).toBeLessThanOrEqual(
			DAY_MS,
		);
	});

	it.each([0, -1, -3 * DAY_MS])(
		"nothing left (%i ms) means no timer",
		(left) => {
			expect(msUntilDaysLeftChanges(NOW + left, NOW)).toBeUndefined();
		},
	);
});

describe("credentialExpiryView — what the row may say", () => {
	it("an absent block (older backend) renders nothing", () => {
		expect(view(undefined)).toBeUndefined();
	});

	it("a valid credential shows its date with a positive tone and no countdown", () => {
		const expiresAt = NOW + 400 * DAY_MS;
		expect(view({ expiresAt, state: "valid" })).toEqual({
			state: "valid",
			tone: "success",
			stateKey: CREDENTIAL_EXPIRY_STATE_KEYS.valid,
			expiresAt,
			detailKey: CREDENTIAL_EXPIRY_COPY_KEYS.expiresOn,
			daysLeft: undefined,
		});
	});

	it.each([90, 30, 7])(
		"an expiring credential exactly %i days out counts %i days",
		(days) => {
			const result = view({
				expiresAt: NOW + days * DAY_MS,
				state: "expiring",
			});
			expect(result?.state).toBe("expiring");
			expect(result?.tone).toBe("warning");
			expect(result?.detailKey).toBe(CREDENTIAL_EXPIRY_COPY_KEYS.expiresOn);
			expect(result?.daysLeft).toBe(days);
		},
	);

	it("an expired credential reads as expired with its past date, never a countdown", () => {
		const expiresAt = NOW - 3 * DAY_MS;
		expect(view({ expiresAt, state: "expired" })).toEqual({
			state: "expired",
			tone: "error",
			stateKey: CREDENTIAL_EXPIRY_STATE_KEYS.expired,
			expiresAt,
			detailKey: CREDENTIAL_EXPIRY_COPY_KEYS.expiredOn,
			daysLeft: undefined,
		});
	});

	it("an expiring verdict whose date this clock has already passed shows no phrase", () => {
		// Given the device (its clock) says expiring, but this browser is 3 days later.
		const result = view({ expiresAt: NOW - 3 * DAY_MS, state: "expiring" });
		// Then the device's verdict stands and no negative count is invented.
		expect(result?.state).toBe("expiring");
		expect(result?.daysLeft).toBeUndefined();
		expect(credentialRemainingCopy(result?.daysLeft, "en")).toBeUndefined();
	});

	it("unavailable reads as unknown, neutral, with the could-not-be-read sentence", () => {
		expect(view({ expiresAt: null, state: "unavailable" })).toEqual({
			state: "unavailable",
			tone: "neutral",
			stateKey: CREDENTIAL_EXPIRY_STATE_KEYS.unavailable,
			expiresAt: undefined,
			detailKey: CREDENTIAL_EXPIRY_COPY_KEYS.unreadable,
			daysLeft: undefined,
		});
	});

	it("unavailable never shows a date, even if one rode along", () => {
		const result = view({ expiresAt: NOW + DAY_MS, state: "unavailable" });
		expect(result?.expiresAt).toBeUndefined();
		expect(result?.detailKey).toBe(CREDENTIAL_EXPIRY_COPY_KEYS.unreadable);
	});

	it("a valid claim with a null date is never shown as valid", () => {
		const result = view({ expiresAt: null, state: "valid" });
		expect(result?.state).toBe("unavailable");
		expect(result?.tone).toBe("neutral");
	});

	it.each(["expiring", "expired"] as const)(
		"a reported %s problem with a null date is kept, with no date",
		(state) => {
			const result = view({ expiresAt: null, state });
			expect(result?.state).toBe(state);
			expect(result?.expiresAt).toBeUndefined();
			expect(result?.detailKey).toBe(CREDENTIAL_EXPIRY_COPY_KEYS.unreadable);
			expect(result?.daysLeft).toBeUndefined();
		},
	);

	it.each([Number.NaN, Number.POSITIVE_INFINITY, 1e20, -1e20])(
		"an unusable date %s is treated as no date",
		(expiresAt) => {
			expect(view({ expiresAt, state: "valid" })?.state).toBe("unavailable");
			expect(view({ expiresAt, state: "expiring" })?.expiresAt).toBeUndefined();
		},
	);

	it("an unrecognised verdict from a newer backend reads as unknown", () => {
		const credentials = {
			expiresAt: NOW + DAY_MS,
			state: "revoked",
		} as unknown as UpdateCredentials;
		expect(view(credentials)?.state).toBe("unavailable");
	});

	it("an inherited object key is not mistaken for a verdict", () => {
		const credentials = {
			expiresAt: NOW + DAY_MS,
			state: "toString",
		} as unknown as UpdateCredentials;
		expect(view(credentials)?.state).toBe("unavailable");
	});
});

describe("credentialRemainingCopy — the 'in about N days' phrase", () => {
	it("no count, no phrase", () => {
		expect(credentialRemainingCopy(undefined, "en")).toBeUndefined();
	});

	it.each([-1, 1.5, Number.NaN])(
		"a malformed count %s has no phrase",
		(days) => {
			expect(credentialRemainingCopy(days, "en")).toBeUndefined();
		},
	);

	it("less than a whole day has its own sentence, never 'about 0 days'", () => {
		expect(credentialRemainingCopy(0, "en")).toEqual({
			key: CREDENTIAL_EXPIRY_COPY_KEYS.lessThanDay,
		});
	});

	it.each([
		[1, "1 day"],
		[7, "7 days"],
		[30, "30 days"],
		[90, "90 days"],
	])("%i days embeds the locale's own plural (%s)", (days, english) => {
		expect(credentialRemainingCopy(days, "en")).toEqual({
			key: CREDENTIAL_EXPIRY_COPY_KEYS.inAbout,
			params: { duration: english },
		});
	});

	it("the day count follows each locale's plural rules", () => {
		// Spanish and German singular/plural, Arabic dual: Intl owns the rules.
		expect(formatDayCount(1, "es")).toBe("1 día");
		expect(formatDayCount(2, "es")).toBe("2 días");
		expect(formatDayCount(1, "de")).toBe("1 Tag");
		expect(formatDayCount(5, "de")).toBe("5 Tage");
		expect(formatDayCount(1, "ar")).not.toBe(formatDayCount(2, "ar"));
	});
});
