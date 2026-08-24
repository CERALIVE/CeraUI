/**
 * THE MODEM PARITY DRIFT GATE — a capability the UI has not dispositioned FAILS.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY A GATE AND NOT A DOCUMENT
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The modem stack and CeraUI's own modem RPC surface both grow on their own
 * release cycles. A prose audit of what is wired is true on the day it is
 * written and silently false afterwards, which is exactly how the USSD backend
 * came to ship complete with no operator surface and nothing saying so. This
 * gate turns "somebody dispositioned every surface" into a build failure.
 *
 * It reads `$lib/modem/parity-manifest.ts` and holds it against two live
 * sources, neither of which is a list re-typed inside this file:
 *
 *   TIER 1 (active) — the pinned `@ceralive/modem-control` package's exported
 *   capability-module list, and the modem RPC procedure set CeraUI's OWN backend
 *   router dispatches. Both are strict set equality in BOTH directions: a
 *   capability present and un-dispositioned fails, and a manifest key naming
 *   nothing fails (which is what catches stale rows on a version bump).
 *
 *   TIER 2 (active) — the pinned package's `MODEM_OPERATION_IDS` enumerable
 *   operation-id registry. The manifest must equal it in both directions.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * RULE D — NOTHING HERE READS ABOVE THE CeraUI CHECKOUT ROOT
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Both live sources are inside this checkout: the package is resolved through
 * the backend workspace's OWN dependency graph (so it is the exact pinned
 * release the device runs, not whatever a hoist left at the workspace root), and
 * the router is read from `apps/backend/src`. The workspace-level parity ledger
 * that informed the manifest's dispositions is a human artifact and is
 * deliberately not read here, by path or otherwise.
 *
 * The package is resolved rather than IMPORTED on purpose: CeraUI's frontend
 * does not depend on `@ceralive/modem-control`, and a bare import from here
 * would resolve through workspace hoisting to whatever version happens to sit at
 * the root — a different release from the one the backend pins. The version
 * assertion below is what makes the resolution self-checking.
 */

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	BACKEND_RPC_PARITY,
	CAPABILITY_MODULE_PARITY,
	OPERATION_PARITY,
	type ParityRecord,
	UI_DISPOSITIONS,
} from "$lib/modem/parity-manifest";

/** The package-owned registry tier 2 arms against once modem-stack exports it. */
const OPERATION_REGISTRY_EXPORT = "MODEM_OPERATION_IDS";

/** A symbol the package DOES export, used to prove the dist scanner is non-vacuous. */
const KNOWN_DIST_EXPORT = "CAPABILITY_MODULES";

const PACKAGE_NAME = "@ceralive/modem-control";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `apps/frontend/src/tests` → the CeraUI checkout root. Never above it. */
const CERAUI_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const BACKEND_PACKAGE_JSON = path.join(
	CERAUI_ROOT,
	"apps",
	"backend",
	"package.json",
);
const BACKEND_ROUTER = path.join(
	CERAUI_ROOT,
	"apps",
	"backend",
	"src",
	"rpc",
	"router.ts",
);

interface ResolvedPackage {
	readonly root: string;
	readonly version: string;
	readonly pinned: string;
}

function resolvePinnedPackage(): ResolvedPackage {
	const backendManifest = JSON.parse(
		readFileSync(BACKEND_PACKAGE_JSON, "utf8"),
	) as {
		dependencies?: Record<string, string>;
	};
	const pinned = backendManifest.dependencies?.[PACKAGE_NAME];
	if (pinned === undefined) {
		throw new Error(
			`${PACKAGE_NAME} is not a dependency of apps/backend — the parity gate has nothing to hold the manifest against.`,
		);
	}
	const resolveFrom = createRequire(BACKEND_PACKAGE_JSON);
	const manifestPath = resolveFrom.resolve(`${PACKAGE_NAME}/package.json`);
	const resolved = JSON.parse(readFileSync(manifestPath, "utf8")) as {
		version: string;
	};
	return {
		root: path.dirname(manifestPath),
		version: resolved.version,
		pinned,
	};
}

/**
 * Read a flat frozen string array out of the package's EMITTED JavaScript.
 *
 * Reading the emit rather than importing the module keeps this probe off the
 * package's runtime graph (its root entry pulls a D-Bus transport), so the gate
 * cannot fail for a reason that has nothing to do with parity.
 */
function readStringArrayLiteral(
	source: string,
	name: string,
): string[] | undefined {
	const match = new RegExp(
		`${name}\\s*=\\s*(?:Object\\.freeze\\()?\\[([^\\]]*)\\]`,
	).exec(source);
	const body = match?.[1];
	if (body === undefined) return undefined;
	const members: string[] = [];
	for (const literal of body.matchAll(/['"]([^'"]+)['"]/g)) {
		const value = literal[1];
		if (value !== undefined) members.push(value);
	}
	return members.length > 0 ? members : undefined;
}

function distJavaScriptFiles(distRoot: string): string[] {
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".js")) files.push(full);
		}
	};
	walk(distRoot);
	return files;
}

/** Find a frozen string array anywhere in the package's emitted output. */
function findDistStringArray(
	distRoot: string,
	name: string,
): string[] | undefined {
	for (const file of distJavaScriptFiles(distRoot)) {
		const source = readFileSync(file, "utf8");
		if (!source.includes(name)) continue;
		const members = readStringArrayLiteral(source, name);
		if (members !== undefined) return members;
	}
	return undefined;
}

/**
 * The procedure keys of one `base.router({ … })` block in the backend router.
 *
 * Derived from the router source so the gate cannot drift from what the device
 * really dispatches; a re-typed list here would go stale on the exact change
 * this gate exists to catch.
 */
function backendRouterProcedures(source: string, routerName: string): string[] {
	const anchor = source.indexOf(`${routerName}: base.router({`);
	if (anchor === -1) return [];
	const open = source.indexOf("{", source.indexOf("base.router(", anchor));
	let depth = 0;
	let close = -1;
	for (let index = open; index < source.length; index += 1) {
		const char = source[index];
		if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) {
				close = index;
				break;
			}
		}
	}
	if (close === -1) return [];
	const body = source.slice(open + 1, close).replace(/\/\/[^\n]*/g, "");
	const keys: string[] = [];
	for (const entry of body.matchAll(/(?:^|\n)\s*([A-Za-z][A-Za-z0-9]*)\s*:/g)) {
		const key = entry[1];
		if (key !== undefined) keys.push(`${routerName}.${key}`);
	}
	return keys;
}

function missingFrom(
	expected: readonly string[],
	actual: readonly string[],
): string[] {
	const held = new Set(actual);
	return expected.filter((key) => !held.has(key)).sort();
}

const PACKAGE = resolvePinnedPackage();
const PACKAGE_DIST = path.join(PACKAGE.root, "dist");
const ROUTER_SOURCE = readFileSync(BACKEND_ROUTER, "utf8");

describe("the gate holds the manifest against LIVE sources", () => {
	it("resolves the EXACT release the backend pins, not a hoisted neighbour", () => {
		expect(PACKAGE.pinned).toMatch(/^\d+\.\d+\.\d+$/);
		expect(PACKAGE.version).toBe(PACKAGE.pinned);
	});

	it("derives the backend's modem procedures from the router source", () => {
		const procedures = backendRouterProcedures(ROUTER_SOURCE, "modems");
		// Non-vacuity: a broken extractor must not read as "the backend dispatches
		// nothing", which would make the coverage assertion below pass trivially.
		expect(procedures.length).toBeGreaterThan(10);
		expect(procedures).toContain("modems.getAll");
		expect(new Set(procedures).size).toBe(procedures.length);
	});
});

describe("tier 1 — the manifest EQUALS the package's capability-module list", () => {
	const packageModules = findDistStringArray(PACKAGE_DIST, KNOWN_DIST_EXPORT);

	it("reads the capability modules out of the pinned package", () => {
		expect(packageModules).toBeDefined();
		expect(packageModules?.length).toBeGreaterThan(0);
	});

	it("disposition every capability module the package exports", () => {
		const modules = packageModules ?? [];
		const undispositioned = missingFrom(
			modules,
			Object.keys(CAPABILITY_MODULE_PARITY),
		);
		expect(
			undispositioned,
			`capability modules the package exports with NO manifest disposition: ${undispositioned.join(", ")}`,
		).toEqual([]);
	});

	it("holds no capability-module key that names nothing", () => {
		const modules = packageModules ?? [];
		const stale = missingFrom(Object.keys(CAPABILITY_MODULE_PARITY), modules);
		expect(
			stale,
			`stale manifest capability-module keys naming nothing the package exports: ${stale.join(", ")}`,
		).toEqual([]);
	});
});

describe("tier 1 — the manifest COVERS every modem RPC the backend dispatches", () => {
	const procedures = backendRouterProcedures(ROUTER_SOURCE, "modems");

	it("disposition every modem procedure the backend router registers", () => {
		const undispositioned = missingFrom(
			procedures,
			Object.keys(BACKEND_RPC_PARITY),
		);
		expect(
			undispositioned,
			`modem RPC procedures the backend dispatches with NO manifest disposition: ${undispositioned.join(", ")}`,
		).toEqual([]);
	});

	it("holds no backend-RPC key that names nothing", () => {
		const stale = missingFrom(Object.keys(BACKEND_RPC_PARITY), procedures);
		expect(
			stale,
			`stale manifest backend-RPC keys naming no registered procedure: ${stale.join(", ")}`,
		).toEqual([]);
	});
});

describe("tier 2 — the manifest EQUALS the package operation registry", () => {
	it("proves the dist scanner is non-vacuous before trusting its verdict", () => {
		expect(findDistStringArray(PACKAGE_DIST, KNOWN_DIST_EXPORT)).toBeDefined();
	});

	it(`EQUALS ${OPERATION_REGISTRY_EXPORT}`, () => {
		const registry = findDistStringArray(
			PACKAGE_DIST,
			OPERATION_REGISTRY_EXPORT,
		);

		expect(registry).toBeDefined();
		expect(registry?.length).toBeGreaterThan(0);

		const undispositioned = missingFrom(
			registry ?? [],
			Object.keys(OPERATION_PARITY),
		);
		expect(
			undispositioned,
			`operation ids the package registry exports with NO manifest disposition: ${undispositioned.join(", ")}`,
		).toEqual([]);

		const stale = missingFrom(Object.keys(OPERATION_PARITY), registry ?? []);
		expect(
			stale,
			`stale manifest operation keys naming nothing the package registry exports: ${stale.join(", ")}`,
		).toEqual([]);
	});
});

describe("a disposition is a SENTENCE, not a boolean", () => {
	const records: ReadonlyArray<readonly [string, ParityRecord]> = [
		["capability modules", CAPABILITY_MODULE_PARITY],
		["provider operations", OPERATION_PARITY],
		["backend RPC", BACKEND_RPC_PARITY],
	];

	it.each(records)(
		"%s — every row carries a one-line reason",
		(_label, record) => {
			for (const [key, row] of Object.entries(record)) {
				expect(
					UI_DISPOSITIONS,
					`${key} carries an unknown disposition`,
				).toContain(row.disposition);
				expect(
					row.reason.trim().length,
					`${key} carries an empty reason`,
				).toBeGreaterThan(20);
				expect(row.reason, `${key}'s reason is not one line`).not.toContain(
					"\n",
				);
			}
		},
	);

	it("records the gaps rather than hiding them — an all-wired manifest is a failed audit", () => {
		const dispositions = [
			...Object.values(CAPABILITY_MODULE_PARITY),
			...Object.values(OPERATION_PARITY),
			...Object.values(BACKEND_RPC_PARITY),
		].map((row) => row.disposition);

		expect(dispositions).toContain("wired");
		expect(dispositions).toContain("unwired");
		expect(dispositions).toContain("absent");
		expect(dispositions).toContain("not-applicable");
	});
});
