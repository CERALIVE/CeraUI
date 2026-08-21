/*
 * `sethimiusbtether` is a PERMANENT fence, and this is the lock.
 *
 * It is the UFI/HiMi router dongle's own admin verb for flipping USB tethering
 * mode. CeraLive does not switch a UFI stick's composition, and it is not going
 * to: those devices are `router-ethernet` rows with no ModemManager control
 * port, the certified catalog's schema forbids MM↔router transitions outright,
 * and the only evidence anyone has for what that verb does on this fleet's
 * hardware is that nobody has ever run it. A composition write with no reviewed
 * evidence bundle behind it is exactly what the certification model exists to
 * refuse — and on a stick whose only remaining function is carrying the
 * operator's bonded uplink, an unproven write costs the link.
 *
 * So the verb must be absent from every surface at once: the catalogs, the RPCs,
 * the UI, the tests, and the automation. A comment saying so is not a control;
 * this scan is. Deleting or narrowing this test to land such a write is the move
 * it exists to stop — if the product ever decides otherwise, that is a new spec
 * change with its own evidence bundle and interlock design, and this file is
 * where it has to be argued.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CERTIFIED_CATALOG } from "@ceralive/modem-control";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

/**
 * The files allowed to name the verb in EXECUTABLE code, because naming it is
 * how they forbid it. Both are fences; a fence that cannot spell its own target
 * cannot enforce anything. The list is asserted NON-VACUOUS below, so an
 * exemption that stops being needed fails this suite instead of quietly
 * covering for a future call site.
 */
const FENCE_FILES = [
	"usb-tether-fence.test.ts",
	// The ZTE/UFI read-expansion fence: the verb is one entry in its own
	// forbidden-pattern table.
	"router-read-expansion.test.ts",
];

/**
 * Directories with no first-party source in them. `node_modules` matters most:
 * without it the walk reads tens of thousands of vendored files.
 */
const SKIP_DIRS = new Set([
	".git",
	".svelte-kit",
	"build",
	"coverage",
	"dist",
	"node_modules",
	"playwright-report",
	"test-results",
]);

/**
 * Code, config and automation. `.md` is deliberately excluded for the reason the
 * SMS read-only gate excludes prose: the fence has to be DOCUMENTABLE by name,
 * and a gate that cannot tell "never add `sethimiusbtether`" from an actual call
 * is a gate nobody can write down.
 */
const SCANNED_EXTENSIONS = [
	".ts",
	".tsx",
	".js",
	".mjs",
	".cjs",
	".svelte",
	".json",
	".yml",
	".yaml",
	".sh",
];

/**
 * The verb, case-insensitively, and tolerant of the spellings a caller might
 * reach for: `sethimiusbtether`, `setHiMiUsbTether`, `set_himi_usb_tether`,
 * `SET-HIMI-USB-TETHER`. Matching only the exact lowercase literal would let a
 * camelCase identifier or a snake_case config key walk straight through.
 */
const FORBIDDEN = /set[_\-\s]*himi[_\-\s]*usb[_\-\s]*tether/i;

function collectFiles(target: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(target, { withFileTypes: true })) {
		if (entry.name.startsWith(".") && entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
		}
		const child = join(target, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			found.push(...collectFiles(child));
			continue;
		}
		if (FENCE_FILES.includes(entry.name)) continue;
		if (!SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
		found.push(child);
	}
	return found;
}

/**
 * Scan CODE, not commentary — the same rule the SMS gate follows, so this fence
 * can be explained in place. Full-line and block comments go; a trailing `//` on
 * a code line is left alone so a URL in a string cannot swallow the line.
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.split("\n")
		.filter((line) => !/^\s*(?:\/\/|\*|#)/.test(line))
		.join("\n");
}

const FILES = collectFiles(REPO_ROOT);

describe("the UFI usb-tether write is absent from every surface, permanently", () => {
	it("scans the whole repo, not a subdirectory of it", () => {
		// Guards the gate itself: a moved root or an over-broad skip list would
		// otherwise make every assertion below pass vacuously.
		expect(FILES.length).toBeGreaterThan(500);
		const relative = FILES.map((path) => path.slice(REPO_ROOT.length + 1));
		for (const surface of [
			"apps/backend/src/rpc/procedures/modems.procedure.ts",
			"apps/frontend/src/main/dialogs/ModemConfigDialog.svelte",
			"packages/rpc/src/schemas/modems.schema.ts",
		]) {
			expect(relative, `${surface} must be in scan scope`).toContain(surface);
		}
		expect(
			relative.some((path) => path.startsWith("apps/frontend/tests/e2e/")),
			"the e2e suite must be in scan scope",
		).toBe(true);
		expect(
			relative.some((path) => path.startsWith(".github/workflows/")),
			"CI automation must be in scan scope",
		).toBe(true);
	});

	it("appears in NO catalog, RPC, UI, test or automation file", () => {
		const offenders = FILES.filter((path) =>
			FORBIDDEN.test(stripComments(readFileSync(path, "utf8"))),
		).map((path) => path.slice(REPO_ROOT.length + 1));

		expect(offenders).toEqual([]);
	});

	it("every fence exemption is still EARNING it", () => {
		// An exemption whose file no longer names the verb is a hole left open for
		// nothing — and the next call site added to that file would inherit it.
		for (const name of FENCE_FILES) {
			if (name === "usb-tether-fence.test.ts") continue;
			const path = join(import.meta.dir, name);
			expect(
				FORBIDDEN.test(stripComments(readFileSync(path, "utf8"))),
				`${name} is exempted but no longer names the verb — drop the exemption`,
			).toBe(true);
		}
	});

	it("appears nowhere in the certified catalog this device consumes", () => {
		expect(FORBIDDEN.test(JSON.stringify(CERTIFIED_CATALOG))).toBe(false);
	});

	it("the detector actually detects — proven against planted spellings", () => {
		// A fence that cannot fail is not a fence. Each of these is a shape a real
		// caller would plausibly write.
		const planted = [
			'await post("sethimiusbtether");',
			"const setHiMiUsbTether = 1;",
			"set_himi_usb_tether=1",
			'{"cmd": "SET-HIMI-USB-TETHER"}',
		];
		for (const sample of planted) {
			expect(FORBIDDEN.test(stripComments(sample)), sample).toBe(true);
		}
		// …and does not fire on the neighbouring verbs that ARE legitimate.
		for (const sample of ['post("goform_get_cmd_process")', 'post("login")']) {
			expect(FORBIDDEN.test(sample), sample).toBe(false);
		}
	});
});
