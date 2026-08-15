/**
 * Pure conversion helpers: typesafe-i18n template -> inlang message-format v2.
 *
 * The ONLY authority on what a converted plural branch must say is the LEGACY
 * runtime itself: {@link resolvePlurals} is called once per CLDR category with a
 * representative count, and whatever it answers becomes that category's variant.
 * That is why the shipping Arabic `linksReadyCount` defect (§2d of
 * `docs/PLURAL-GRAMMAR.md` — CLDR `zero`/`two` select an ABSENT branch and render
 * as the empty string) is reproduced by construction rather than by a special
 * case: the converter never consults CLDR to decide TEXT, only to decide which
 * question to ask the legacy resolver.
 *
 * Types are deliberately NOT carried into the message format. inlang's only
 * typed-variable mechanism is a `local x = p: number` declaration, which renders
 * through `Intl.NumberFormat` — in Arabic that turns the frozen `42` into `٤٢`
 * and fails the byte-parity gate. Types are therefore used for VALIDATION and
 * for sourcing the declared input set from `en` (§2b), never for rendering.
 *
 * Retires with `convert-catalog.ts` at the typesafe-i18n cutover (plan todo 24).
 */

import { resolvePlurals } from "../src/plural-resolver.js";

/** `{name}` / `{name:type}` — the ONLY interpolation form the catalog uses (§3a). */
const PARAM_TOKEN = /\{(\w+)(?::(\w+))?\}/g;

/** A `{{…}}` plural group. Brand placeholders are already resolved (§5). */
const PLURAL_GROUP = /\{\{([^{}]*)\}\}/g;

/** Counts that reach every CLDR category across the 10 shipped locales. */
const CATEGORY_PROBES = [0, 1, 2, 3, 5, 11, 20, 100, 101, 1000, 1000000, 1.5] as const;

export interface ComplexMessage {
	declarations: string[];
	selectors: string[];
	match: Record<string, string>;
}

export type MessageValue = string | [ComplexMessage];

/** Byte-mirror of paraglide 2.23.2 `toSafeModuleId` (compiler/safe-module-id.js). */
export function toSafeModuleId(id: string): string {
	const result = id.toLowerCase().replace(/[^a-z0-9_]/g, "_");
	if (/[0-9]/.test(result[0] ?? "")) return `_${result}`;
	if (RESERVED_JS_KEYWORDS.has(result)) return `_${result}`;
	const uppercase = id.match(/[A-Z]/g)?.length ?? 0;
	return uppercase > 0 ? `${result}${uppercase}` : result;
}

const RESERVED_JS_KEYWORDS = new Set([
	"break", "case", "catch", "class", "const", "continue", "debugger", "default",
	"delete", "do", "else", "export", "extends", "false", "finally", "for",
	"function", "if", "import", "in", "instanceof", "new", "null", "return",
	"super", "switch", "this", "throw", "true", "try", "typeof", "var", "void",
	"while", "with", "let", "static", "yield", "await", "enum", "implements",
	"interface", "package", "private", "protected", "public", "then",
]);

/**
 * SAFE-MODULE-ID PRE-FLIGHT. Paraglide writes one `messages/<safeModuleId>.js`
 * per bundle and has no collision detection — a later bundle SILENTLY overwrites
 * an earlier one. Runs before any compile; returns the key -> module-id map.
 */
export function assertInjectiveModuleIds(keys: readonly string[]): Map<string, string> {
	const byModuleId = new Map<string, string>();
	const map = new Map<string, string>();
	for (const key of [...keys].sort()) {
		const moduleId = toSafeModuleId(key);
		const clash = byModuleId.get(moduleId);
		if (clash !== undefined) {
			throw new Error(
				`safe-module-id collision: "${clash}" and "${key}" both map to "${moduleId}". ` +
					"Paraglide would silently drop one of them. Disambiguate the inlang BUNDLE ID " +
					"(suffix) while keeping the dotted key as the registry/API key.",
			);
		}
		byModuleId.set(moduleId, key);
		map.set(key, moduleId);
	}
	return map;
}

/** Ordered, de-duplicated param names of a template. */
export function paramNames(template: string): string[] {
	const names: string[] = [];
	for (const [, name] of template.matchAll(PARAM_TOKEN)) {
		if (name && !names.includes(name)) names.push(name);
	}
	return names;
}

/** Ordered param name -> declared type, for the base locale (`en`) only. */
export function paramTypes(template: string): Map<string, string> {
	const types = new Map<string, string>();
	for (const [, name, type] of template.matchAll(PARAM_TOKEN)) {
		if (name && !types.has(name)) types.set(name, type ?? "");
	}
	return types;
}

/**
 * Literal text -> message-format pattern: `{name:type}` collapses to `{name}`,
 * every other brace or backslash is escaped so it stays literal.
 */
export function toPattern(text: string): string {
	let out = "";
	let cursor = 0;
	for (const match of text.matchAll(PARAM_TOKEN)) {
		out += escapeLiteral(text.slice(cursor, match.index));
		out += `{${match[1]}}`;
		cursor = match.index + match[0].length;
	}
	return out + escapeLiteral(text.slice(cursor));
}

function escapeLiteral(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

/** CLDR categories the runtime can actually select for this locale. */
export function pluralCategories(locale: string): string[] {
	return [...new Intl.PluralRules(locale).resolvedOptions().pluralCategories];
}

function representativeCount(locale: string, category: string): number {
	const rules = new Intl.PluralRules(locale);
	for (const probe of CATEGORY_PROBES) {
		if (rules.select(probe) === category) return probe;
	}
	throw new Error(`no representative count for ${locale} category "${category}"`);
}

/**
 * Reject every grammar form §4 of PLURAL-GRAMMAR.md lists as runtime-supported
 * but dictionary-absent, naming key + locale, so a dictionary edit landing before
 * the cutover cannot be silently mis-converted.
 */
function assertSupportedPlural(template: string, locale: string, key: string): string {
	const groups = [...template.matchAll(PLURAL_GROUP)];
	const where = `${locale}:${key}`;
	const openings = template.split("{{").length - 1;
	if (groups.length !== openings) throw new Error(`${where}: malformed or nested plural group`);
	if (groups.length !== 1) throw new Error(`${where}: ${groups.length} plural groups; exactly 1 supported`);
	const inner = groups[0]?.[1] ?? "";
	if (inner.includes(":")) throw new Error(`${where}: keyed plural {{key: …}} is unsupported`);
	if (inner.includes("??")) throw new Error(`${where}: '??' value injection is unsupported`);
	const arity = inner.split("|").length;
	if (arity !== 2 && arity !== 6) throw new Error(`${where}: plural arity ${arity}; only 2 and 6 supported`);
	return inferPluralKey(template, groups[0]?.index ?? 0, where);
}

/** typesafe-i18n's `lastAccessor` rule: last param before the group, else first. */
function inferPluralKey(template: string, groupIndex: number, where: string): string {
	const before = paramNames(template.slice(0, groupIndex));
	const key = before.at(-1) ?? paramNames(template).at(0);
	if (!key) throw new Error(`${where}: plural falls back to the positional key "0"; unsupported`);
	return key;
}

/**
 * One converted message. `declaredInputs` is the en-sourced param set unioned
 * with this locale's own params (§3c: two keys carry a param `en` lacks).
 */
export function convertTemplate(args: {
	template: string;
	locale: string;
	key: string;
	declaredInputs: readonly string[];
}): MessageValue {
	const { template, locale, key } = args;
	if (!template.includes("{{")) return toPattern(template);

	const selectorKey = assertSupportedPlural(template, locale, key);
	const selector = `${selectorKey}Plural`;
	const branchFor = (count: number): string =>
		toPattern(resolvePlurals(template, routeCount(template, count), locale));

	const match: Record<string, string> = {};
	for (const category of pluralCategories(locale)) {
		match[`${selector}=${category}`] = branchFor(representativeCount(locale, category));
	}
	// The catch-all MUST be emitted last: paraglide returns from the first
	// matching variant in file order, so a leading catch-all would shadow every
	// category above it.
	match[`${selector}=*`] = branchFor(representativeCount(locale, "other"));

	const declarations = [
		...args.declaredInputs.map((name) => `input ${name}`),
		`local ${selector} = ${selectorKey}: plural`,
	];
	return [{ declarations, selectors: [selector], match }];
}

/** The count reaches every key the legacy resolver might infer (incl. index "0"). */
function routeCount(template: string, count: number): Record<string, number> {
	const params: Record<string, number> = { "0": count };
	for (const name of paramNames(template)) params[name] = count;
	return params;
}
