/**
 * Nested views of the inlang catalogs, for copy-asserting tests.
 *
 * These tests used to import the legacy TypeScript dictionaries
 * (`packages/i18n/src/<locale>/index.ts`) purely to read exact strings. Those
 * files are deleted at plan todo 24, so the imports are repointed at
 * `packages/i18n/messages/<locale>.json` — the catalogs the app compiles and
 * serves.
 *
 * The catalogs are FLAT (keyed by the verbatim dotted key) while every existing
 * assertion reads a NESTED path (`en.live.startStream`). Re-nesting here keeps
 * all of those assertions byte-identical instead of rewriting hundreds of exact
 * -string call sites — the migration must not disturb what they assert.
 *
 * A plural entry re-nests as an object of its variant patterns keyed by CLDR
 * category, so a deep string sweep visits every branch rather than the single
 * legacy `{{a|b}}` template it used to see.
 */

import arCatalog from "../../../../../packages/i18n/messages/ar.json" with {
	type: "json",
};
import deCatalog from "../../../../../packages/i18n/messages/de.json" with {
	type: "json",
};
import enCatalog from "../../../../../packages/i18n/messages/en.json" with {
	type: "json",
};
import esCatalog from "../../../../../packages/i18n/messages/es.json" with {
	type: "json",
};
import frCatalog from "../../../../../packages/i18n/messages/fr.json" with {
	type: "json",
};
import hiCatalog from "../../../../../packages/i18n/messages/hi.json" with {
	type: "json",
};
import jaCatalog from "../../../../../packages/i18n/messages/ja.json" with {
	type: "json",
};
import koCatalog from "../../../../../packages/i18n/messages/ko.json" with {
	type: "json",
};
import ptBRCatalog from "../../../../../packages/i18n/messages/pt-BR.json" with {
	type: "json",
};
import zhCatalog from "../../../../../packages/i18n/messages/zh.json" with {
	type: "json",
};

type CatalogEntry =
	| string
	| Array<{
			declarations: string[];
			selectors: string[];
			match: Record<string, string>;
	  }>;

// biome-ignore lint/suspicious/noExplicitAny: the re-nested tree is read by path in tests, exactly as the legacy dictionaries were.
type NestedCatalog = any;

function entryToNode(entry: CatalogEntry): unknown {
	if (typeof entry === "string") return entry;
	const variants = entry[0];
	if (variants === undefined) return "";
	const node: Record<string, string> = {};
	for (const [match, pattern] of Object.entries(variants.match)) {
		node[match.split("=").at(-1) ?? match] = pattern;
	}
	return node;
}

function nest(catalog: Record<string, unknown>): NestedCatalog {
	const root: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(catalog)) {
		if (key === "$schema") continue;
		const segments = key.split(".");
		let cursor = root;
		for (const segment of segments.slice(0, -1)) {
			if (typeof cursor[segment] !== "object" || cursor[segment] === null) {
				cursor[segment] = {};
			}
			cursor = cursor[segment] as Record<string, unknown>;
		}
		const leaf = segments.at(-1);
		if (leaf !== undefined) cursor[leaf] = entryToNode(entry as CatalogEntry);
	}
	return root;
}

export const ar: NestedCatalog = nest(arCatalog);
export const de: NestedCatalog = nest(deCatalog);
export const en: NestedCatalog = nest(enCatalog);
export const es: NestedCatalog = nest(esCatalog);
export const fr: NestedCatalog = nest(frCatalog);
export const hi: NestedCatalog = nest(hiCatalog);
export const ja: NestedCatalog = nest(jaCatalog);
export const ko: NestedCatalog = nest(koCatalog);
export const ptBR: NestedCatalog = nest(ptBRCatalog);
export const zh: NestedCatalog = nest(zhCatalog);

/** Every shipped locale, keyed by its locale code. */
export const CATALOGS: Record<string, NestedCatalog> = {
	ar,
	de,
	en,
	es,
	fr,
	hi,
	ja,
	ko,
	"pt-BR": ptBR,
	zh,
};
