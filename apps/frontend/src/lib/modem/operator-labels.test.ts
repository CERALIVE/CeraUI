/**
 * THE OPERATOR-LABEL GATE: a raw wire token never reaches an operator label.
 *
 * `DESIGN.md` §3 (OL-1/OL-2/OL-5) is the rule; this is the mechanism. Two things
 * about its shape are deliberate and should not be "simplified":
 *
 * 1. IT DRIVES THE REAL TEN-LOCALE CATALOG, not a fake `t`. A stub translator
 *    would only prove that the formatter picked a key — it would say nothing
 *    about the copy behind that key, and the copy is where a token actually
 *    leaks (`"Switch to rndis"` was a message value, not a code path). Running
 *    every locale also catches the case where nine catalogs are clean and one
 *    translator pasted the token in.
 * 2. THE ASSERTION IS SUBSTRING-ABSENCE OVER THE RENDERED STRING, and it is
 *    checked case-insensitively, because the leak this replaces was
 *    `{usbModeLabel(mode)}` returning `mode` verbatim — a form no key-shape
 *    assertion could ever see.
 *
 * `network.modem.bands.label.frequency` is the one intentional exception to the
 * "must not equal the English value" instinct: it is `{generation} {frequency}`
 * in every locale because it composes two values and contains no words.
 */

import { LOCALES, type LocaleCode } from "@ceraui/i18n";
import { setLocale } from "@ceraui/i18n/svelte";
import {
	type UsbCompositionMode,
	usbCompositionModeSchema,
} from "@ceraui/rpc/schemas";
import { beforeAll, describe, expect, it } from "vitest";

import {
	bandListOperatorLabel,
	bandOperatorLabel,
	isMappedBandToken,
	parseBandToken,
	USB_MODE_LABEL_KEY,
	USB_MODE_RAW_TOKENS,
	usbModeOperatorLabel,
} from "./operator-labels";

const LOCALE_CODES: readonly LocaleCode[] = LOCALES.map((entry) => entry.code);

/** The live catalog lookup, bound per locale inside each assertion. */
let translate: (key: string, params?: Record<string, string>) => string;

beforeAll(async () => {
	const svelte = await import("@ceraui/i18n/svelte");
	translate = svelte.resolveMessageKey;
});

function withLocale<T>(locale: LocaleCode, run: () => T): T {
	setLocale(locale, { reload: false });
	try {
		return run();
	} finally {
		setLocale("en", { reload: false });
	}
}

/**
 * The token shapes DESIGN.md OL-1 bans outright, plus the two spellings the
 * `ecm-ncm` value decomposes into — a label reading "ECM mode" would satisfy a
 * naive whole-token scan while leaking exactly what OL-1 names.
 */
const BANNED_USB_FRAGMENTS = [
	"qmi",
	"mbim",
	"ecm",
	"ncm",
	"rndis",
	"hilink",
	"ppp",
	"router-ethernet",
] as const;

/**
 * Bands that must never appear verbatim in a label, one per grammar family.
 *
 * `any` is deliberately NOT here: it is the RESET value, not a band, and its
 * copy ("Any band") legitimately contains the word — asserting substring
 * absence on it would be asserting against English rather than against a leak.
 * It gets its own equality assertion below instead.
 */
const BAND_TOKENS = [
	"eutran-3",
	"eutran-20",
	"ngran-78",
	"utran-1",
	"geran-8",
	"b20",
	"n78",
	"nr-n41",
	"lte-b7",
	"egsm",
	"dcs",
	"pcs",
	"g850",
	"xyzzy-9",
	"cdma-bc0",
] as const;

describe("usbModeOperatorLabel — OL-1: no raw USB-mode token in operator copy", () => {
	it("Given the wire enum, When the label table is read, Then every value has a key", () => {
		expect(Object.keys(USB_MODE_LABEL_KEY).sort()).toEqual(
			[...usbCompositionModeSchema.options].sort(),
		);
		expect([...USB_MODE_RAW_TOKENS].sort()).toEqual(
			[...usbCompositionModeSchema.options].sort(),
		);
	});

	for (const locale of LOCALE_CODES) {
		it.each([...USB_MODE_RAW_TOKENS])(
			`Given ${locale} and the %s composition, When labelled, Then the token is absent`,
			(mode: UsbCompositionMode) => {
				const label = withLocale(locale, () =>
					usbModeOperatorLabel(mode, translate),
				);
				expect(label.length).toBeGreaterThan(0);
				// A dotted key reaching the operator is the OTHER failure mode of a
				// keyed-copy scheme, and it looks nothing like a raw token.
				expect(label).not.toContain("network.modem.");
				for (const fragment of BANNED_USB_FRAGMENTS) {
					expect(label.toLowerCase()).not.toContain(fragment);
				}
			},
		);
	}

	it("Given no reported composition, When labelled, Then it reads as unknown rather than empty", () => {
		const label = usbModeOperatorLabel(undefined, translate);
		expect(label.length).toBeGreaterThan(0);
		expect(label).not.toContain("network.modem.");
	});

	// NON-VACUITY: the assertion above must be able to fail. Feeding it the raw
	// token proves the detector fires rather than passing on everything.
	it("Given the retired raw-token label, When scanned, Then the detector fires", () => {
		const leaked = "rndis";
		const fired = BANNED_USB_FRAGMENTS.some((fragment) =>
			leaked.toLowerCase().includes(fragment),
		);
		expect(fired).toBe(true);
	});
});

describe("bandOperatorLabel — OL-2/OL-5: no raw band token in operator copy", () => {
	for (const locale of LOCALE_CODES) {
		it.each([...BAND_TOKENS])(
			`Given ${locale} and the band %s, When labelled, Then the token is absent`,
			(token: string) => {
				const label = withLocale(locale, () =>
					bandOperatorLabel(token, translate),
				);
				expect(label.length).toBeGreaterThan(0);
				expect(label).not.toContain("network.modem.");
				expect(label.toLowerCase()).not.toContain(token.toLowerCase());
			},
		);
	}

	it("Given the reset value, When labelled, Then it reuses the existing proven copy", () => {
		for (const locale of LOCALE_CODES) {
			const label = withLocale(locale, () =>
				bandOperatorLabel("any", translate),
			);
			expect(label).toBe(
				withLocale(locale, () => translate("network.modem.bands.any")),
			);
			expect(label).not.toContain("network.modem.");
		}
	});

	it("Given every grammar family, When parsed, Then the generation and number are read out", () => {
		expect(parseBandToken("eutran-3")).toEqual({
			kind: "numbered",
			generation: "lte",
			band: "3",
		});
		expect(parseBandToken("NGRAN-78")).toEqual({
			kind: "numbered",
			generation: "nr",
			band: "78",
		});
		expect(parseBandToken("utran-1")).toEqual({
			kind: "numbered",
			generation: "umts",
			band: "1",
		});
		expect(parseBandToken("n78")).toEqual({
			kind: "numbered",
			generation: "nr",
			band: "78",
		});
		expect(parseBandToken("b20")).toEqual({
			kind: "numbered",
			generation: "lte",
			band: "20",
		});
		expect(parseBandToken("dcs")).toEqual({
			kind: "frequency",
			generation: "gsm",
			frequency: "1800 MHz",
		});
		expect(parseBandToken("any")).toEqual({ kind: "any" });
	});

	// `ngran-78` and `n78` both start with `n`, so a bare `n<number>` rule placed
	// first would read "gran-78" as nothing and fall through — or worse, match a
	// different number out of the same token.
	it("Given the explicit and the bare 5G spellings, When parsed, Then both read band 78", () => {
		expect(parseBandToken("ngran-78")).toEqual(parseBandToken("n78"));
	});

	it("Given a token this build cannot name, When labelled, Then it is generic and never the token", () => {
		expect(isMappedBandToken("xyzzy-9")).toBe(false);
		expect(isMappedBandToken("cdma-bc0")).toBe(false);
		const label = bandOperatorLabel("xyzzy-9", translate);
		expect(label).toBe(translate("network.modem.bands.label.unmapped"));
	});

	// A band NUMBER of zero exists in no 3GPP table, so parsing one means the
	// grammar matched something it did not actually understand.
	it("Given a zero band number, When parsed, Then it is unmapped rather than band 0", () => {
		expect(parseBandToken("eutran-0").kind).toBe("unmapped");
		expect(parseBandToken("b0").kind).toBe("unmapped");
	});

	it("Given a locked set, When listed, Then every element is a label and none is a token", () => {
		const line = bandListOperatorLabel(["eutran-3", "ngran-78"], translate);
		expect(line).toBeDefined();
		expect(line).not.toContain("eutran");
		expect(line).not.toContain("ngran");
		expect(line).toContain(",");
	});

	// An empty set must not produce a dangling "Currently locked to ." sentence.
	it("Given an empty set, When listed, Then it answers undefined rather than an empty string", () => {
		expect(bandListOperatorLabel([], translate)).toBeUndefined();
	});
});
