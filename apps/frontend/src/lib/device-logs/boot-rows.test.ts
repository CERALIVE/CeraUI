import { describe, expect, it } from "vitest";

import { boot, versions } from "./__fixtures__/boots";
import { bootRows, formatBootTime, pickerKeyTarget } from "./boot-rows";

const NEWER = "e".repeat(32);
const OLDER = "f".repeat(32);

function pair(
	newer: [string | null, string | null] | null,
	older: [string | null, string | null] | null,
) {
	return bootRows([
		boot(NEWER, "current", {
			versions: newer === null ? null : versions(NEWER, ...newer),
		}),
		boot(OLDER, "clean", {
			versions: older === null ? null : versions(OLDER, ...older),
		}),
	]);
}

describe("bootRows — versions", () => {
	it("reads the system image and slot from the boot's version record", () => {
		const [row] = pair(["2026.11.3", "b"], ["2026.11.2", "a"]);
		expect(row?.osImage).toBe("2026.11.3");
		expect(row?.slot).toBe("b");
	});

	it("reads neither when the boot recorded no versions", () => {
		const [row] = pair(null, ["2026.11.2", "a"]);
		expect(row?.osImage).toBeNull();
		expect(row?.slot).toBeNull();
	});

	it("keeps every boot, in the order the device listed them", () => {
		const rows = pair(["2026.11.3", "b"], null);
		expect(rows.map((row) => row.boot.bootId)).toEqual([NEWER, OLDER]);
	});
});

describe("bootRows — changed", () => {
	it.each([
		["the system image differs", ["2026.11.3", "a"], ["2026.11.2", "a"], true],
		["the slot differs", ["2026.11.3", "b"], ["2026.11.3", "a"], true],
		[
			"the slot differs while the older image is unknown",
			["2026.11.3", "b"],
			[null, "a"],
			true,
		],
		["both match", ["2026.11.3", "a"], ["2026.11.3", "a"], false],
		["this boot's image is unknown", [null, "a"], ["2026.11.2", "a"], false],
		[
			"the older boot's image is unknown",
			["2026.11.3", "a"],
			[null, "a"],
			false,
		],
		[
			"this boot's slot is unknown",
			["2026.11.3", null],
			["2026.11.3", "a"],
			false,
		],
		[
			"the older boot's slot is unknown",
			["2026.11.3", "a"],
			["2026.11.3", null],
			false,
		],
	] as const)("is %s -> %s", (_case, newer, older, changed) => {
		const [row] = pair([...newer], [...older]);
		expect(row?.changed).toBe(changed);
	});

	it("is not claimed when either boot recorded no versions", () => {
		expect(pair(null, ["2026.11.2", "a"])[0]?.changed).toBe(false);
		expect(pair(["2026.11.3", "a"], null)[0]?.changed).toBe(false);
	});

	it("is never set on the oldest boot, which has nothing before it", () => {
		expect(pair(["2026.11.3", "a"], ["2026.11.2", "b"])[1]?.changed).toBe(
			false,
		);
	});

	it("compares each boot with the one before it, not the one after", () => {
		const [a, b, c] = ["1".repeat(32), "2".repeat(32), "3".repeat(32)];
		const rows = bootRows([
			boot(a, "current", { versions: versions(a, "2026.11.3", "b") }),
			boot(b, "clean", { versions: versions(b, "2026.11.2", "a") }),
			boot(c, "clean", { versions: versions(c, "2026.11.2", "a") }),
		]);
		expect(rows.map((row) => row.changed)).toEqual([true, false, false]);
	});
});

describe("formatBootTime", () => {
	const start = Date.UTC(2026, 10, 16, 10, 31, 5);

	it("shows seconds, so boots of a boot loop seconds apart read apart", () => {
		expect(formatBootTime(start, "en")).not.toBe(
			formatBootTime(start + 30_000, "en"),
		);
	});

	it("shows the date, so the same time on another day reads apart", () => {
		expect(formatBootTime(start, "en")).not.toBe(
			formatBootTime(start + 24 * 60 * 60_000, "en"),
		);
	});

	it("formats in the operator's locale", () => {
		expect(formatBootTime(start, "en")).not.toBe(formatBootTime(start, "de"));
	});
});

describe("formatBootTime — the day period stays on its time's line", () => {
	const LOCALES = [
		"en",
		"ar",
		"de",
		"es",
		"fr",
		"hi",
		"ja",
		"ko",
		"pt-BR",
		"zh",
	];
	const OPTIONS = { dateStyle: "medium", timeStyle: "medium" } as const;
	const morning = new Date(2026, 10, 16, 5, 39, 7).getTime();
	const evening = new Date(2026, 10, 16, 22, 59, 59).getTime();
	const period = (ts: number, locale: string) =>
		new Intl.DateTimeFormat(locale, OPTIONS)
			.formatToParts(ts)
			.find((part) => part.type === "dayPeriod")?.value;

	it.each(LOCALES)(
		"%s: only the space between the day period and its time becomes a no-break space",
		(locale) => {
			for (const ts of [morning, evening]) {
				const plain = new Intl.DateTimeFormat(locale, OPTIONS).format(ts);
				const shown = formatBootTime(ts, locale);
				const token = period(ts, locale);
				if (token === undefined) {
					expect(shown).toBe(plain);
					continue;
				}
				expect(shown.replace("\u00a0", " ")).toBe(plain);
				expect(shown.match(/\u00a0/g)).toHaveLength(1);
				expect(shown).toMatch(
					new RegExp(`\\d\\u00a0${token}|${token}\\u00a0\\d`, "u"),
				);
			}
		},
	);

	it("exercises that join in every locale that shows a day period", () => {
		expect(
			LOCALES.filter((locale) => period(morning, locale) !== undefined),
		).toEqual(["en", "ar", "hi", "ko"]);
	});
});

describe("pickerKeyTarget", () => {
	it.each([
		["ArrowDown", 0, 3, 1],
		["ArrowDown", 2, 3, 2],
		["ArrowUp", 1, 3, 0],
		["ArrowUp", 0, 3, 0],
		["Home", 2, 3, 0],
		["End", 0, 3, 2],
	] as const)("moves %s from %i of %i to %i", (key, index, count, target) => {
		expect(pickerKeyTarget(key, index, count)).toBe(target);
	});

	it.each(["Enter", " ", "Tab", "ArrowLeft", "ArrowRight", "a"])(
		"leaves %j to the browser",
		(key) => {
			expect(pickerKeyTarget(key, 1, 3)).toBeUndefined();
		},
	);
});
