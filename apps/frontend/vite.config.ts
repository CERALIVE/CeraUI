import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { persistPlugin } from "svelte-persistent-runes/plugins";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

import { generateUniqueVersion, pwaConfig } from "./pwa.config";

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
// The frontend RPC transport is ONE WebSocket opened to the bare origin root
// (`${VITE_SOCKET_ENDPOINT}:${VITE_SOCKET_PORT}`, no path — see rpc/client.ts);
// the Bun backend upgrades WS on ANY path off the `Upgrade` header. There is no
// separate "/rpc" or "/ws" route, so the proxy is keyed on `/` and bypass()
// forwards only the WS upgrade — plain HTTP stays local so the app + HMR keep
// serving. Inert unless VITE_DEVICE_HOST is set: default `bun run dev` is unchanged.
function buildDeviceServer(env: Record<string, string>) {
	const deviceHost = env.VITE_DEVICE_HOST;
	if (!deviceHost) {
		return {};
	}

	const deviceProtocol = (env.VITE_DEVICE_PROTOCOL || "ws").toLowerCase();
	const isSecure = deviceProtocol === "wss" || deviceProtocol === "https";
	const devicePort = env.VITE_DEVICE_PORT || (isSecure ? "443" : "80");
	const wsTarget = `${isSecure ? "wss" : "ws"}://${deviceHost}:${devicePort}`;

	return {
		host: "0.0.0.0",
		// HMR pinned to its own LOCAL port so the root `/` ws proxy below never
		// hijacks the HMR socket (Vite requires an HMR port distinct from the
		// proxied server.port). host=localhost = browser dials this machine.
		hmr: {
			protocol: "ws",
			host: "localhost",
			port: 24678,
			clientPort: 24678,
		},
		proxy: {
			"/": {
				target: wsTarget,
				ws: true,
				changeOrigin: true,
				secure: false,
				rewriteWsOrigin: true,
				bypass(req: { url?: string; headers: Record<string, unknown> }) {
					const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
					// WS upgrade → device; everything else served locally by Vite.
					return upgrade === "websocket" ? undefined : req.url;
				},
			},
		},
	};
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
	// Power-user device-proxy env (VITE_DEVICE_*). Read from the frontend app
	// dir to match .env.local.example; also picks up shell-exported VITE_* vars.
	const deviceEnv = loadEnv(mode, __dirname, "VITE_");
	const deviceServer = buildDeviceServer(deviceEnv);

	return {
		// Load .env from monorepo root for unified configuration
		envDir: path.resolve(__dirname, "../.."),
		plugins: [
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
