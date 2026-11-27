import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const I18N_PACKAGE = path.resolve(__dirname, "../../packages/i18n");

/**
 * Paraglide compile inputs, shared by the SPA config and the federation lib
 * config — the federated dialogs render i18n strings too, so their bundles must
 * carry compiled messages, and both builds must agree on where they come from.
 * Each config still spells out its own compiler options at the call site.
 */
export const PARAGLIDE_PROJECT = path.join(I18N_PACKAGE, "project.inlang");
export const PARAGLIDE_OUTDIR = path.join(I18N_PACKAGE, "src", "paraglide");

/**
 * Locale resolution is the in-memory global ONLY. The default strategy set also
 * writes a `PARAGLIDE_LOCALE` cookie on every switch, and CeraUI's preference is
 * owned by the existing `$persist` store under its own unchanged key — a second
 * persistence mechanism would be a silent third source of truth.
 */
export const PARAGLIDE_STRATEGY = ["globalVariable", "baseLocale"] as const;

const NAMESPACE_BARREL =
	/packages[/\\]i18n[/\\]generated[/\\]namespaces[/\\]([^/\\]+)\.js$/;
const PER_MESSAGE_MODULE =
	/packages[/\\]i18n[/\\]src[/\\]paraglide[/\\]messages[/\\]([^/\\]+)\.js$/;
const SHARED_I18N_RUNTIME =
	/packages[/\\]i18n[/\\](src[/\\]paraglide[/\\](runtime|registry)\.js|generated[/\\](registry|runtime|namespace-map|loader-config)\.js)$/;

const CHUNK_PLAN_PATH = path.join(I18N_PACKAGE, "generated", "chunk-plan.json");

interface ChunkPlan {
	loading: Record<string, "eager" | "lazy">;
	moduleNamespaces: Record<string, string>;
}

let chunkPlan: ChunkPlan | null | undefined;

function readChunkPlan(): ChunkPlan | null {
	if (chunkPlan === undefined) {
		try {
			chunkPlan = JSON.parse(readFileSync(CHUNK_PLAN_PATH, "utf8")) as ChunkPlan;
		} catch {
			// Not yet generated. Every namespace behaves as eager, which is the
			// shipped configuration — never a silent lazy split.
			chunkPlan = null;
		}
	}
	return chunkPlan;
}

function chunkForNamespace(namespace: string | undefined): string | null {
	if (namespace === undefined) return "vendor-i18n";
	const plan = readChunkPlan();
	if (plan === null) return "vendor-i18n";
	return plan.loading[namespace] === "lazy" ? null : "vendor-i18n";
}

/**
 * Namespace-aware chunking for the i18n graph.
 *
 * An EAGER namespace's barrel and its compiled message modules are grouped under
 * `"vendor-i18n"`. Measured on Vite 8 / rolldown 1.2, that name is ADVISORY: any
 * group reachable statically from the entry is fused into a single initial chunk
 * regardless of how many distinct names it is given (31 per-namespace names
 * produced exactly one chunk). Grouping them is therefore intent, not a
 * guarantee — the only lever that genuinely splits a chunk is a dynamic import.
 *
 * Which is precisely why a LAZY namespace returns `null` instead: its barrel is
 * reached only through `import()`, so it becomes its own chunk. That single
 * difference IS the mechanism behind `ensureNamespace()` — and it is the only
 * mitigation available for the initial-payload budget.
 *
 * Returns `undefined` when the id is not part of the i18n graph, so the caller
 * falls through to the rest of its `manualChunks` rules.
 */
export function i18nManualChunk(id: string): string | null | undefined {
	if (SHARED_I18N_RUNTIME.test(id)) return "vendor-i18n";

	const barrel = NAMESPACE_BARREL.exec(id);
	if (barrel !== null) return chunkForNamespace(barrel[1]);

	const message = PER_MESSAGE_MODULE.exec(id);
	if (message !== null) {
		const plan = readChunkPlan();
		const moduleId = message[1];
		return chunkForNamespace(
			plan === null || moduleId === undefined
				? undefined
				: plan.moduleNamespaces[moduleId],
		);
	}

	return undefined;
}

/**
 * Namespaces whose ONLY consumers are dev-gated.
 *
 * `devtools.*` is read exclusively by `main/tabs/DevTools.svelte` and the
 * `lib/components/dev-tools/` tree, which `lib/config/index.ts` registers behind
 * a literal `import.meta.env.DEV`. Vite const-folds that to `false` for a
 * production build and Rollup prunes the whole subtree — verified on the built
 * SPA, where the screenshot utility's `html-to-image` and `zip.js` dependencies
 * are absent. The message catalog had no equivalent gate, so all 132 keys still
 * shipped, and a compiled Paraglide message inlines all ten locales: 28.6 KiB
 * gzip of a payload no production surface can reach.
 */
export const DEV_ONLY_NAMESPACES: readonly string[] = ["devtools"];

/** Whether a module id is a barrel for a namespace no production surface reaches. */
export function isDevOnlyNamespaceBarrel(id: string): boolean {
	const barrel = NAMESPACE_BARREL.exec(id);
	return barrel !== null && DEV_ONLY_NAMESPACES.includes(barrel[1] ?? "");
}

const EMPTY_BARREL = "export const messages = {};\n";

const PLAIN_MESSAGE_RUNTIME = "\0ceraui:plain-message";
const PLAIN_LOCALES = ["ar", "de", "es", "fr", "hi", "ja", "ko", "pt-BR", "zh"];
const LOCALIZED_LITERAL = String.raw`\/\*\* @type \{LocalizedString\} \*\/ \(`;
const STRING_LITERAL = String.raw`"(?:[^"\\]|\\.)*"`;
const PLAIN_COMMENT = String.raw`\/\*(?:[^*]|\*(?!\/))*\*\/\s*`;
// The dispatcher must close over Paraglide's runtime bindings, not local names.
const PLAIN_PREAMBLE = new RegExp(
	String.raw`^(?:${PLAIN_COMMENT}|import \* as __paraglideRegistry from '\.\.\/registry\.js';?\s*)*import \{ getLocale, experimentalStaticLocale \} from '\.\.\/runtime\.js';\s*(?:${PLAIN_COMMENT})*(?:export )?const [A-Za-z_$][\w$]* = (?:${PLAIN_COMMENT})?$`,
);
const PLAIN_LOOKUP = new RegExp(
	String.raw`\(\(inputs = \{\}, options = \{\}\) => \{\n\tvoid inputs;\n\tconst locale = experimentalStaticLocale \?\? options\.locale \?\? getLocale\(\)\n((?:\tif \(locale === "[\w-]+"\) return ${LOCALIZED_LITERAL}${STRING_LITERAL}\)\n)*)\treturn ${LOCALIZED_LITERAL}(${STRING_LITERAL})\)\n\}\);`,
);
const PLAIN_BRANCH = new RegExp(
	String.raw`if \(locale === "([\w-]+)"\) return ${LOCALIZED_LITERAL}(${STRING_LITERAL})\)`,
	"g",
);

// Only the pinned compiler's cooked text and one optional property read are safe to move.
const TEMPLATE_TEXT = String.raw`(?:[^${"`"}\\$\r\n|]|\$(?!\{)|\\(?:[\\${"`"}nrt]|\$(?=\{)))*`;
const TEMPLATE_RETURN = String.raw`${LOCALIZED_LITERAL}${"`"}(${TEMPLATE_TEXT})\$\{i\?\.([A-Za-z_$][\w$]*)\}(${TEMPLATE_TEXT})${"`"}\)`;
const TEMPLATE_BRANCH = String.raw`\tif \(locale === "([\w-]+)"\) return ${TEMPLATE_RETURN}\n`;
const TEMPLATE_MODULE = new RegExp(
	String.raw`^(?<preamble>(?:${PLAIN_COMMENT})*import \{ getLocale, experimentalStaticLocale \} from '\.\.\/runtime\.js';\s*(?:${PLAIN_COMMENT})*(?<direct>export )?const (?<symbol>[A-Za-z_$][\w$]*) = (?:${PLAIN_COMMENT})?)\(\(i, options = \{\}\) => \{\n\tconst locale = experimentalStaticLocale \?\? options\.locale \?\? getLocale\(\)\n(?<branches>(?:${TEMPLATE_BRANCH})*)(?<fallback>\treturn ${TEMPLATE_RETURN})\n\}\);(?<exports>\nexport \{ \k<symbol> as "[\w.-]+" \})?\n?(?![\s\S])`,
);
const TEMPLATE_FALLBACK = new RegExp(String.raw`^\treturn ${TEMPLATE_RETURN}$`);
const TEMPLATE_BRANCHES = new RegExp(TEMPLATE_BRANCH, "g");

function cookedText(text: string): string {
	return text.replace(/\\([\\`$nrt])/g, (_match, char: string) => {
		switch (char) {
			case "n": return "\n";
			case "r": return "\r";
			case "t": return "\t";
			default: return char;
		}
	});
}

function compactTemplate(source: string): string | null {
	const module = TEMPLATE_MODULE.exec(source)?.groups;
	if (!module?.preamble || module.symbol === "templateMessage" ||
		Boolean(module.direct) === Boolean(module.exports)) return null;
	const fallback = TEMPLATE_FALLBACK.exec(module.fallback ?? "");
	if (!fallback) return null;
	const [, prefix = "", key, suffix = ""] = fallback;
	if (!key) return null;
	const translations = new Map<string, readonly [string, string]>();
	for (const [, locale, before, input, after] of (module.branches ?? "").matchAll(TEMPLATE_BRANCHES)) {
		if (locale === undefined || !PLAIN_LOCALES.includes(locale) ||
			translations.has(locale) || input !== key || before === undefined || after === undefined) return null;
		translations.set(locale, [cookedText(before), cookedText(after)]);
	}
	const base = [cookedText(prefix), cookedText(suffix)];
	const table = [base, ...PLAIN_LOCALES.map((locale) => translations.get(locale) ?? base)].flat().join("|");
	return `import { templateMessage } from ${JSON.stringify(PLAIN_MESSAGE_RUNTIME)};\n${module.preamble}templateMessage(${JSON.stringify(key)},${JSON.stringify(table)});${module.exports ?? ""}\n`;
}

/** Share locale dispatch for pinned Paraglide literals and single-read templates in the SPA. */
export function compactPlainMessages() {
	return {
		name: "ceraui:compact-plain-messages",
		resolveId(id: string) {
			return id === PLAIN_MESSAGE_RUNTIME ? id : null;
		},
		load(id: string) {
			if (id === PLAIN_MESSAGE_RUNTIME) {
				return `import { experimentalStaticLocale, getLocale } from ${JSON.stringify(path.join(PARAGLIDE_OUTDIR, "runtime.js"))};
const locales = ${JSON.stringify(PLAIN_LOCALES)};
export const plainMessage = (base, messages) => (_inputs, options = {}) =>
	messages[locales.indexOf(experimentalStaticLocale ?? options.locale ?? getLocale())] ?? base;
export const templateMessage = (key, packed) => {
	const parts = packed.split("|");
	return (i, options = {}) => {
		const index = 2 * (locales.indexOf(experimentalStaticLocale ?? options.locale ?? getLocale()) + 1);
		return \`\${parts[index]}\${i?.[key]}\${parts[index + 1]}\`;
	};
};`;
			}
			if (!PER_MESSAGE_MODULE.test(id)) return null;
			const source = readFileSync(id, "utf8");
			const match = PLAIN_LOOKUP.exec(source);
			if (!match?.[1] || !match[2] || !PLAIN_PREAMBLE.test(source.slice(0, match.index)))
				return compactTemplate(source);
			const translations = new Map<string, string>();
			for (const [, locale, message] of match[1].matchAll(PLAIN_BRANCH)) {
				if (!locale || message === undefined || !PLAIN_LOCALES.includes(locale) || translations.has(locale))
					return null;
				translations.set(locale, message);
			}
			const table = PLAIN_LOCALES.map((locale) => translations.get(locale) ?? "null").join(",");
			const replacement = `plainMessage(${match[2]},[${table}]);`;
			return `import { plainMessage } from ${JSON.stringify(PLAIN_MESSAGE_RUNTIME)};\n${source.replace(match[0], () => replacement)}`;
		},
	};
}

/**
 * Replaces a dev-only namespace barrel with an empty one in production builds.
 *
 * A `load` hook rather than a chunking rule: the barrel is reached through
 * `ensureNamespace()`'s static `import()` map, which is indexed dynamically, so
 * no amount of tree-shaking can drop it. Emptying its contents is what actually
 * removes the messages. Development and test builds are untouched.
 */
export function devOnlyI18nNamespacePlugin(isProduction: boolean): {
	name: string;
	load(id: string): string | null;
} {
	return {
		name: "ceraui:dev-only-i18n-namespaces",
		load(id: string): string | null {
			if (!isProduction) return null;
			return isDevOnlyNamespaceBarrel(id) ? EMPTY_BARREL : null;
		},
	};
}

/**
 * Namespaces no federated dialog (encoder, audio, server) reads.
 *
 * The federation build inlines its whole catalog (debt id
 * `TD-federation-i18n-catalog-size`), so every key added to the SPA would also
 * ship in each signed bundle. These namespaces belong to the device-only System
 * Logs view; emptying their barrels keeps that copy out of the federation graph.
 */
export const FEDERATION_EXCLUDED_NAMESPACES: readonly string[] = [
	"systemLogs",
	"timeline",
];

/** Whether a module id is a barrel for a namespace the federation build omits. */
export function isFederationExcludedNamespaceBarrel(id: string): boolean {
	const barrel = NAMESPACE_BARREL.exec(id);
	return (
		barrel !== null && FEDERATION_EXCLUDED_NAMESPACES.includes(barrel[1] ?? "")
	);
}

/** Replaces the federation-excluded barrels with an empty one. Federation config only. */
export function federationExcludedI18nNamespacePlugin(): {
	name: string;
	load(id: string): string | null;
} {
	return {
		name: "ceraui:federation-excluded-i18n-namespaces",
		load(id: string): string | null {
			return isFederationExcludedNamespaceBarrel(id) ? EMPTY_BARREL : null;
		},
	};
}
