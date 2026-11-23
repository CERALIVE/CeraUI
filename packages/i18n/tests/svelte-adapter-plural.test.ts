import { describe, expect, it } from "bun:test";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { LocaleCode } from "../src/locale-lifecycle.js";
import {
	ALL_LOCALES,
	isComplex,
	readCatalog,
	readOracleParams,
	readRenderedOracle,
	variantsOf,
} from "./helpers/catalog.js";

// Plural coverage and frozen renders live in plural-parity-gate.test.ts.
// This file protects retired syntax and non-plural adapter rendering.

const GENERATED = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"generated",
);

const { m } = (await import(join(GENERATED, "registry.js"))) as {
	m: Record<
		string,
		((inputs?: Record<string, unknown>, options?: { locale: string }) => string)
	>;
};

/** Every rendered pattern of a catalog, plural branches expanded. */
function allPatterns(locale: LocaleCode): Array<{ key: string; pattern: string }> {
	return Object.entries(readCatalog(locale)).flatMap(([key, value]) =>
		(isComplex(value) ? Object.values(variantsOf(value).match) : [value]).map(
			(pattern) => ({ key, pattern }),
		),
	);
}

// Grammar the legacy runtime supported, the converter refuses, and the catalogs
// have never contained. Each is asserted absent BY NAME so a hand edit that
// reintroduces one fails here rather than in front of an operator.
describe("retired legacy grammar stays absent from every catalog", () => {
	const RETIRED_FORMS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
		{ name: "{{s}} suffix shorthand", pattern: /\{\{\s*s\s*\}\}/ },
		{ name: "keyed plural {{key:a|b}}", pattern: /\{\{[^{}]*:[^{}]*\|[^{}]*\}\}/ },
		{ name: "positional {0} parameter", pattern: /\{\d+\}/ },
		{ name: "formatter pipe {x|fmt}", pattern: /\{\w+\|[^{}]*\}/ },
		{ name: "optional param {x?:t}", pattern: /\{\w+\?:/ },
		{ name: "any {{…}} plural group", pattern: /\{\{/ },
	];

	for (const locale of ALL_LOCALES) {
		for (const { name, pattern } of RETIRED_FORMS) {
			it(`${locale}: no ${name}`, () => {
				const hits = allPatterns(locale)
					.filter(({ pattern: text }) => pattern.test(text))
					.map(({ key }) => key);
				expect([...new Set(hits)]).toEqual([]);
			});
		}
	}

	it("`??` value injection is absent from every catalog", () => {
		const hits = ALL_LOCALES.flatMap((locale) =>
			allPatterns(locale)
				.filter(({ pattern }) => pattern.includes("??"))
				.map(({ key }) => `${locale}:${key}`),
		);
		expect(hits).toEqual([]);
	});

});

describe("regression: messages without plural syntax render unchanged", () => {
	it("a plain string renders byte-identically to the frozen oracle", () => {
		const render = m["live.setup.title"];
		expect(render?.()).toBe("Stream setup");
		expect(render?.()).toBe(readRenderedOracle("en")["live.setup.title"]);
	});

	it("a message with no inputs is untouched by an empty input object", () => {
		expect(m["live.setup.title"]?.({})).toBe("Stream setup");
	});

	it("a param-only message substitutes and matches the frozen oracle", () => {
		const oracle = readRenderedOracle("en")["advanced.sshPassword"];
		const params = readOracleParams("en").keys["advanced.sshPassword"]?.params;
		expect(m["advanced.sshPassword"]?.(params)).toBe(oracle);
	});
});
