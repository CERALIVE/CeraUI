import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The device app pins the root `color-scheme` to the theme it paints, so
 * browser auto dark modes leave it alone (color-scheme.css). The hosted dialog
 * bundles load their stylesheet into a host page whose root scheme belongs to
 * the host, so nothing that stylesheet pulls in may declare one.
 */
function localStylesheetGraph(entry: URL): Map<string, string> {
	const sheets = new Map<string, string>();
	const pending = [entry];
	while (pending.length > 0) {
		const url = pending.pop() as URL;
		if (sheets.has(url.href)) continue;
		const css = readFileSync(url, "utf8");
		sheets.set(url.href, css);
		for (const [, spec] of css.matchAll(/@import\s+["']([^"']+)["']/g)) {
			if (spec.startsWith(".")) pending.push(new URL(spec, url));
		}
	}
	return sheets;
}

describe("root color-scheme", () => {
	const federation = localStylesheetGraph(
		new URL("./federation.css", import.meta.url),
	);

	it("NON-VACUITY: the hosted dialog stylesheet pulls in app.css", () => {
		expect(
			[...federation.keys()].some((href) => href.endsWith("/src/app.css")),
		).toBe(true);
	});

	it("is never declared by the stylesheet the hosted dialogs load", () => {
		for (const [href, css] of federation) {
			expect(css, href).not.toMatch(/color-scheme\s*:/);
		}
	});

	it("is pinned by a stylesheet only the device app entry loads", () => {
		const entry = new URL("../../main.ts", import.meta.url);
		const sheet = new URL("../../color-scheme.css", import.meta.url);
		expect(readFileSync(entry, "utf8")).toMatch(
			/import\s+["']\.\/color-scheme\.css["']/,
		);
		expect(existsSync(sheet)).toBe(true);
		expect(readFileSync(sheet, "utf8")).toMatch(
			/:root\s*\{\s*color-scheme:\s*only light !important;/,
		);
	});
});
