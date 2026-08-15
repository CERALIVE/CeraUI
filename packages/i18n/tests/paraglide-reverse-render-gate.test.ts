import { beforeAll, describe, expect, it } from "bun:test";

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compileMessages, PARAGLIDE_OUTDIR } from "../scripts/compile-messages.js";
import type { LocaleCode } from "../src/locale-lifecycle.js";
import {
	ALL_LOCALES,
	type LocaleParams,
	readOracleParams,
	readRenderedOracle,
	type RenderedValue,
} from "./helpers/catalog.js";

// ---------------------------------------------------------------------------
// REVERSE-RENDER GATE — the byte-parity proof of the Paraglide migration.
//
// Every message of the CONVERTED catalog is compiled by paraglide and rendered
// with the SAME frozen params the legacy oracle was captured with, then diffed
// against `tests/fixtures/<locale>.rendered.json`. The bar is ZERO diffs across
// all 1472 keys x 10 locales — there is no allowlist, and adding one is a
// deliberate weakening of the gate, not a shortcut (a test below asserts no
// allowlist file exists anywhere in the package).
//
// An intentional copy change therefore CANNOT ride this migration; it belongs in
// a separate, separately-reviewed translation PR that updates the fixtures.
//
// This gate outlives todo 20: todos 21-25 re-run it as their regression check,
// and it keeps working now that the TS dictionaries are deleted because it reads
// only the frozen fixtures and the compiled catalog.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));

type MessageFn = (inputs: Record<string, unknown>, options: { locale: string }) => string;

let messages: Record<string, MessageFn>;

beforeAll(async () => {
	// The compiled runtime is GENERATED and gitignored; compile on demand so the
	// gate is runnable from a clean checkout without a separate build step.
	if (!existsSync(join(PARAGLIDE_OUTDIR, "messages.js"))) await compileMessages();
	messages = (await import(join(PARAGLIDE_OUTDIR, "messages.js"))) as unknown as Record<string, MessageFn>;
});

/** Render one key exactly the way the frozen oracle was captured. */
function renderKey(locale: LocaleCode, key: string, params: LocaleParams): RenderedValue {
	const message = messages[key];
	if (!message) throw new Error(`compiled catalog has no message for ${locale}:${key}`);
	const spec = params.keys[key];

	if (spec?.plural) {
		const byCount: Record<string, string> = {};
		for (const count of params.counts) {
			const inputs = Object.fromEntries(spec.countParams.map((name) => [name, count]));
			byCount[String(count)] = message(inputs, { locale });
		}
		return byCount;
	}
	return message(spec ? { ...spec.params } : {}, { locale });
}

/** Order-insensitive value identity, so a diff is about CONTENT, never key order. */
function stable(value: RenderedValue): string {
	if (typeof value === "string") return JSON.stringify(value);
	const sorted = Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
	return JSON.stringify(sorted);
}

describe("paraglide reverse render vs the frozen oracle", () => {
	it("has NO allowlist for diffs", () => {
		for (const candidate of ["allowed-diffs.json", "fixtures/allowed-diffs.json"]) {
			expect(existsSync(join(HERE, candidate))).toBe(false);
		}
	});

	for (const locale of ALL_LOCALES) {
		describe(locale, () => {
			it("every compiled message byte-matches the frozen fixture", () => {
				const fixture = readRenderedOracle(locale);
				const params = readOracleParams(locale);

				// Collected rather than asserted per key: one assertion over the whole
				// locale, but each entry names locale + key + both sides, so a failure
				// points at the offending message instead of an anonymous diff hunk.
				const diffs: string[] = [];
				for (const [key, expected] of Object.entries(fixture)) {
					const actual = stable(renderKey(locale, key, params));
					if (actual !== stable(expected)) diffs.push(`${locale}:${key} expected ${stable(expected)} got ${actual}`);
				}
				expect(diffs).toEqual([]);
			});
		});
	}
});
