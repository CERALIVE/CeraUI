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

/**
 * Parse `raw` and return a dotted path for every key that appears more than once
 * IN THE SAME OBJECT. Throws on malformed input so a truncated or corrupt
 * catalog fails loudly rather than reporting an empty (passing) duplicate set.
 */
function duplicateKeysIn(raw: string, locale: string): string[] {
	const duplicates: string[] = [];
	let i = 0;
	const at = () => raw[i];
	const isWs = (c: string | undefined) =>
		c === " " || c === "\t" || c === "\n" || c === "\r";
	const skipWs = () => {
		while (i < raw.length && isWs(raw[i])) i++;
	};
	function parseString(): string {
		// Caller guarantees raw[i] === '"'.
		i++;
		let out = "";
		while (i < raw.length) {
			const c = raw[i++];
			if (c === '"') return out;
			if (c === "\\") {
				out += raw[i++];
			} else {
				out += c;
			}
		}
		throw new Error(`${locale}: unterminated string at byte ${i}`);
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
		// number | true | false | null — consumed verbatim, no key semantics.
		while (i < raw.length && !",}]".includes(raw[i] ?? "") && !isWs(raw[i]))
			i++;
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
