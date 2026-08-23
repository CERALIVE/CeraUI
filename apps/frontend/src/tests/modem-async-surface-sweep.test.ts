/**
 * THE SWEEP: every modem async surface the frontend actually dispatches has a
 * declared bound and a named terminal state.
 *
 * A registry that is only ever read by the code it describes rots the moment
 * somebody adds a procedure — so this gate DERIVES the surface set from shipped
 * source (`rpc.modems.<procedure>(` call sites) and holds it to SET EQUALITY
 * against `lib/modem/async-surface.ts`. Both directions fail loudly:
 *
 * - a NEW procedure with no registry row → nobody has said what bounds it, so
 *   its loading state is unbounded until somebody does;
 * - a registry row naming a procedure nothing calls → a bound for a wait that no
 *   longer exists, which is exactly the stale-manifest failure the parity gate
 *   was written to prevent.
 *
 * The scan is deliberately a CALL-SITE scan (`(` required) rather than a mention
 * scan: this file's own prose names procedures, and so do several module
 * headers, and a mention gate would have to be defended against its own
 * documentation.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	MODEM_ASYNC_SURFACES,
	type ModemAsyncSurfaceId,
} from "$lib/modem/async-surface";

const SELF = fileURLToPath(import.meta.url);
/** This file lives at `src/tests/…`; the frontend source root is one level up. */
const SRC_ROOT = path.resolve(path.dirname(SELF), "..");

const SCANNED_EXTENSIONS = new Set([".ts", ".svelte"]);

/**
 * The registry module is a DECLARATION, not a call site, and this file is the
 * gate. Neither dispatches anything, so scanning them would only ever measure
 * their own prose.
 */
const EXCLUDED_FILES = new Set([
	path.join(SRC_ROOT, "lib", "modem", "async-surface.ts"),
	SELF,
]);

function isScannable(file: string): boolean {
	if (EXCLUDED_FILES.has(file)) return false;
	const name = path.basename(file);
	// Tests and fixtures mock these procedures by name; a mock is not a surface.
	return !/\.(test|spec)\.[cm]?[jt]sx?$/.test(name);
}

function collectSourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "__fixtures__") {
			continue;
		}
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...collectSourceFiles(full));
		} else if (
			entry.isFile() &&
			SCANNED_EXTENSIONS.has(path.extname(entry.name)) &&
			isScannable(full)
		) {
			out.push(full);
		}
	}
	return out;
}

const CALL_SITE = /rpc\.modems\.([A-Za-z0-9_]+)\s*\(/g;

function dispatchedProcedures(files: readonly string[]): Map<string, string[]> {
	const found = new Map<string, string[]>();
	for (const file of files) {
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(CALL_SITE)) {
			const procedure = match[1];
			if (procedure === undefined) continue;
			const sites = found.get(procedure) ?? [];
			sites.push(path.relative(SRC_ROOT, file));
			found.set(procedure, sites);
		}
	}
	return found;
}

const FILES = collectSourceFiles(SRC_ROOT);
const DISPATCHED = dispatchedProcedures(FILES);
const REGISTERED = new Set(Object.keys(MODEM_ASYNC_SURFACES));

describe("modem async-surface sweep", () => {
	it("scans a non-trivial slice of the frontend, so the gate cannot pass vacuously", () => {
		expect(FILES.length).toBeGreaterThan(200);
		expect(DISPATCHED.size).toBeGreaterThan(20);
	});

	it("finds the call sites it claims to find", () => {
		// A broken regex would make every assertion below trivially true, so the
		// scanner is proven against two call sites whose files are named here.
		expect(DISPATCHED.get("getCapabilities")).toContain(
			path.join("main", "dialogs", "ModemCapabilitiesDialog.svelte"),
		);
		expect(DISPATCHED.get("setRouterSubnet")).toContain(
			path.join("main", "dialogs", "RouterDongleDialog.svelte"),
		);
	});

	it("ignores a MENTION that is not a dispatch", () => {
		// The scanner's own contract: prose naming a procedure must not register as
		// a surface, or every doc comment becomes a gate failure.
		const mentionOnly = "see rpc.modems.getCapabilities for the read";
		expect([...mentionOnly.matchAll(CALL_SITE)]).toHaveLength(0);
		const dispatch = "await rpc.modems.getCapabilities();";
		expect([...dispatch.matchAll(CALL_SITE)]).toHaveLength(1);
	});

	it("declares a bound for EVERY procedure the frontend dispatches", () => {
		const undeclared = [...DISPATCHED.keys()]
			.filter((procedure) => !REGISTERED.has(procedure))
			.sort();
		expect(
			undeclared,
			`modem procedures dispatched with NO declared bound: ${undeclared.join(", ")}`,
		).toEqual([]);
	});

	it("declares no bound for a wait that no longer exists", () => {
		const orphaned = [...REGISTERED]
			.filter((procedure) => !DISPATCHED.has(procedure))
			.sort();
		expect(
			orphaned,
			`registry rows naming procedures nothing dispatches: ${orphaned.join(", ")}`,
		).toEqual([]);
	});

	it("gives every dispatched surface a bound AND a terminal state", () => {
		for (const procedure of DISPATCHED.keys()) {
			const entry = MODEM_ASYNC_SURFACES[procedure as ModemAsyncSurfaceId];
			expect(entry, `${procedure} has no registry row`).toBeDefined();
			expect(entry.boundMs, `${procedure} has no bound`).toBeGreaterThan(0);
			expect(entry.terminal, `${procedure} has no expiry terminal`).toContain(
				"timed-out",
			);
			expect(
				entry.what.length,
				`${procedure} says nothing about the wait`,
			).toBeGreaterThan(0);
		}
	});

	it("routes every `read-bound` surface through the shared helper", () => {
		// A row can CLAIM `read-bound` and still await the raw RPC. The claim is
		// only worth anything if the file that dispatches it also imports the
		// helper that enforces it.
		const readBound = [...REGISTERED].filter(
			(procedure) =>
				MODEM_ASYNC_SURFACES[procedure as ModemAsyncSurfaceId].bound ===
				"read-bound",
		);
		expect(readBound.length).toBeGreaterThan(0);

		for (const procedure of readBound) {
			for (const relative of DISPATCHED.get(procedure) ?? []) {
				const source = readFileSync(path.join(SRC_ROOT, relative), "utf8");
				expect(
					source.includes("loadWithinBound"),
					`${relative} dispatches ${procedure} without the read bound`,
				).toBe(true);
			}
		}
	});
});
