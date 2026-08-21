/**
 * PIN2 copy sweep — all 10 locales.
 *
 * The whole point of the PIN2 flow is that an operator is not told their SIM is
 * locked when their data connection is fine. That is a property of the COPY, and
 * the component test cannot check it: Paraglide resolves to the message key
 * under vitest. So it is checked here, against the catalogs themselves.
 *
 * Two things are asserted per locale: every PIN2 key exists (a missing one
 * renders as a dotted key on the device), and none of the PIN2 copy claims the
 * card or the service is locked.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MESSAGES_DIR = join(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"..",
	"packages",
	"i18n",
	"messages",
);

const LOCALES = [
	"en",
	"es",
	"de",
	"fr",
	"pt-BR",
	"ja",
	"ko",
	"zh",
	"hi",
	"ar",
] as const;

const PREFIX = "network.modem.simUnlock.";

const PIN2_KEYS = [
	"pin2Title",
	"pin2Description",
	"pin2ServiceUnaffected",
	"pin2Label",
	"pin2Placeholder",
	"pin2Submit",
	"pin2Success",
	"wrongPin2",
	"pin2AttemptsLabel",
	"pin2AttemptsRemaining",
	"pin2Unsupported",
	"pin2Puk2Title",
	"pin2Puk2Required",
] as const;

function catalog(locale: string): Record<string, string> {
	return JSON.parse(
		readFileSync(join(MESSAGES_DIR, `${locale}.json`), "utf-8"),
	) as Record<string, string>;
}

describe("SIM PIN2 copy", () => {
	it.each(LOCALES)("%s carries every PIN2 key", (locale) => {
		const messages = catalog(locale);
		for (const key of PIN2_KEYS) {
			const full = PREFIX + key;
			expect(messages[full], `${locale} is missing ${full}`).toBeTruthy();
		}
	});

	it.each(LOCALES)(
		"%s keeps the {count} placeholder on the PIN2 attempts message",
		(locale) => {
			const value = catalog(locale)[`${PREFIX}pin2AttemptsRemaining`] ?? "";
			expect(value).toContain("{count}");
		},
	);

	it("the English PIN2 copy names FDN and states service is unaffected", () => {
		const messages = catalog("en");

		expect(messages[`${PREFIX}pin2Description`]?.toLowerCase()).toContain(
			"fixed dialling",
		);
		// The one sentence that has to be there: PIN2 does not stop the stream.
		expect(messages[`${PREFIX}pin2ServiceUnaffected`]?.toLowerCase()).toContain(
			"not affected",
		);
	});

	it("no PIN2 message tells the operator the SIM or service is locked", () => {
		// The PIN1 copy legitimately says "This SIM card is locked"; reusing that
		// sentence for PIN2 is the exact conflation this flow exists to end. Only
		// the two PUK2 messages may speak about a lock at all, and they scope it
		// to the Fixed-Dialling-Number settings rather than to the card.
		const banned = [
			"sim card is locked",
			"sim is locked",
			"modem is locked",
			"unlock the modem",
		];

		const describing = [
			"pin2Title",
			"pin2Description",
			"pin2ServiceUnaffected",
			"pin2Unsupported",
		] as const;

		for (const key of describing) {
			const value = (catalog("en")[PREFIX + key] ?? "").toLowerCase();
			for (const phrase of banned) {
				expect(value, `${key} must not say "${phrase}"`).not.toContain(phrase);
			}
		}
	});

	it("PIN2 copy never sends the operator hunting for PUK1", () => {
		const messages = catalog("en");
		// PUK2 is a different code from PUK1, so the PIN2 entry copy must not
		// mention a bare "PUK" — an operator reading their carrier letter would
		// try the wrong one.
		for (const key of ["pin2Description", "pin2ServiceUnaffected"] as const) {
			expect(messages[PREFIX + key]).not.toMatch(/\bPUK\b(?!2)/);
		}
	});
});
