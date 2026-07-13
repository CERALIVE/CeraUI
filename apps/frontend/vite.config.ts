import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { persistPlugin } from "svelte-persistent-runes/plugins";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import { VitePWA } from "vite-plugin-pwa";

import { generateUniqueVersion, pwaConfig } from "./pwa.config";
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
		],
		define: {
			__APP_VERSION__: JSON.stringify(VERSION),
			__BRAND_CONFIG__: JSON.stringify(BRAND_CONFIG),
		},
		publicDir: "./src/assets",
		build: {
			// Build frontend to root dist/public/ folder using absolute path
			outDir: path.resolve(__dirname, "../../dist/public"),
			emptyOutDir: true,
			// Enable inline sourcemaps in development only
			sourcemap: mode !== "production" && "inline",
			// Bundle splitting optimization to reduce main chunk size
			rollupOptions: {
				output: {
					manualChunks: (id) => {
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

							// i18n system
							if (id.includes("typesafe-i18n") || id.includes("@ceraui/i18n")) {
								return "vendor-i18n";
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
