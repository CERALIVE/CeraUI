import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { VitePWAOptions } from "vite-plugin-pwa";

// Brand configuration (CeraLive-only)
const BRAND_CONFIG = {
	name: "CeraUI for CERALIVE©",
	description:
		"A modern UI for CERALIVE streaming encoder management and configuration",
};

// Generate version from git commit hash + deterministic build ID
export function generateUniqueVersion(): string {
	let commitHash: string;

	try {
		commitHash = execSync("git rev-parse --short HEAD", {
			encoding: "utf8",
		}).trim();
	} catch (error) {
		console.warn("Could not get git commit hash:", error);
		// Use package.json version as fallback
		try {
			const pkg = JSON.parse(readFileSync("./package.json", "utf8"));
			commitHash = `v${pkg.version}`;
		} catch {
			commitHash = "dev";
		}
	}

	// Use timestamp for build ID to ensure uniqueness while being deterministic
	const buildTime = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "");
	return `${commitHash}-${buildTime}`;
}

export const pwaConfig: VitePWAOptions = {
	registerType: "autoUpdate",
	// Disable PWA in development to avoid HMR conflicts
	devOptions: {
		enabled: false,
	},
	workbox: {
		// Simplified precaching - only essential files, avoid duplicates with includeAssets
		globPatterns: ["**/*.{js,css,html,woff2}"],

		// Navigation fallback for SPA routing
		navigateFallback: "/index.html",
		navigateFallbackDenylist: [/^\/api\//],

		// Force immediate control
		skipWaiting: true,
		clientsClaim: true,

		// Clean up old caches on new SW activation
		cleanupOutdatedCaches: true,

		// Optimized runtime caching strategies
		runtimeCaching: [
			// Images: StaleWhileRevalidate for faster perceived performance
			// Serves cached version immediately while fetching fresh version in background
			{
				urlPattern: /\.(?:png|jpg|jpeg|svg|gif|ico|webp)$/,
				handler: "StaleWhileRevalidate",
				options: {
					cacheName: "images",
					expiration: {
						maxEntries: 50,
						maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
					},
				},
			},
			// Fonts: CacheFirst since they rarely change
			{
				urlPattern: /\.(?:woff2?)$/,
				handler: "CacheFirst",
				options: {
					cacheName: "fonts",
					expiration: {
						maxEntries: 10,
						maxAgeSeconds: 365 * 24 * 60 * 60, // 1 year
					},
				},
			},
		],
	},
	// Static assets to include in precache (icons and favicons)
	includeAssets: ["favicon.ico", "apple-touch-icon.png", "favicon-96x96.png"],
	manifest: {
		name: BRAND_CONFIG.name,
		short_name: "CeraUI",
		description: BRAND_CONFIG.description,
		start_url: "/",
		scope: "/",
		display: "standalone",
		theme_color: "#ffffff",
		background_color: "#ffffff",
		orientation: "portrait-primary",
		icons: [
			{
				src: "web-app-manifest-192x192.png",
				sizes: "192x192",
				type: "image/png",
				purpose: "any maskable",
			},
			{
				src: "web-app-manifest-512x512.png",
				sizes: "512x512",
				type: "image/png",
				purpose: "any maskable",
			},
		],
		categories: ["multimedia", "utilities"],
	},
	// Ensure service worker is generated for production
	disable: false,
};
