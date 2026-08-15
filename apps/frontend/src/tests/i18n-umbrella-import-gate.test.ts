/**
 * NO-UMBRELLA-IMPORT gate.
 *
 * Paraglide's `paraglide/messages.js` re-exports EVERY compiled message eagerly.
 * One import of it anywhere pulls the whole catalog into that chunk and makes
 * `ensureNamespace()` structurally incapable of splitting anything — the failure
 * is silent, since the app keeps working perfectly and only the bundle grows.
 *
 * App code therefore imports messages ONLY through `@ceraui/i18n/svelte`, which
 * is backed by the generated per-namespace barrels. This scan fails the build if
 * the umbrella (or the raw paraglide outdir) is reached for directly.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

// Assembled at runtime so this file never contains the contiguous literals it
// forbids, and therefore never matches its own scan.
const UMBRELLA = ["paraglide", "messages.js"].join("/");
const RAW_OUTDIR = ["@ceraui/i18n/src", "paraglide"].join("/");

const SCANNED_EXTENSIONS = new Set([".ts", ".svelte", ".js"]);

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walk(full);
		} else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
			yield full;
		}
	}
}

describe("paraglide umbrella import gate", () => {
	it("no frontend source reaches past the generated facade", () => {
		const offenders: string[] = [];
		for (const file of walk(SRC_ROOT)) {
			if (file === fileURLToPath(import.meta.url)) continue;
			const source = readFileSync(file, "utf8");
			if (source.includes(UMBRELLA) || source.includes(RAW_OUTDIR)) {
				offenders.push(path.relative(SRC_ROOT, file));
			}
		}
		expect(offenders).toEqual([]);
	});
});
