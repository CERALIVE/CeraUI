import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { BRAND_CONFIG } from "$lib/config/branding";

import { BUILD_BRAND } from "../../brand.config";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const frontendRoot = resolve(repoRoot, "apps/frontend");
const html = readFileSync(resolve(frontendRoot, "index.html"), "utf8");

describe("brand identity", () => {
	it("uses the same product name and descriptions at build time and runtime", () => {
		const i18nBranding = readFileSync(
			resolve(repoRoot, "packages/i18n/src/branding.ts"),
			"utf8",
		);
		expect(BUILD_BRAND.siteName).toBe("CeraUI for CeraLive");
		expect(BRAND_CONFIG.siteName).toBe(BUILD_BRAND.siteName);
		expect(i18nBranding.match(/siteName:\s*"([^"]+)"/)?.[1]).toBe(
			BUILD_BRAND.siteName,
		);
		expect(BUILD_BRAND.description).toBe(BRAND_CONFIG.description);
		expect(BUILD_BRAND.deviceName).toBe(BRAND_CONFIG.deviceName);
		expect(BUILD_BRAND.appName).toBe(BRAND_CONFIG.appName);
	});

	it.each([
		"#11C4D4",
		"#1FE7F9",
		"#0EA8B8",
		"#0b0f1a",
		"#f5f7fa",
		"#dee2ea",
		"#1a2030",
		"#ebeef3",
		"#94a0b4",
		"#6b7280",
		"#111827",
	])("keeps retired colour %s out of preboot HTML", (hex) => {
		expect(html).not.toMatch(new RegExp(hex, "i"));
	});

	it("removes retired typography and display spelling from preboot HTML", () => {
		expect(html).not.toContain("Plus Jakarta");
		expect(html).not.toContain("CERALIVE");
		expect(html).not.toContain("©");
	});

	it("gives both preboot screens decorative marks in both colour schemes", () => {
		const pictures = html.match(/<picture>[\s\S]*?<\/picture>/g) ?? [];
		expect(pictures).toHaveLength(2);
		for (const picture of pictures) {
			expect(picture).toMatch(
				/<source\b[^>]*srcset="\/brand\/ceralive-mark-small-dark\.svg"[^>]*media="\(prefers-color-scheme: dark\)"/,
			);
			expect(picture).toMatch(
				/<img\b[^>]*src="\/brand\/ceralive-mark-small-light\.svg"[^>]*alt=""/,
			);
		}
	});

	it("keeps the JavaScript failure screen independent of external artwork", () => {
		const failureScreen = html.match(/id="js-failed"[\s\S]*?<\/div>/)?.[0];
		expect(failureScreen).toBeDefined();
		expect(failureScreen).not.toMatch(/<img|<picture|url\(/i);
	});

	it.each([
		"vite.config.ts",
		"vite.federation.config.ts",
		"vitest.config.ts",
		"vitest.federation.config.ts",
		"pwa.config.ts",
	])("shares build branding in %s", (file) => {
		const config = readFileSync(resolve(frontendRoot, file), "utf8");
		expect(config).toContain("BUILD_BRAND");
		expect(config).not.toContain("CERALIVE©");
		expect(config).not.toContain('"CERALIVE"');
	});

	it("uses CeraLive casing in the English update notification", () => {
		const messages = JSON.parse(
			readFileSync(resolve(repoRoot, "packages/i18n/messages/en.json"), "utf8"),
		);
		expect(messages["notifications.ceraliveUpdateAvailable"]).toContain(
			"CeraLive",
		);
		expect(messages["notifications.ceraliveUpdateAvailable"]).not.toContain(
			"CERALIVE",
		);
	});
});
