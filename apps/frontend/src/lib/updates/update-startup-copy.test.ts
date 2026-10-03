import { expect, it } from "vitest";
import { LOCALES } from "../../../../../packages/i18n/src/locale-lifecycle";
import { readCatalog } from "../../../../../packages/i18n/tests/helpers/catalog";
import { RPC_UPDATE_INITIALIZING_CODE } from "../rpc/rpc-error";
import { actionRefusalKey } from "./update-view";

const key = actionRefusalKey(RPC_UPDATE_INITIALIZING_CODE);

for (const { code } of LOCALES) {
	it(`${code} carries distinct translated initializing copy and complete locale parity`, () => {
		// Given the real catalog sources, without invoking any generator.
		const en = readCatalog("en");
		const messages = readCatalog(code);
		// When the startup code is projected through the view model.
		const copy = messages[key];
		// Then the mapped key is translated, renderable and distinct from generic refusal.
		expect(typeof copy).toBe("string");
		expect(copy).not.toBe("");
		expect(copy).not.toBe(messages[actionRefusalKey(undefined)]);
		if (code !== "en") expect(copy).not.toBe(en[key]);
		expect(Object.keys(messages).sort()).toEqual(Object.keys(en).sort());
	});
}
