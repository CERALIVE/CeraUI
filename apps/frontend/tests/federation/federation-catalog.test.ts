import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
	ALL_LOCALES,
	readOracleParams,
	readRenderedOracle,
} from "../../../../packages/i18n/tests/helpers/catalog";
import { resolveFederationI18n } from "../../vite.federation-i18n";

const output = resolve(import.meta.dirname, "../../node_modules/.cache/federation-i18n");

describe("federation locale-module catalog", () => {
	it("routes message bindings and locale state to the same isolated output", () => {
		const generated = resolve(import.meta.dirname, "../../../../packages/i18n/generated");
		expect(resolveFederationI18n("../../src/paraglide/messages/example.js", join(generated, "namespaces/live.js")))
			.toBe(join(output, "messages.js"));
		expect(resolveFederationI18n("../src/paraglide/runtime.js", join(generated, "runtime.js")))
			.toBe(join(output, "runtime.js"));
		expect(resolveFederationI18n("./registry.js", join(generated, "eager.js"))).toBeUndefined();
		expect(resolveFederationI18n("@ceraui/i18n/svelte", undefined)).toBeUndefined();
	});

	it("compiles separately from the SPA message modules", () => {
		expect(existsSync(join(output, "messages/en.js"))).toBe(true);
	});

	for (const locale of ALL_LOCALES) {
		it(`preserves every frozen rendering in ${locale}`, async () => {
			const fixture = readRenderedOracle(locale);
			const params = readOracleParams(locale);
			const messages = await import(/* @vite-ignore */ join(output, "messages.js"));
			for (const [key, expected] of Object.entries(fixture)) {
				expect(typeof messages[key], key).toBe("function");
				const spec = params.keys[key];
				const actual = spec?.plural
					? Object.fromEntries(params.counts.map((count) => [
						String(count),
						messages[key](Object.fromEntries(spec.countParams.map((name) => [name, count])), { locale }),
					]))
					: messages[key](spec ? { ...spec.params } : {}, { locale });
				expect(actual, `${locale}:${key}`).toEqual(expected);
			}
		});
	}
});
