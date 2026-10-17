import { describe, expect, it } from "bun:test";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ALL_LOCALES } from "./helpers/catalog.js";

// ---------------------------------------------------------------------------
// CATALOG DUPLICATE-KEY GATE.
//
// The catalog is a single JSON object tree, and JSON.parse SILENTLY keeps only
// the LAST value for a repeated key — no error, no warning. A duplicated key
// therefore compiles to whichever occurrence happens to be written later, and
// the other copy is dead data nobody can see. The 2026-10-13 update-available
// regression was exactly that: PR ba520466 added a second
// `notifications.updateAvailable` (the banner sentence) beside the pre-existing
// short title, and last-key-wins replaced the title everywhere.
//
// Every OTHER gate reads the catalog through JSON.parse, so by the time they
// see it the duplicate is already collapsed and there is nothing left to
// detect — which is why this had to be a new, non-JSON.parse-based gate. This
// one scans the RAW bytes with a small duplicate-aware JSON reader and fails on
// ANY repeated key in ANY object of ANY catalog, not only the key that broke.
//
// Duplicates are scoped PER OBJECT on purpose: plural entries legitimately
// repeat `declarations` / `selectors` / `match` inside each variant object, so a
// naive whole-file key counter would report every plural message as a duplicate.
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The JSON `number` production and the three literals, anchored at a position. */
const PRIMITIVE_RE =
	/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

/**
 * Parse `raw` and return a dotted path for every key that appears more than once
 * IN THE SAME OBJECT. Throws on malformed input so a truncated or corrupt
 * catalog fails loudly rather than reporting an empty (passing) duplicate set.
 *
 * Strict on purpose: the whole document must be valid JSON (the standard parser
 * accepts it before any duplicate is counted), every member name is decoded by
 * the standard JSON string decoder, so `"\u0061"` IS `"a"`, and a primitive must
 * match the JSON grammar exactly.
 */
function duplicateKeysIn(raw: string, locale: string): string[] {
	JSON.parse(raw);
	const duplicates: string[] = [];
	let i = 0;
	const at = () => raw[i];
	const isWs = (c: string | undefined) =>
		c === " " || c === "\t" || c === "\n" || c === "\r";
	const skipWs = () => {
		while (i < raw.length && isWs(raw[i])) i++;
	};
	function parseString(): string {
		if (at() !== '"') throw new Error(`${locale}: expected '"' at byte ${i}`);
		const start = i++;
		while (i < raw.length) {
			const c = raw[i++];
			if (c === '"') return JSON.parse(raw.slice(start, i)) as string;
			// Skip the escaped character; the decoder above validates the escape.
			if (c === "\\") i++;
		}
		throw new Error(`${locale}: unterminated string at byte ${i}`);
	}
	function parsePrimitive(): void {
		PRIMITIVE_RE.lastIndex = i;
		const match = PRIMITIVE_RE.exec(raw);
		const end = i + (match?.[0].length ?? 0);
		if (
			match === null ||
			(end < raw.length && !/[\s,}\]]/.test(raw[end] ?? ""))
		)
			throw new Error(`${locale}: invalid value at byte ${i}`);
		i = end;
	}
	function parseValue(path: string): void {
		skipWs();
		const c = at();
		if (c === "{") {
			parseObject(path);
			return;
		}
		if (c === "[") {
			parseArray(path);
			return;
		}
		if (c === '"') {
			parseString();
			return;
		}
		// number | true | false | null: no key semantics, grammar only.
		parsePrimitive();
	}
	function parseObject(path: string): void {
		i++; // consume {
		skipWs();
		const seen = new Set<string>();
		if (at() === "}") {
			i++;
			return;
		}
		for (;;) {
			skipWs();
			const key = parseString();
			if (seen.has(key)) duplicates.push(path ? `${path}.${key}` : key);
			seen.add(key);
			skipWs();
			if (at() !== ":") throw new Error(`${locale}: expected ':' at byte ${i}`);
			i++;
			parseValue(path ? `${path}.${key}` : key);
			skipWs();
			const next = at();
			if (next === ",") {
				i++;
				continue;
			}
			if (next === "}") {
				i++;
				return;
			}
			throw new Error(`${locale}: expected ',' or '}' at byte ${i}`);
		}
	}
	function parseArray(path: string): void {
		i++; // consume [
		skipWs();
		if (at() === "]") {
			i++;
			return;
		}
		let index = 0;
		for (;;) {
			parseValue(`${path}[${index++}]`);
			skipWs();
			const next = at();
			if (next === ",") {
				i++;
				continue;
			}
			if (next === "]") {
				i++;
				return;
			}
			throw new Error(`${locale}: expected ',' or ']' at byte ${i}`);
		}
	}
	parseValue("");
	skipWs();
	if (i !== raw.length)
		throw new Error(`${locale}: trailing content at byte ${i}`);
	return duplicates;
}

describe("catalog duplicate-key gate", () => {
	it("the reader detects a duplicate the JSON.parse path would collapse", () => {
		// Sanity for the scanner itself: JSON.parse of this text is one key, but
		// the byte scan must report the repeat (otherwise the gate is a no-op).
		const doubled = '{"a":{"b":"x","b":"y"}}';
		expect(Object.keys(JSON.parse(doubled))).toEqual(["a"]);
		expect(duplicateKeysIn(doubled, "probe")).toEqual(["a.b"]);
	});

	it("decodes escaped member names before comparing them", () => {
		// `\u0061` IS `a`: JSON.parse keeps one key, so the scan must see two.
		const escaped = '{"a":1,"\\u0061":2}';
		expect(Object.keys(JSON.parse(escaped))).toEqual(["a"]);
		expect(duplicateKeysIn(escaped, "probe")).toEqual(["a"]);
		expect(duplicateKeysIn('{"x":{"é":1,"\\u00e9":2}}', "probe")).toEqual([
			"x.é",
		]);
		expect(duplicateKeysIn('{"a\\"b":1,"a\\u0022b":2}', "probe")).toEqual([
			'a"b',
		]);
		// Different decoded names are not duplicates.
		expect(duplicateKeysIn('{"a":1,"\\u0062":2}', "probe")).toEqual([]);
	});

	it("rejects a malformed document instead of reporting no duplicate", () => {
		for (const malformed of [
			'{"a":nonsense}',
			'{"a":tru}',
			'{"a":nullx}',
			'{"a":01}',
			'{"a":1.}',
			'{"a":-}',
			'{"a":"\\x"}',
			'{"a":"\\u00g0"}',
			'{"a":1,}',
			'{"a":1}}',
			"",
		]) {
			expect(() => duplicateKeysIn(malformed, "probe")).toThrow();
		}
		// Valid primitives still read.
		expect(
			duplicateKeysIn(
				'{"t":true,"f":false,"n":null,"x":-1.5e+3,"z":0,"l":[1, 2]}',
				"probe",
			),
		).toEqual([]);
	});

	for (const locale of ALL_LOCALES) {
		it(`${locale}: no duplicate key in any object of the catalog`, () => {
			const raw = readFileSync(
				join(PACKAGE_ROOT, "messages", `${locale}.json`),
				"utf8",
			);
			expect(duplicateKeysIn(raw, locale)).toEqual([]);
		});
	}
});
