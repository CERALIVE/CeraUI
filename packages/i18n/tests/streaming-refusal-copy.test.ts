import { describe, expect, it } from "bun:test";

import {
	ALL_LOCALES,
	readCatalog,
	readRenderedOracle,
} from "./helpers/catalog.js";

// The update refusal for a running OR unconfirmed stream (FIX-16-F4, C4-3).
//
// `general.updateReasonStreaming` is in the immutable rendered oracle, so its
// value is frozen: rewording it in place broke the reverse-render gate in all
// ten locales. The unconfirmed-stream wording therefore lives under its own
// additive key, and the frozen key keeps the oracle's text.
const FROZEN = "general.updateReasonStreaming";
const UNCONFIRMED = "general.updateReasonStreamingUnconfirmed";

const PLACEHOLDER_RE = /\{[^}]*\}/g;

describe("streaming refusal copy", () => {
	for (const locale of ALL_LOCALES) {
		it(`${locale}: the frozen key still renders the oracle's text`, () => {
			const oracle = readRenderedOracle(locale);
			expect(typeof oracle[FROZEN]).toBe("string");
			expect(readCatalog(locale)[FROZEN]).toBe(oracle[FROZEN] as string);
		});

		it(`${locale}: the unconfirmed-stream sentence is its own, non-empty, additive key`, () => {
			const catalog = readCatalog(locale);
			const value = catalog[UNCONFIRMED];
			expect(typeof value).toBe("string");
			expect((value as string).trim().length).toBeGreaterThan(0);
			expect(value).not.toBe(catalog[FROZEN]);
			expect(UNCONFIRMED in readRenderedOracle(locale)).toBe(false);
			const en = readCatalog("en")[UNCONFIRMED] as string;
			expect((value as string).match(PLACEHOLDER_RE) ?? []).toEqual(
				en.match(PLACEHOLDER_RE) ?? [],
			);
		});
	}

	it("en states the uncertainty and the operator's remedy", () => {
		expect(readCatalog("en")[UNCONFIRMED]).toBe(
			"A stream is running or its state is unconfirmed. Press Stop to confirm the stream is stopped before installing an update.",
		);
	});

	for (const locale of ["es", "pt-BR", "fr", "de"] as const) {
		it(`${locale} is translated, not copied from en`, () => {
			expect(readCatalog(locale)[UNCONFIRMED]).not.toBe(
				readCatalog("en")[UNCONFIRMED],
			);
		});
	}

	it("es speaks to the operator as tú (neutral Latin-American Spanish)", () => {
		const es = readCatalog("es")[UNCONFIRMED] as string;
		expect(es).toContain("Presiona Detener");
		expect(es).not.toMatch(/\b(vosotros|podéis|pulsad|presionad|usted)\b/i);
	});
});
