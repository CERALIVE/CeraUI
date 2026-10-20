import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import lock from "../../../../brand-assets.lock.json";
import { pwaConfig } from "../../pwa.config";
import { verifyBrandAssets } from "./brand-assets-integrity";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const frontendRoot = resolve(repoRoot, "apps/frontend");
const destinations = lock.files.map((file) => file.to);

describe("vendored brand assets", () => {
	it("verifies every locked file, notice entry and brand directory", () => {
		expect(verifyBrandAssets(repoRoot)).toEqual([]);
	});

	it("retains favicon.ico as the offline recovery probe", () => {
		expect(destinations).toContain("apps/frontend/src/assets/favicon.ico");
	});

	it("ships separate regular and maskable PWA icons from the lock", () => {
		const manifest = pwaConfig.manifest;
		expect(manifest).toMatchObject({
			icons: [
				{
					src: "web-app-manifest-192x192.png",
					sizes: "192x192",
					type: "image/png",
					purpose: "any",
				},
				{
					src: "web-app-manifest-512x512.png",
					sizes: "512x512",
					type: "image/png",
					purpose: "any",
				},
				{
					src: "web-app-manifest-maskable-192x192.png",
					sizes: "192x192",
					type: "image/png",
					purpose: "maskable",
				},
				{
					src: "web-app-manifest-maskable-512x512.png",
					sizes: "512x512",
					type: "image/png",
					purpose: "maskable",
				},
			],
		});
		if (!manifest) throw new Error("PWA manifest is required");
		expect(manifest.icons).toHaveLength(4);
		for (const icon of manifest.icons ?? []) {
			expect(existsSync(resolve(frontendRoot, "src/assets", icon.src))).toBe(
				true,
			);
			expect(destinations).toContain(`apps/frontend/src/assets/${icon.src}`);
		}
	});

	it("leaves manifest injection to VitePWA and uses Ground Control metadata", () => {
		const html = readFileSync(resolve(frontendRoot, "index.html"), "utf8");
		expect(html).not.toContain('rel="manifest"');
		const themeColors = Array.from(
			html.matchAll(
				/<meta\s+name="theme-color"\s+content="([^"]+)"\s+media="([^"]+)"\s*\/?>/g,
			),
			([, color, media]) => ({ color, media }),
		);
		expect(themeColors).toEqual([
			{ color: "#F7F9F7", media: "(prefers-color-scheme: light)" },
			{ color: "#080D09", media: "(prefers-color-scheme: dark)" },
		]);
		expect(html).toContain(
			'<meta name="msapplication-TileColor" content="#080D09" />',
		);
	});

	it("removes the retired teal strokes from the shared logo", () => {
		const logo = readFileSync(
			resolve(frontendRoot, "src/lib/components/icons/Logo.svelte"),
			"utf8",
		);
		expect(logo).not.toContain("#11C4D4");
	});
});
