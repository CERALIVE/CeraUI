import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { persistPlugin } from "svelte-persistent-runes/plugins";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import { VitePWA } from "vite-plugin-pwa";

import { generateUniqueVersion, pwaConfig } from "./pwa.config";
import {
	devOnlyI18nNamespacePlugin,
	i18nManualChunk,
	PARAGLIDE_OUTDIR,
	PARAGLIDE_PROJECT,
	PARAGLIDE_STRATEGY,
} from "./vite.i18n";
import {
	SPA_SOURCEMAP_OUT_DIR,
	spaSourcemapRelocationPlugin,
} from "./vite.sourcemaps";
import {
	applyPreviewWebSocketRoute,
	DEVICE_WS_PROXY_CONTEXT,
	previewUpgradeGuard,
	rejectWebSocketUpgrade,
	resolvePreviewWebSocketRoute,
} from "./vite-preview-routing";

export {
	applyPreviewWebSocketRoute,
	DEVICE_WS_PROXY_CONTEXT,
	resolvePreviewWebSocketRoute,
} from "./vite-preview-routing";

// Get __dirname equivalent for ES modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VERSION = generateUniqueVersion();

// The packaged SPA tree, and the NON-packaged sibling its sourcemaps are moved to.
const SPA_OUT_DIR = path.resolve(__dirname, "../../dist/public");
const SPA_MAP_DIR = path.resolve(
	__dirname,
	"../../dist",
	SPA_SOURCEMAP_OUT_DIR,
);

// Brand configuration (CeraLive-only)
const BRAND_CONFIG = {
	siteName: "CeraUI for CERALIVE©",
	description:
		"A modern PWA for CERALIVE streaming encoder management and configuration",
	deviceName: "CERALIVE",
};

// DEV-SYNC power-user mode (Task 14): env-gated proxy to a remote-device backend.
// Exact WS paths prevent the CI worker cookie from becoming a root proxy.
// Inert unless VITE_DEVICE_HOST is set: default `bun run dev` is unchanged.
function buildDeviceProxy(
	env: Record<string, string>,
	allowWorkerRouting: boolean,
): Record<string, ProxyOptions> | undefined {
	const deviceHost = env.VITE_DEVICE_HOST;
	if (!deviceHost) {
		return undefined;
	}

	const deviceProtocol = (env.VITE_DEVICE_PROTOCOL || "ws").toLowerCase();
	const isSecure = deviceProtocol === "wss" || deviceProtocol === "https";
	const devicePort = env.VITE_DEVICE_PORT || (isSecure ? "443" : "80");
	const wsTarget = `${isSecure ? "wss" : "ws"}://${deviceHost}:${devicePort}`;

	return {
		[DEVICE_WS_PROXY_CONTEXT]: {
			target: wsTarget,
			ws: true,
			changeOrigin: true,
			secure: false,
			rewriteWsOrigin: true,
			configure(proxy) {
				const forwardWebSocket = proxy.ws.bind(proxy);
				const routeWebSocket: typeof proxy.ws = (...args) => {
					const [req, socket, head, optionsOrCallback, callback] = args;
					const options =
						typeof optionsOrCallback === "function"
							? undefined
							: optionsOrCallback;
					const onError =
						typeof optionsOrCallback === "function"
							? optionsOrCallback
							: callback;
					const route = resolvePreviewWebSocketRoute(
						wsTarget,
						{ url: req.url, headers: req.headers },
						allowWorkerRouting,
					);
					if (route === null) {
						rejectWebSocketUpgrade(socket);
						return;
					}
					applyPreviewWebSocketRoute(req, route);
					if (onError) {
						forwardWebSocket(
							req,
							socket,
							head,
							{ ...options, target: route.target },
							onError,
						);
					} else {
						forwardWebSocket(req, socket, head, {
							...options,
							target: route.target,
						});
					}
				};
				Object.defineProperty(proxy, "ws", { value: routeWebSocket });
			},
			bypass(req: { url?: string; headers: Record<string, unknown> }) {
				const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
				// WS upgrade → device; everything else served locally by Vite.
				return upgrade === "websocket" ? undefined : req.url;
			},
		},
	};
}

function buildDeviceServer(env: Record<string, string>) {
	const proxy = buildDeviceProxy(env, false);
	if (!proxy) return {};
	return {
		host: "0.0.0.0",
		hmr: {
			protocol: "ws",
			host: "localhost",
			port: 24678,
			clientPort: 24678,
		},
		proxy,
	};
}

function buildDevicePreview(env: Record<string, string>) {
	const proxy = buildDeviceProxy(env, process.env.CI === "true");
	return proxy ? { host: "0.0.0.0", proxy } : {};
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
	// Power-user device-proxy env (VITE_DEVICE_*). Read from the frontend app
	// dir to match .env.local.example; also picks up shell-exported VITE_* vars.
	const deviceEnv = loadEnv(mode, __dirname, "VITE_");
	const deviceServer = buildDeviceServer(deviceEnv);
	const devicePreview = buildDevicePreview(deviceEnv);

	return {
		// Load .env from monorepo root for unified configuration
		envDir: path.resolve(__dirname, "../.."),
		plugins: [
			previewUpgradeGuard(),
			// `cleanOutdir: false` because `bun run generate:i18n` is the
			// authoritative compile and runs first in every script chain; a plugin
			// instance that wiped the outdir could race the federation build.
			paraglideVitePlugin({
				project: PARAGLIDE_PROJECT,
				outdir: PARAGLIDE_OUTDIR,
				outputStructure: "message-modules",
				cleanOutdir: false,
				strategy: [...PARAGLIDE_STRATEGY],
			}),
			devOnlyI18nNamespacePlugin(mode === "production"),
			persistPlugin(),
			tailwindcss(),
			svelte({
				compilerOptions: {
					hmr: mode !== "production",
					// Enhanced debugging options for Svelte 5
					dev: mode !== "production",
				},
				inspector: {
					showToggleButton: "always",
					toggleButtonPos: "bottom-right",
					// Enhanced inspector settings for better debugging
					holdMode: true,
				},
			}),
			VitePWA(pwaConfig),
			spaSourcemapRelocationPlugin({
				outDir: SPA_OUT_DIR,
				mapDir: SPA_MAP_DIR,
				enabled: mode === "production",
			}),
		],
		define: {
			__APP_VERSION__: JSON.stringify(VERSION),
			__BRAND_CONFIG__: JSON.stringify(BRAND_CONFIG),
		},
		publicDir: "./src/assets",
		build: {
			// Build frontend to root dist/public/ folder using absolute path
			outDir: SPA_OUT_DIR,
			emptyOutDir: true,
			// Production maps are `hidden` (emitted, no sourceMappingURL comment) and
			// relocated out of the packaged tree by the plugin above; dev stays inline.
			sourcemap: mode === "production" ? "hidden" : "inline",
			// Bundle splitting optimization to reduce main chunk size
			rollupOptions: {
				output: {
					manualChunks: (id) => {
						// i18n first: the workspace package resolves to a real path
						// OUTSIDE node_modules, so it would never reach the vendor
						// branch below.
						const i18nChunk = i18nManualChunk(id);
						if (i18nChunk !== undefined) {
							return i18nChunk;
						}

						// Vendor chunks for external dependencies
						if (id.includes("node_modules")) {
							// Core Svelte framework (largest)
							if (
								id.includes("svelte") ||
								id.includes("@internationalized/date")
							) {
								return "vendor-core";
							}

							// UI component libraries
							if (
								id.includes("bits-ui") ||
								id.includes("svelte-sonner") ||
								id.includes("vaul-svelte") ||
								id.includes("mode-watcher")
							) {
								return "vendor-ui";
							}

							// Utility libraries
							if (
								id.includes("clsx") ||
								id.includes("tailwind-merge") ||
								id.includes("tailwind-variants") ||
								id.includes("qrcode") ||
								id.includes("svelte-persistent-runes")
							) {
								return "vendor-utils";
							}

							// Image and file processing
							if (
								id.includes("html-to-image") ||
								id.includes("@zip.js/zip.js")
							) {
								return "vendor-media";
							}

							// Other vendor dependencies
							return "vendor-misc";
						}

						// Feature-based chunks for our code
						if (id.includes("/components/streaming/")) {
							return "streaming";
						}

						if (id.includes("/components/dev-tools/")) {
							return "devtools";
						}

						// TEMPORARILY DISABLED: Testing if this causes the "Cannot access 'ye' before initialization" error
						// if (id.includes('/components/ui/')) {
						// 	return 'ui-components';
						// }

						// Default: let Vite decide natural chunk boundaries
						return null;
					},
				},
			},
			// Set stricter chunk size warning limit
			chunkSizeWarningLimit: 300,
		},
		resolve: {
			alias: {
				$lib: path.resolve("./src/lib"),
				$main: path.resolve("./src/main"),
			},
		},
		// Enhanced development server configuration
		server: {
			port: 6173,
			// host / hmr / proxy injected ONLY when VITE_DEVICE_HOST is set; empty
			// otherwise, so the default dev server is byte-for-byte unchanged.
			...deviceServer,
			// Configure source map ignore list for better debugging
			sourcemapIgnoreList(sourcePath) {
				return (
					sourcePath.includes("node_modules") &&
					!sourcePath.includes("@sveltejs")
				);
			},
		},
		preview: {
			...devicePreview,
		},
		// Enhanced CSS development source maps (experimental feature)
		css: {
			devSourcemap: true,
		},
		// Development-specific optimizations
		...(mode !== "production" && {
			// Enhanced dependency optimization for debugging
			optimizeDeps: {
				include: [
					// Pre-bundle these for consistent debugging experience
					// Add any frequently used dependencies here
				],
				exclude: [
					// Keep these as separate modules for better debugging
					"@sveltejs/vite-plugin-svelte",
				],
			},
		}),
	};
});
