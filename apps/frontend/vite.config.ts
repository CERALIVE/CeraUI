import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { persistPlugin } from "@macfja/svelte-persistent-runes/plugins";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
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

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
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
							id.includes("@macfja/svelte-persistent-store")
						) {
							return "vendor-utils";
						}

						// Image and file processing
						if (id.includes("html-to-image") || id.includes("@zip.js/zip.js")) {
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
		// Configure source map ignore list for better debugging
		sourcemapIgnoreList(sourcePath) {
			return (
				sourcePath.includes("node_modules") && !sourcePath.includes("@sveltejs")
			);
		},
	},
	// Enhanced CSS development source maps (experimental feature)
	css: {
		devSourcemap: true,
	},
	// Development-specific optimizations
	...(mode !== "production" && {
		// Enable inline source maps for better debugging in development
		build: {
			sourcemap: "inline",
		},
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
}));
