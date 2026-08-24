import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { persistPlugin } from "svelte-persistent-runes/plugins";
import { defineConfig } from "vite";

import {
	PARAGLIDE_OUTDIR,
	PARAGLIDE_PROJECT,
	PARAGLIDE_STRATEGY,
} from "./vite.i18n";
import { PERSIST_RUNTIME_ALIAS } from "./vite.persist";

// Federation lib-mode build (Task 39) — emits standalone ES-module bundles for the
// Encoder/Audio/Server config dialogs so ceralive-platform's web dashboard can load
// them via dynamic import() under a strict CSP. This is DELIBERATELY separate from
// the main SPA build (vite.config.ts → dist/public): it never touches that output,
// never runs the PWA/service-worker plugin, and never emits an index.html.
//
// Hosting/signing contract (root AGENTS.md → version-federation): the bundles are
// served at https://apt.ceralive.tv/ui-bundle/<ceraui-version>/<filename>.js, so the
// build output is versioned by the CeraUI workspace version (CalVer).

// Get __dirname equivalent for ES modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// <ceraui-version> resolves from the workspace-root package.json (CalVer). Reading it
// at build time keeps the output path locked to the same version operators see in the
// platform's `ceraui-version` claim — no second source of truth.
const ROOT_PKG = JSON.parse(
	readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
) as { version: string };
const CERAUI_VERSION = ROOT_PKG.version;

// Brand configuration (CeraLive-only) — mirrors vite.config.ts so any module reading
// the __BRAND_CONFIG__ / __APP_VERSION__ defines resolves identically in lib mode.
const BRAND_CONFIG = {
	siteName: "CeraUI for CERALIVE©",
	description:
		"A modern PWA for CERALIVE streaming encoder management and configuration",
	deviceName: "CERALIVE",
};

const DIALOG_ENTRIES = {
	encoder: path.resolve(__dirname, "src/lib/federation/encoder-entry.ts"),
	audio: path.resolve(__dirname, "src/lib/federation/audio-entry.ts"),
	server: path.resolve(__dirname, "src/lib/federation/server-entry.ts"),
};

// https://vitejs.dev/config/
export default defineConfig({
	// Load .env from monorepo root for unified configuration (matches the SPA build).
	envDir: path.resolve(__dirname, "../.."),
	plugins: [
		// The federated dialogs render i18n strings, so their bundles must carry
		// compiled messages too. `cleanOutdir: false` keeps this build from
		// wiping an outdir the SPA build may be reading.
		paraglideVitePlugin({
			project: PARAGLIDE_PROJECT,
			outdir: PARAGLIDE_OUTDIR,
			outputStructure: "message-modules",
			cleanOutdir: false,
			strategy: [...PARAGLIDE_STRATEGY],
		}),
		persistPlugin(),
		tailwindcss(),
		svelte({
			compilerOptions: {
				// Production lib build: no HMR, no dev instrumentation, no inspector.
				hmr: false,
				dev: false,
			},
		}),
	],
	define: {
		__APP_VERSION__: JSON.stringify(`federation-${CERAUI_VERSION}`),
		__BRAND_CONFIG__: JSON.stringify(BRAND_CONFIG),
	},
	build: {
		// Versioned, isolated output — NEVER the SPA's dist/public.
		outDir: path.resolve(__dirname, `../../dist/federation/${CERAUI_VERSION}`),
		emptyOutDir: true,
		sourcemap: false,
		manifest: "federation-build.json",
		// Self-contained ES modules loadable via dynamic import() — bundle deps inline
		// (no externals) so each dialog bundle stands alone under the platform CSP.
		lib: {
			entry: DIALOG_ENTRIES,
			formats: ["es"],
			fileName: (_format, entryName) => `${entryName}.js`,
		},
	},
	resolve: {
		// Array form, not the object map: object aliases are PREFIX matches, and
		// the persist entry has to be exact (see `vite.persist.ts`).
		alias: [
			PERSIST_RUNTIME_ALIAS,
			{ find: "$lib", replacement: path.resolve(__dirname, "./src/lib") },
			{ find: "$main", replacement: path.resolve(__dirname, "./src/main") },
		],
	},
});
