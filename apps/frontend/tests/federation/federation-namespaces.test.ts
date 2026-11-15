import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { FEDERATION_NAMESPACES } from "../../src/lib/federation/messages";

const ROOT = resolve(import.meta.dirname, "../../../..");
const VERSION = (
	JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
		version: string;
	}
).version;
const OUTPUT = join(ROOT, "dist", "federation", VERSION);
const CATALOG_KEYS = Object.keys(
	JSON.parse(
		readFileSync(join(ROOT, "packages", "i18n", "messages", "en.json"), "utf8"),
	) as Record<string, string>,
);
const KEY_SET = new Set(CATALOG_KEYS);

// A dotted literal, or the static head of a template or concatenated dynamic key.
const LITERAL = /["'`]([A-Za-z][A-Za-z0-9]*\.[A-Za-z0-9_.]*)(?=["'`]|\$\{)/g;

function catalogNamespaces(code: string): Set<string> {
	const namespaces = new Set<string>();
	for (const [, literal] of code.matchAll(LITERAL)) {
		const isKey =
			KEY_SET.has(literal) ||
			(literal.endsWith(".") && CATALOG_KEYS.some((key) => key.startsWith(literal)));
		if (isKey) namespaces.add(literal.slice(0, literal.indexOf(".")));
	}
	return namespaces;
}

describe("federation catalog scope", () => {
	it("registers every namespace the built bundles reference", () => {
		const referenced = new Set<string>();
		for (const file of readdirSync(OUTPUT).filter((name) => name.endsWith(".js"))) {
			for (const namespace of catalogNamespaces(readFileSync(join(OUTPUT, file), "utf8"))) {
				referenced.add(namespace);
			}
		}

		expect(referenced.size).toBeGreaterThan(0);
		expect([...referenced].filter((namespace) => !FEDERATION_NAMESPACES.includes(namespace))).toEqual([]);
	});
});
