/**
 * Deletion gate for the deprecated WS store wrapper.
 *
 * The legacy `$lib/stores/…` runes wrapper was deleted in the final step of the
 * WS-store migration (Wave 2): every shipped consumer moved to
 * `$lib/rpc/subscriptions.svelte` (status/config/etc.) and
 * `$lib/stores/auth-status.svelte` (auth). This test statically scans the entire
 * frontend source tree and fails if the forbidden module name reappears — so a
 * re-introduced import, or even a stray comment reference, can never silently
 * regress the migration.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Built by concatenation so THIS file never contains the contiguous literal it
// forbids — the scan below therefore finds nothing in its own source.
const FORBIDDEN = ["websocket", "store"].join("-");

const SELF = fileURLToPath(import.meta.url);
// This file lives at `src/tests/…`; the frontend source root is one level up.
const SRC_ROOT = path.resolve(path.dirname(SELF), "..");

const SCANNED_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".mjs",
	".cjs",
	".svelte",
	".css",
	".json",
	".md",
	".html",
]);

function collectSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...collectSourceFiles(full));
		} else if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
			out.push(full);
		}
	}
	return out;
}

describe("deprecated WS store deletion gate", () => {
	it("scans a non-trivial number of frontend source files", () => {
		// Guards against the scan silently degrading to zero files (a broken root
		// path would make the gate vacuously pass).
		expect(collectSourceFiles(SRC_ROOT).length).toBeGreaterThan(100);
	});

	it("no frontend source file references the deleted store module", () => {
		const offenders: string[] = [];
		for (const file of collectSourceFiles(SRC_ROOT)) {
			if (path.resolve(file) === SELF) continue; // never flag the gate itself
			const text = readFileSync(file, "utf8");
			if (text.includes(FORBIDDEN)) {
				const lineNo =
					text.split("\n").findIndex((line: string) => line.includes(FORBIDDEN)) +
					1;
				offenders.push(`${path.relative(SRC_ROOT, file)}:${lineNo}`);
			}
		}
		expect(
			offenders,
			`Forbidden reference to the deleted "${FORBIDDEN}" module found in:\n${offenders.join("\n")}`,
		).toEqual([]);
	});
});
