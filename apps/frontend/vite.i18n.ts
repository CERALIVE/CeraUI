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
