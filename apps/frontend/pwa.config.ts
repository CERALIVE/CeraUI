import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { VitePWAOptions } from "vite-plugin-pwa";

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
		// Explicit static site configuration
		globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
		// CRITICAL: Force navigation fallback for ALL requests
		navigateFallback: "/index.html",
		navigateFallbackDenylist: [], // Don't deny any navigation requests
		// Force immediate control
		skipWaiting: true,
		clientsClaim: true,
		// Simple runtime caching for static assets
		runtimeCaching: [
			// Catch all navigation requests and serve index.html
			{
				urlPattern: ({ request }) => request.mode === "navigate",
				handler: "CacheFirst",
				options: {
					cacheName: "navigation-cache",
				},
			},
			// Catch any missed static assets
			{
				urlPattern: ({ url }) => url.origin === self.location.origin,
				handler: "CacheFirst",
				options: {
					cacheName: "static-assets",
				},
			},
		],
	},
	includeAssets: ["favicon.ico", "apple-touch-icon.png", "favicon-96x96.png"],
	manifest: {
		name: "CeraUI for BELABOX©",
		short_name: "CeraUI",
		description:
			"A modern UI for BELABOX streaming encoder management and configuration",
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
