/**
 * Pure, rune-free resolver for typesafe-i18n 5.27.1 plural syntax.
 *
 * The Svelte 5 runes adapter (`i18n-svelte5.svelte.ts`) delegates ALL string
 * rendering to {@link interpolate} here so the BROWSER path renders plural
 * expressions byte-for-byte identically to the NODE `i18nObject` path.
 *
 * This mirrors the reference runtime EXACTLY (the Node path is the oracle):
 *   - parser:  typesafe-i18n/runtime/esm/parser/src/basic.mjs
 *              (`parseRawText`, `parsePluralPart`, `trimAllValues`,
 *               `removeEmptyValues`, `REGEX_BRACKETS_SPLIT`)
 *   - runtime: typesafe-i18n/runtime/esm/runtime/src/core.mjs
 *              (`getPlural`, `applyArguments`, `REGEX_PLURAL_VALUE_INJECTION`)
 *
 * Only `{{...}}` plural parts are resolved here. Ordinary `{param}` tokens are
 * re-emitted verbatim so the adapter's existing param-substitution pass (which
 * runs AFTER plural resolution) handles them unchanged.
 *
 * Supported forms (all validated against the runtime oracle):
 *   (a) unkeyed `{{a|b}}`   — inherits the PREVIOUS param's key (lastAccessor),
 *                             falling back to the first key / index "0".
 *   (b) keyed   `{{k:a|b}}` — explicit key overrides lastAccessor.
 *   (c) 2-part `(one|other)`, 3-part `(zero|one|other)`, 6-part
 *       `(zero|one|two|few|many|other)` resolved via `Intl.PluralRules(locale)`,
 *       with the special rule that value `0` / `"0"` always maps to the `zero`
 *       branch when one is present.
 *   (d) `{{s}}` suffix shorthand (empty singular).
 *   (e) `??` value injection INSIDE the chosen branch (`{{a banana|?? bananas}}`).
 */

export type InterpolationParams = Record<string, string | number | boolean>;

// A balanced brace group with at most one level of nesting — the exact regex
// typesafe-i18n uses to split a raw translation string. A `{{...}}` plural group
// is captured whole (its inner `{...}` is the single nested level).
const REGEX_BRACKETS_SPLIT = /(\{(?:[^{}]+|\{(?:[^{}]+)*\})*\})/g;

// `??` inside a chosen plural branch is replaced by the plural value.
const REGEX_PLURAL_VALUE_INJECTION = /\?\?/g;

interface PluralPart {
	k: string;
	z?: string; // zero
	o?: string; // one
	t?: string; // two
	f?: string; // few
	m?: string; // many
	r?: string; // rest / other
}

const PLURAL_BRANCH_FIELDS = ["z", "o", "t", "f", "m", "r"] as const;

const removeOuterBrackets = (text: string): string =>
	text.substring(1, text.length - 1);

// The argument key of a `{...}` token (e.g. `count` from `count:number`, or
// `name` from `name|formatter`). Mirrors `parseArgumentPart`'s key extraction.
const argumentKey = (content: string): string => {
	const keyPart = content.split("|")[0] ?? "";
	const keyWithoutType = keyPart.split(":")[0] ?? "";
	return keyWithoutType.split("?")[0] ?? "";
};

// Mirror of `parsePluralPart` + `trimAllValues` + `removeEmptyValues`
// (optimize=true). Trims every branch, then drops branches that are empty ("")
// or the literal "0" so that `few ?? rest` / `many ?? rest` and the `zero &&`
// special rule fall through exactly as the reference runtime does.
const parsePluralPart = (content: string, lastAccessor: string): PluralPart => {
	const segments = content.split(":");
	let key = segments[0] ?? "";
	let values = segments[1];
	if (!values) {
		values = key;
		key = lastAccessor;
	}

	const entries = values.split("|");
	const [zero, one, two, few, many, rest] = entries;
	const nrOfEntries = entries.filter((entry) => entry !== undefined).length;

	let raw: PluralPart;
	if (nrOfEntries === 1) {
		raw = { k: key, r: zero };
	} else if (nrOfEntries === 2) {
		raw = { k: key, o: zero, r: one };
	} else if (nrOfEntries === 3) {
		raw = { k: key, z: zero, o: one, r: two };
	} else {
		raw = { k: key, z: zero, o: one, t: two, f: few, m: many, r: rest };
	}

	const optimized: PluralPart = { k: raw.k };
	for (const field of PLURAL_BRANCH_FIELDS) {
		const value = raw[field];
		const trimmed = value === undefined ? undefined : value.trim();
		// `!== "0"` drops a literal "0" branch, mirroring `removeEmptyValues`.
		if (trimmed && trimmed !== "0") {
			optimized[field] = trimmed;
		}
	}
	return optimized;
};

// Mirror of `getPlural` in core.mjs.
const getPlural = (
	pluralRules: Intl.PluralRules,
	part: PluralPart,
	value: string | number | boolean,
): string | undefined => {
	const { z, o, t, f, m, r } = part;
	// typesafe-i18n special rule: a present `zero` branch wins for 0 / "0".
	// biome-ignore lint/suspicious/noDoubleEquals: loose equality matches 0 and "0"
	const category = z && value == 0 ? "zero" : pluralRules.select(Number(value));
	switch (category) {
		case "zero":
			return z;
		case "one":
			return o;
		case "two":
			return t;
		case "few":
			return f ?? r;
		case "many":
			return m ?? r;
		default:
			return r;
	}
};

// Mirror of the plural branch in `applyArguments` (core.mjs): choose the branch,
// coalesce to "", then inject the value into every `??`.
const renderPluralPart = (
	part: PluralPart,
	value: string | number | boolean | undefined,
	pluralRules: Intl.PluralRules,
): string => {
	const chosen =
		typeof value === "boolean"
			? value
				? part.o
				: part.r
			: getPlural(pluralRules, part, value as string | number);
	return (chosen || "").replace(REGEX_PLURAL_VALUE_INJECTION, String(value));
};

type Segment = { text: string } | { part: PluralPart };

/**
 * Resolve every `{{...}}` plural expression in `template` against `params`,
 * using `Intl.PluralRules(locale)`. Ordinary `{param}` tokens and literal text
 * are returned untouched. Pure and rune-free.
 */
export function resolvePlurals(
	template: string,
	params: InterpolationParams,
	locale: string,
): string {
	// Fast path: no plural syntax present.
	if (!template.includes("{{")) return template;

	const pluralRules = new Intl.PluralRules(locale);
	const rawParts = template.split(REGEX_BRACKETS_SPLIT);

	// Pass 1 — classify each part, tracking the running argument key (`lastKey`)
	// and the first argument key seen anywhere (`firstKey`), exactly as
	// `parseRawText` does.
	const segments: Segment[] = [];
	let lastKey = "";
	let firstKey = "";

	for (const raw of rawParts) {
		if (!raw.match(REGEX_BRACKETS_SPLIT)) {
			// Literal text (including the empty strings the split yields).
			segments.push({ text: raw });
			continue;
		}

		const content = removeOuterBrackets(raw);
		if (content.startsWith("{")) {
			// `{{...}}` plural part — inherits `lastKey` when unkeyed.
			segments.push({
				part: parsePluralPart(removeOuterBrackets(content), lastKey),
			});
		} else {
			// `{...}` argument token — re-emitted verbatim for the later param pass.
			const key = argumentKey(content);
			lastKey = key || lastKey;
			if (!firstKey) firstKey = lastKey;
			segments.push({ text: raw });
		}
	}

	// Pass 2 — resolve plural parts. A still-empty key falls back to the first
	// argument key, then to the positional index "0" (`parseRawText`'s rule).
	return segments
		.map((segment) => {
			if ("text" in segment) return segment.text;
			const { part } = segment;
			const key = part.k || firstKey || "0";
			return renderPluralPart(part, params[key], pluralRules);
		})
		.join("");
}

/**
 * Render a translation template: resolve typesafe-i18n plural syntax FIRST, then
 * substitute `{param}` / `{param:type}` tokens. This is the exact function the
 * Svelte 5 runes adapter uses so the browser output matches the Node oracle.
 */
export function interpolate(
	template: string,
	params: InterpolationParams,
	locale: string,
): string {
	const resolved = template.includes("{{")
		? resolvePlurals(template, params ?? {}, locale)
		: template;

	if (!params || Object.keys(params).length === 0) return resolved;

	return resolved.replace(/\{(\w+)(?::\w+)?\}/g, (match, key) => {
		const value = params[key];
		return value !== undefined ? String(value) : match;
	});
}
