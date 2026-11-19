import { m as catalogue, setLocale } from "@ceraui/i18n/svelte";
import { afterEach, describe, expect, it } from "vitest";

import { m } from "./storage-messages";
import { betweenWords } from "./storage-readout";

afterEach(() => {
	setLocale("en");
});

describe("Storage messages", () => {
	it("marks the word gaps of Chinese text", () => {
		setLocale("zh");
		const hint = m["systemLogs.storage.detailFullHint"]();

		expect(hint).toContain("\u200b");
		expect(hint).toBe(
			betweenWords(catalogue["systemLogs.storage.detailFullHint"](), "zh"),
		);
		expect(
			m["systemLogs.storage.used"]({ used: "48 MB", limit: "256 MB" }),
		).toBe(
			betweenWords(
				catalogue["systemLogs.storage.used"]({
					used: "48 MB",
					limit: "256 MB",
				}),
				"zh",
			),
		);
	});

	it.each(["en", "ja", "ko", "es"])(
		"reads %s exactly as the catalogue has it",
		(locale) => {
			setLocale(locale);

			expect(m["systemLogs.storage.detailFullHint"]()).toBe(
				catalogue["systemLogs.storage.detailFullHint"](),
			);
		},
	);

	it("answers a key it does not know as the catalogue does, and nothing for a symbol", () => {
		setLocale("zh");
		const unknown = "systemLogs.storage.noSuchMessage";

		expect(catalogue[unknown]).toBeTypeOf("function");
		expect(m[unknown]?.()).toBe(catalogue[unknown]?.());
		expect(Reflect.get(m, Symbol.toStringTag)).toBeUndefined();
	});
});
