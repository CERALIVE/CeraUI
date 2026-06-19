import { describe, expect, it } from "bun:test";

import { i18nObject } from "../src/i18n-util.js";
import { loadLocale } from "../src/i18n-util.sync.js";

loadLocale("en");
const L = i18nObject("en");

describe("live.server.bondedAcross", () => {
	it("renders the singular noun at count=1", () => {
		expect(L.live.server.bondedAcross({ count: 1 })).toBe(
			"Bonded across 1 link",
		);
	});

	it("renders the plural noun at count=3", () => {
		expect(L.live.server.bondedAcross({ count: 3 })).toBe(
			"Bonded across 3 links",
		);
	});
});
