/**
 * Single-origin preview gate (Task 20).
 *
 * The preview WebSocket is proxied through the CeraUI backend origin (`/preview`)
 * — the frontend must NEVER dial the cerastream engine's loopback preview port
 * directly. This test statically scans shipped frontend source and fails if the
 * literal engine preview port, or the removed `VITE_PREVIEW_PORT` override,
 * reappears anywhere: a re-introduced direct-engine dial can never regress
 * silently past this gate.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Built by concatenation so THIS file never contains the contiguous literals it
// forbids — the scan below therefore finds nothing in its own source.
const ENGINE_PREVIEW_PORT = ["99", "97"].join("");
const REMOVED_PREVIEW_ENV = ["VITE", "PREVIEW", "PORT"].join("_");
const FORBIDDEN = [ENGINE_PREVIEW_PORT, REMOVED_PREVIEW_ENV];

const SELF = fileURLToPath(import.meta.url);
// This file lives at `src/tests/…`; the frontend source root is one level up.
const SRC_ROOT = path.resolve(path.dirname(SELF), "..");

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".svelte"]);

// Shipped source only — *.test.* / *.spec.* fixtures may legitimately mock URLs.
function isTestFile(name: string): boolean {
	return /\.(test|spec)\./.test(name);
}

function collectSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...collectSourceFiles(full));
		} else if (
			entry.isFile() &&
			SCANNED_EXTENSIONS.has(path.extname(entry.name)) &&
			!isTestFile(entry.name)
		) {
			out.push(full);
		}
	}
	return out;
}

describe("preview single-origin gate", () => {
	it("scans a non-trivial number of frontend source files", () => {
		expect(collectSourceFiles(SRC_ROOT).length).toBeGreaterThan(100);
	});

	it("no shipped frontend source dials the engine preview port directly", () => {
		const offenders: string[] = [];
		for (const file of collectSourceFiles(SRC_ROOT)) {
			const text = readFileSync(file, "utf8");
			for (const needle of FORBIDDEN) {
				if (text.includes(needle)) {
					offenders.push(`${path.relative(SRC_ROOT, file)} (${needle})`);
				}
			}
		}
		expect(
			offenders,
			`Forbidden non-backend-origin preview reference found in:\n${offenders.join("\n")}`,
		).toEqual([]);
	});
});
