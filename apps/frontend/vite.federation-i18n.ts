import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const frontend = dirname(fileURLToPath(import.meta.url));
const i18n = resolve(frontend, "../../packages/i18n");
const generated = join(i18n, "generated");
const spaMessages = join(i18n, "src/paraglide/messages");

export const FEDERATION_PARAGLIDE_OUTDIR = join(
	frontend,
	"node_modules/.cache/federation-i18n",
);

// Keep the registry/facade shared, but resolve its message bindings and locale
// state to ONE isolated compiler output. Mixing runtimes freezes host locale changes.
export function resolveFederationI18n(
	source: string,
	importer: string | undefined,
): string | undefined {
	if (importer === undefined) return undefined;
	const target = isAbsolute(source) ? source : resolve(dirname(importer), source);
	if (dirname(importer) === join(generated, "namespaces") && dirname(target) === spaMessages) {
		return join(FEDERATION_PARAGLIDE_OUTDIR, "messages.js");
	}
	if (importer === join(generated, "runtime.js") && target === join(i18n, "src/paraglide/runtime.js")) {
		return join(FEDERATION_PARAGLIDE_OUTDIR, "runtime.js");
	}
	return undefined;
}

export function federationI18nPlugin(): Plugin {
	return {
		name: "ceraui:federation-i18n",
		enforce: "pre",
		resolveId: resolveFederationI18n,
	};
}
