import { describe, expect, it } from "bun:test";

import { readdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import type { LocaleCode } from "../src/locale-lifecycle.js";
import type { CatalogValue } from "./helpers/catalog.js";
import { NON_BASE_LOCALES, readCatalog } from "./helpers/catalog.js";
import translationDebt from "./translation-debt-baseline.json";
import identicalExceptions from "./translation-identical-exceptions.json";

interface IdenticalException {
	readonly value: string;
	readonly locales: readonly string[];
	readonly reason: string;
}

const LOCALE_EXCEPTIONS: Readonly<Record<string, IdenticalException>> =
	identicalExceptions;

function translationIssues(
	locale: LocaleCode,
	english: Readonly<Record<string, CatalogValue>>,
	localized: Readonly<Record<string, CatalogValue>>,
	debt: Readonly<Record<string, readonly string[]>>,
	exceptions: Readonly<Record<string, IdenticalException>>,
): string[] {
	const issues: string[] = [];
	for (const key of new Set([
		...Object.keys(english),
		...Object.keys(debt),
		...Object.keys(exceptions),
	])) {
		const identical =
			Object.hasOwn(english, key) &&
			isDeepStrictEqual(english[key], localized[key]);
		const exception = exceptions[key];
		if (
			exception?.locales.includes(locale) &&
			(!identical || exception.value !== english[key])
		) {
			issues.push(
				`${locale}: ${key} is a stale exception; remove ${locale} from translation-identical-exceptions.json entry "${key}".`,
			);
		}
		if (debt[key]?.includes(locale)) {
			if (!identical) {
				issues.push(
					`${locale}: ${key} is no longer English-identical; remove ${locale} from translation-debt-baseline.json for this key.`,
				);
			}
			continue;
		}
		if (identical && !exception?.locales.includes(locale)) {
			issues.push(
				`${locale}: ${key} is identical to English; translate it or review an exact exception.`,
			);
		}
	}
	return issues;
}

// ---------------------------------------------------------------------------
// Translation-quality gate for the exact keys added by todos 6, 10, 11, 12, 13
// of capability-first-live-experience (todo 18's sweep target — see notepad
// sections "Todo 6" / "Todo 10" / "Todo 11" / "Todo 12" / "Todo 13").
//
// Proves every new key resolves to a REAL, non-empty, per-locale translation —
// not an English placeholder silently copy-pasted across all 10 locale files —
// and that no literal interpolation syntax (`{...}` / `{{...}}`) leaks into the
// value (all of these keys are param-free).
//
// Repointed by plan todo 23 from the legacy dictionaries onto `messages/*.json`,
// the catalogs the app compiles and serves. Key access is a direct lookup rather
// than a nested walk, because the catalogs are keyed by the verbatim dotted key.
// ---------------------------------------------------------------------------

const ALL_NON_EN_LOCALES: readonly LocaleCode[] = NON_BASE_LOCALES;

function at(locale: LocaleCode, path: string): unknown {
	return readCatalog(locale)[path];
}

// The full key inventory the todo-18 spec names, per originating todo.
const NEW_KEYS = [
	{ path: "audio.sources.noAudio", todo: 6 },
	{ path: "audio.sources.pipelineDefault", todo: 6 },
	{ path: "live.encoder.axisSelected", todo: 10 },
	{ path: "live.encoder.axisDeviceMax", todo: 10 },
	{ path: "live.education.reason.unsupportedAtResolution", todo: 10 },
	{ path: "live.source.sourceMax", todo: 11 },
	{ path: "live.networkIngest.includesAudio", todo: 12 },
	{ path: "live.source.audioEmbedded", todo: 13 },
	{ path: "live.comingSoon.embeddedAudio", todo: 13 },
] as const;

// Locales the spec explicitly requires a REAL (≠ en) value from — a coincidental
// same-spelling short word in ja/ko/zh/ar/hi/pt-BR is not itself suspicious, but
// es/de/fr sharing Latin script with en makes an accidental copy-paste far more
// plausible, so those three are the load-bearing "proves it's translated" check.
const MUST_DIFFER_FROM_EN: readonly LocaleCode[] = ["es", "de", "fr"];

const INTERPOLATION_RESIDUE_RE = /\{\{?[^}]*\}\}?/;

describe("translation-quality gate: keys added by todos 6/10-13", () => {
	for (const { path, todo } of NEW_KEYS) {
		describe(`${path} (todo ${todo})`, () => {
			const enValue = at("en", path);

			it("exists on en as a non-empty string", () => {
				expect(typeof enValue).toBe("string");
				expect((enValue as string).length).toBeGreaterThan(0);
			});

			for (const locale of ALL_NON_EN_LOCALES) {
				it(`${locale}: resolves to a non-empty string with no interpolation residue`, () => {
					const value = at(locale, path);
					expect(typeof value).toBe("string");
					const str = value as string;
					expect(str.length).toBeGreaterThan(0);
					expect(str).not.toMatch(INTERPOLATION_RESIDUE_RE);
				});
			}

			for (const locale of MUST_DIFFER_FROM_EN) {
				it(`${locale}: is a REAL translation, not the English value copy-pasted`, () => {
					expect(at(locale, path)).not.toBe(enValue);
				});
			}
		});
	}
});

describe("catalog-wide English-copy ratchet", () => {
	const coveredLocales: string[] = [];
	for (const locale of NON_BASE_LOCALES) {
		coveredLocales.push(locale);
		it(`${locale}: rejects a newly copied English hotspot message with its key`, () => {
			const key = "hotspotConfirm.radioChanged";
			const fixture = { [key]: "New English message" };
			expect(translationIssues(locale, fixture, fixture, {}, {})).toEqual([
				`${locale}: ${key} is identical to English; translate it or review an exact exception.`,
			]);
		});

		it(`${locale}: every shipped key is translated, an exception, or known debt`, () => {
			expect(
				translationIssues(
					locale,
					readCatalog("en"),
					readCatalog(locale),
					translationDebt,
					LOCALE_EXCEPTIONS,
				),
			).toEqual([]);
		});
	}

	it("covers exactly the non-English catalog files on disk", () => {
		const diskLocales = readdirSync(new URL("../messages/", import.meta.url))
			.filter((name) => name.endsWith(".json") && name !== "en.json")
			.map((name) => name.slice(0, -5))
			.sort();
		expect([...coveredLocales].sort()).toEqual(diskLocales);
	});

	it.each([
		["ja", "networking.types.ethernet"],
		["ja", "settings.deviceHealth.axis.minutesAgo"],
		["de", "network.view.wifi"],
	] as const)(
		"rejects an English copy where %s already translates %s",
		(locale, key) => {
			const fixture = { [key]: readCatalog("en")[key] };
			expect(
				translationIssues(
					locale,
					fixture,
					fixture,
					{},
					{
						[key]: LOCALE_EXCEPTIONS[key],
					},
				),
			).toEqual([
				`${locale}: ${key} is identical to English; translate it or review an exact exception.`,
			]);
		},
	);

	it.each(["translated", "removed", "changed English"])(
		"requires removal of a stale exception when its value is %s",
		(state) => {
			const key = "hotspotConfigurator.hotspot.placeholderName";
			const english: Readonly<Record<string, CatalogValue>> =
				state === "removed"
					? {}
					: { [key]: state === "changed English" ? "New brand" : "CeraLive" };
			const localized: Readonly<Record<string, CatalogValue>> =
				state === "removed"
					? {}
					: {
							[key]:
								state === "changed English"
									? "New brand"
									: "Translated fixture",
						};
			expect(
				translationIssues(
					"ja",
					english,
					localized,
					{},
					{
						[key]: LOCALE_EXCEPTIONS[key],
					},
				),
			).toEqual([
				`ja: ${key} is a stale exception; remove ja from translation-identical-exceptions.json entry "${key}".`,
			]);
		},
	);

	it("accepts the reviewed CeraLive brand value", () => {
		const fixture = {
			"hotspotConfigurator.hotspot.placeholderName": "CeraLive",
		};
		expect(
			translationIssues(
				"ja",
				fixture,
				fixture,
				{},
				{
					"hotspotConfigurator.hotspot.placeholderName":
						LOCALE_EXCEPTIONS["hotspotConfigurator.hotspot.placeholderName"],
				},
			),
		).toEqual([]);
	});

	it("does not let debt hide a stale exception for the same pair", () => {
		const key = "hotspotConfigurator.hotspot.placeholderName";
		const fixture = { [key]: "CeraLive" };
		expect(
			translationIssues(
				"ja",
				fixture,
				fixture,
				{ [key]: ["ja"] },
				{
					[key]: { ...LOCALE_EXCEPTIONS[key], value: "Old brand" },
				},
			),
		).toEqual([
			`ja: ${key} is a stale exception; remove ja from translation-identical-exceptions.json entry "${key}".`,
		]);
	});

	it.each([
		[
			"hotspotConfigurator.hotspot.placeholderName",
			"New English message",
			'ja: hotspotConfigurator.hotspot.placeholderName is a stale exception; remove ja from translation-identical-exceptions.json entry "hotspotConfigurator.hotspot.placeholderName".',
		],
		[
			"probe.newBrandMessage",
			"CeraLive",
			"ja: probe.newBrandMessage is identical to English; translate it or review an exact exception.",
		],
	])(
		"does not extend an exception to another key or value: %s",
		(key, value, expected) => {
			const fixture = { [key]: value };
			const exception = LOCALE_EXCEPTIONS[key];
			expect(
				translationIssues(
					"ja",
					fixture,
					fixture,
					{},
					exception ? { [key]: exception } : {},
				),
			).toEqual([expected]);
		},
	);

	it("keeps recorded German word debt scoped to German", () => {
		const fixture = { "devtools.browser": "Browser" };
		const debt = { "devtools.browser": translationDebt["devtools.browser"] };
		expect(translationIssues("de", fixture, fixture, debt, {})).toEqual([]);
		expect(translationIssues("zh", fixture, fixture, debt, {})).toEqual([
			"zh: devtools.browser is identical to English; translate it or review an exact exception.",
		]);
	});

	it("compares parsed plural values rather than object identity", () => {
		const key = "live.server.bondedAcross";
		const fixture = { [key]: readCatalog("en")[key] };
		expect(
			translationIssues("ja", fixture, structuredClone(fixture), {}, {}),
		).toEqual([
			`ja: ${key} is identical to English; translate it or review an exact exception.`,
		]);
	});

	it("accepts an explicitly recorded untranslated debt pair", () => {
		const key = "errorBoundary.retry";
		const fixture = { [key]: readCatalog("en")[key] };
		expect(
			translationIssues(
				"ar",
				fixture,
				fixture,
				{
					[key]: translationDebt[key],
				},
				{},
			),
		).toEqual([]);
	});

	it.each(["translated", "removed"])(
		"requires removal of a %s pair from the debt baseline",
		(state) => {
			const key = "errorBoundary.retry";
			const english: Readonly<Record<string, CatalogValue>> =
				state === "removed" ? {} : { [key]: readCatalog("en")[key] };
			const localized: Readonly<Record<string, CatalogValue>> =
				state === "removed" ? {} : { [key]: "Translated fixture" };
			expect(
				translationIssues(
					"ar",
					english,
					localized,
					{
						[key]: translationDebt[key],
					},
					{},
				),
			).toEqual([
				`ar: ${key} is no longer English-identical; remove ar from translation-debt-baseline.json for this key.`,
			]);
		},
	);

	it("records debt and exceptions only for unique supported non-English locales", () => {
		for (const locales of [
			...Object.values(translationDebt),
			...Object.values(LOCALE_EXCEPTIONS).map((entry) => entry.locales),
		]) {
			expect(locales.length).toBeGreaterThan(0);
			expect(new Set(locales).size).toBe(locales.length);
			for (const locale of locales) {
				expect(NON_BASE_LOCALES.some((code) => code === locale)).toBe(true);
			}
		}
	});
});
