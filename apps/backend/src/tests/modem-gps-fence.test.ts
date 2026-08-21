/*
 * The GPS module holds the CURRENT fix and nothing else, and this is the lock.
 *
 * A comment saying "never add location history" is not a control — the next
 * person to touch this surface will not read it, and a location-history feature
 * is the single most obvious thing to add to a module that already knows where
 * the device is. This test greps the ACTUAL GPS source for the primitives such a
 * feature would have to go through — a filesystem write, a network call, a
 * browser store — and for the identifiers it would be named after, and fails the
 * build if one appears.
 *
 * This is a PRODUCT fence, not a phase limitation: no history, no track log, no
 * export, no upload. Deleting or weakening this test to land one is exactly the
 * move it exists to stop. If the product genuinely decides to ship location
 * history, that is a new spec change with its own consent and retention design —
 * and this file is where that decision has to be argued.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BACKEND_SRC = join(import.meta.dir, "..");
const REPO_ROOT = join(BACKEND_SRC, "..", "..", "..");

/** Every file that carries a coordinate, or could decide to keep one. */
const GPS_SOURCES = [
	join(BACKEND_SRC, "modules", "modems", "gps.ts"),
	join(BACKEND_SRC, "modules", "modems", "gps-fix-state.ts"),
	join(BACKEND_SRC, "modules", "modems", "mmcli-location.ts"),
	join(REPO_ROOT, "packages", "rpc", "src", "schemas", "modems.schema.ts"),
];

/**
 * The primitives a fix would have to travel through to OUTLIVE the moment it was
 * read. `saveConfig` is named explicitly because it is this backend's own
 * persistence verb and would not otherwise match a filesystem pattern.
 */
const FORBIDDEN_PRIMITIVES: ReadonlyArray<{ label: string; re: RegExp }> = [
	{
		label: "a filesystem write",
		re: /\b(?:writeFile|appendFile|createWriteStream)\b/,
	},
	{ label: "Bun.write", re: /Bun\.write\b/ },
	{ label: "the config persistence verb", re: /\bsaveConfig\b/ },
	{ label: "a network call", re: /\bfetch\s*\(/ },
	{ label: "an XHR", re: /\bXMLHttpRequest\b/ },
	{
		label: "a browser store",
		re: /\b(?:localStorage|sessionStorage|indexedDB)\b/,
	},
];

/** The names a history / tracking / upload surface would be given. */
const FORBIDDEN_IDENTIFIERS: ReadonlyArray<{ label: string; re: RegExp }> = [
	{
		label: "a location-history identifier",
		re: /\b\w*(?:fix|location|gps|gnss)History\b/i,
	},
	{
		label: "a track-log identifier",
		re: /\b(?:trackLog|trackPoints|breadcrumb\w*|waypoint\w*)\b/i,
	},
	{
		label: "a start/stop-tracking identifier",
		re: /\b(?:start|stop)Tracking\b/i,
	},
	{
		label: "a fix-upload identifier",
		re: /\b(?:upload|publish|export|archive)(?:Fix|Location|Gps|Gnss|Track)\b/i,
	},
	{
		label: "a fix-persistence identifier",
		re: /\bpersist(?:Fix|Location|Gps|Gnss)\b/i,
	},
];

/**
 * Scan CODE, not prose. This module's own documentation states the fence by
 * NAMING the things it forbids, and a gate that cannot tell "we will never add
 * a track log" from an actual `trackLog` is a gate nobody can document around.
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.split("\n")
		.filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
		.join("\n");
}

const CODE = new Map(
	GPS_SOURCES.map((path) => [path, stripComments(readFileSync(path, "utf8"))]),
);

describe("the GPS module keeps only the current fix, and stays that way", () => {
	it("scans the files that actually carry a coordinate", () => {
		// Guards the gate itself: a moved or renamed module would otherwise make
		// this suite pass vacuously by scanning nothing.
		expect(CODE.size).toBe(GPS_SOURCES.length);
		for (const [path, code] of CODE) {
			expect(code.length, `${path} must not be empty`).toBeGreaterThan(200);
		}
	});

	it("no GPS source reaches a filesystem, a network, or a browser store", () => {
		for (const [path, code] of CODE) {
			for (const { label, re } of FORBIDDEN_PRIMITIVES) {
				expect(re.test(code), `${path} must not use ${label}`).toBe(false);
			}
		}
	});

	it("no GPS source declares a history / tracking / upload surface", () => {
		for (const [path, code] of CODE) {
			for (const { label, re } of FORBIDDEN_IDENTIFIERS) {
				expect(re.test(code), `${path} must not declare ${label}`).toBe(false);
			}
		}
	});

	it("the RPC surface offers exactly two GPS procedures — read and toggle", () => {
		const contract = stripComments(
			readFileSync(
				join(
					REPO_ROOT,
					"packages",
					"rpc",
					"src",
					"contracts",
					"modems.contract.ts",
				),
				"utf8",
			),
		);
		const gpsProcedures = [...contract.matchAll(/^\t(\w*[Gg]ps\w*):/gm)].map(
			(match) => match[1],
		);
		expect(gpsProcedures.sort()).toEqual(["getGps", "setGps"]);
	});

	it("the wire state can carry AT MOST ONE fix — the fence as a type", () => {
		const schema = CODE.get(
			join(REPO_ROOT, "packages", "rpc", "src", "schemas", "modems.schema.ts"),
		);
		expect(schema).toBeDefined();
		// An array of fixes IS a history, whatever it is called, so the schema
		// must never wrap the fix schema in one.
		expect(/z\.array\(\s*gnssFixSchema/.test(schema ?? "")).toBe(false);
	});

	it("the detector is not vacuous — it flags a history surface if one is added", () => {
		const rogue = stripComments(`
			export async function uploadFix(fix: GnssFix) {
				await fetch("https://example.invalid", { method: "POST" });
			}
			export const fixHistory: GnssFix[] = [];
			export function startTracking() {}
		`);
		const flagged = [...FORBIDDEN_PRIMITIVES, ...FORBIDDEN_IDENTIFIERS].filter(
			({ re }) => re.test(rogue),
		);
		expect(flagged.length).toBeGreaterThanOrEqual(4);
	});
});
