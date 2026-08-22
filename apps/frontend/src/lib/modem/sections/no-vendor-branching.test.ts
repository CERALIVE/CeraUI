/**
 * THE STATIC GATE: nothing under `lib/modem/sections/` may know what KIND of
 * device it is rendering for.
 *
 * "Both dialogs render through one path" is a promise, and a promise a reviewer
 * has to re-check by eye is one that quietly stops being true. This is the
 * mechanism: the shipped source of this directory is read from disk, stripped of
 * comments and strings-that-are-only-comments, and scanned for the vocabulary a
 * family branch is written in. Any hit fails, naming the file and the token.
 *
 * ── WHY COMMENT-STRIPPED ────────────────────────────────────────────────────
 *
 * These modules earn their comments by explaining WHY a rule exists, and the
 * clearest way to explain a rule against vendor branching is to name the vendors
 * it once branched on. A gate that banned the word from prose would trade the
 * explanation for the enforcement. The stripper removes `//`, block comments and
 * HTML comments (Svelte prose lives in the last), leaving code and template.
 *
 * ── WHY THE SCAN EXCLUDES TESTS AND FIXTURES ───────────────────────────────
 *
 * This file has to CONTAIN the banned tokens to look for them, and a fixture has
 * to be able to build a device that resembles a real one. The scan is over
 * SHIPPED SOURCE — the same rule `check-tech-debt.mjs` applies — so the gate can
 * name the thing it forbids without tripping over itself.
 *
 * ── NON-VACUITY ─────────────────────────────────────────────────────────────
 *
 * The scanner is a PURE function over `{path, source}` records, so the control
 * feeds it a deliberately-violating file rather than writing one into the tree.
 * Writing a real file would race the other spec files sharing this directory and
 * would leave a violation behind on a failed run.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The vocabulary a family branch is written in — vendors, dialects and the two
 * transport-class literals the row model uses. Matching is case-insensitive and
 * substring-based on purpose: `Huawei`, `HILINK` and `isRouterEthernet` are all
 * the same mistake.
 */
const BANNED = [
	"huawei",
	"zte",
	"himi",
	"ufi",
	"hilink",
	"quectel",
	"simcom",
	"fibocom",
	"mm-managed",
	"router-ethernet",
] as const;

const SECTIONS_DIR = join(
	import.meta.dirname ?? new URL(".", import.meta.url).pathname,
);

interface ScannedFile {
	readonly path: string;
	readonly source: string;
}

interface Violation {
	readonly path: string;
	readonly token: string;
}

/**
 * Remove `//` line comments, `/* *\/` block comments and `<!-- -->` HTML
 * comments. Deliberately simple: it can over-strip a `//` inside a string
 * literal, which makes the gate MORE permissive about prose and no less strict
 * about code — a family branch cannot hide inside a URL.
 */
export function stripComments(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export function scanForFamilyBranching(
	files: readonly ScannedFile[],
): Violation[] {
	const violations: Violation[] = [];
	for (const file of files) {
		const code = stripComments(file.source).toLowerCase();
		for (const token of BANNED) {
			if (code.includes(token)) violations.push({ path: file.path, token });
		}
	}
	return violations;
}

/** Shipped source only — see the header for why tests and fixtures are out. */
function isShippedSource(relative: string): boolean {
	if (relative.includes("__fixtures__")) return false;
	if (/\.(test|spec)\.[a-z]+$/.test(relative)) return false;
	return /\.(ts|svelte)$/.test(relative);
}

function collect(dir: string, prefix = ""): ScannedFile[] {
	const out: ScannedFile[] = [];
	for (const entry of readdirSync(dir)) {
		const absolute = join(dir, entry);
		const relative = prefix === "" ? entry : `${prefix}/${entry}`;
		if (statSync(absolute).isDirectory()) {
			out.push(...collect(absolute, relative));
			continue;
		}
		if (!isShippedSource(relative)) continue;
		out.push({ path: relative, source: readFileSync(absolute, "utf8") });
	}
	return out;
}

const SHIPPED = collect(SECTIONS_DIR);

describe("the scanner itself", () => {
	it("finds real files to scan — an empty sweep FAILS", () => {
		expect(SHIPPED.length).toBeGreaterThanOrEqual(8);
		expect(SHIPPED.map((f) => f.path)).toContain("derive.ts");
		expect(SHIPPED.map((f) => f.path)).toContain("CapabilitySection.svelte");
	});

	it("excludes tests and fixtures, which must be able to name a real device", () => {
		for (const file of SHIPPED) {
			expect(file.path).not.toMatch(/\.test\.ts$/);
			expect(file.path).not.toContain("__fixtures__");
		}
	});

	/*
	  THE NON-VACUITY CONTROL. A deliberately-inserted violation must trip the
	  scanner — otherwise a green gate proves only that the scanner is broken.
	  Fed as data rather than written to disk: a real file would race the sibling
	  specs sharing this directory and would survive a failed run.
	*/
	it("trips on a deliberately-inserted violation", () => {
		const planted = scanForFamilyBranching([
			{
				path: "planted.ts",
				source: 'if (modem.device_class === "router-ethernet") return "x";',
			},
		]);

		expect(planted).toEqual([{ path: "planted.ts", token: "router-ethernet" }]);
	});

	it("trips on a vendor branch however it is spelled", () => {
		const planted = scanForFamilyBranching([
			{ path: "a.svelte", source: "{#if isHUAWEI(modem)}<span/>{/if}" },
			{ path: "b.ts", source: "const dialect = 'Zte';" },
			{ path: "c.ts", source: "export const QUECTEL_IDS = [];" },
		]);

		expect(planted.map((v) => v.token).sort()).toEqual([
			"huawei",
			"quectel",
			"zte",
		]);
	});

	/*
	  The stripper is why the modules above can explain themselves. Prove it works
	  in BOTH directions, or a future "tidy" could silently disable the gate by
	  over-stripping.
	*/
	it("ignores the vocabulary inside comments", () => {
		const commented = scanForFamilyBranching([
			{
				path: "prose.ts",
				source: [
					"// This used to branch on hilink; it must not again.",
					"/* zte and ufi were the other two. */",
					"export const ok = 1;",
				].join("\n"),
			},
			{
				path: "prose.svelte",
				source: "<!-- a huawei dongle publishes no status -->\n<span></span>",
			},
		]);

		expect(commented).toEqual([]);
	});

	it("does NOT strip code that merely follows a comment", () => {
		const mixed = scanForFamilyBranching([
			{
				path: "mixed.ts",
				source: "// a note\nconst vendor = 'fibocom';\n",
			},
		]);

		expect(mixed).toEqual([{ path: "mixed.ts", token: "fibocom" }]);
	});
});

describe("lib/modem/sections/** never branches on vendor, transport, model or family", () => {
	it("has no hit in any shipped file", () => {
		const violations = scanForFamilyBranching(SHIPPED);

		expect(
			violations,
			violations.length === 0
				? ""
				: `family branching in lib/modem/sections/: ${violations
						.map((v) => `${v.path} → "${v.token}"`)
						.join(", ")}`,
		).toEqual([]);
	});
});
