/// <reference types="node" />

/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * THE STATIC GATE: no modem surface may re-declare the two-state reading
 * adapter. There is one `readingView`, in `lib/modem/sections/derive.ts`.
 *
 * Three surfaces had written it by hand — `ModemConfigDialog`,
 * `RouterDongleDialog` (whose copy carried a comment saying it was copied
 * VERBATIM) and `ModemLockSection` inline. Each copy is free to drift, and the
 * way this particular adapter drifts is documented and expensive: routing a
 * capability that can be UNKNOWN through it collapses "nobody has established
 * this" onto ZERO nodes, byte-identical to a modem that positively has none.
 * That shipped once. A boundary restated in three files is a boundary three
 * files can move independently, so it is enforced here instead of reviewed.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readingView } from "$lib/modem/sections";

const SRC_DIR = join(
	import.meta.dirname ?? new URL(".", import.meta.url).pathname,
	"..",
);

/** The module that is ALLOWED to express the collapse — the one authority. */
const AUTHORITY = "lib/modem/sections/derive.ts";

interface ScannedFile {
	readonly path: string;
	readonly source: string;
}

/**
 * A hand-rolled `boolean -> {mode}` adapter, in either quote style and with
 * either arm first. Whitespace-insensitive so a formatter cannot disarm it.
 */
const ADAPTER_RE =
	/\{\s*mode\s*:\s*['"](?:available|absent)['"]\s*\}\s*:\s*\{\s*mode\s*:\s*['"](?:available|absent)['"]\s*\}/;

export function scanForReadingViewCopies(
	files: readonly ScannedFile[],
): string[] {
	return files
		.filter(
			(file) =>
				file.path !== AUTHORITY && ADAPTER_RE.test(stripComments(file.source)),
		)
		.map((file) => file.path);
}

/**
 * Remove `//`, block and HTML comments so the modules above can keep explaining
 * the rule in prose without tripping the gate that enforces it.
 */
function stripComments(source: string): string {
	return source
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function isShippedSource(relative: string): boolean {
	if (relative.includes("__fixtures__")) return false;
	if (relative.includes("/tests/") || relative.startsWith("tests/"))
		return false;
	if (/\.(test|spec)\.[a-z]+$/.test(relative)) return false;
	return /\.(ts|svelte)$/.test(relative);
}

function collect(dir: string, prefix = ""): ScannedFile[] {
	const out: ScannedFile[] = [];
	for (const entry of readdirSync(dir)) {
		const absolute = join(dir, entry);
		const relative = prefix === "" ? entry : `${prefix}/${entry}`;
		if (statSync(absolute).isDirectory()) {
			if (entry === "node_modules" || entry === "paraglide") continue;
			out.push(...collect(absolute, relative));
			continue;
		}
		if (!isShippedSource(relative)) continue;
		out.push({ path: relative, source: readFileSync(absolute, "utf8") });
	}
	return out;
}

const SHIPPED = collect(SRC_DIR);

describe("readingView — the two-state reading adapter", () => {
	it("answers available for a published reading and absent for none", () => {
		expect(readingView(true)).toEqual({ mode: "available" });
		expect(readingView(false)).toEqual({ mode: "absent" });
	});

	it("is the ONLY declaration of that collapse in shipped source", () => {
		expect(
			scanForReadingViewCopies(SHIPPED),
			"a surface re-declared the two-state reading adapter. Import `readingView` " +
				"from `$lib/modem/sections` instead — a second copy is free to be pointed " +
				"at a capability that can be UNKNOWN, which renders it as ZERO nodes.",
		).toEqual([]);
	});

	it("scans real files — an empty sweep FAILS", () => {
		const paths = SHIPPED.map((file) => file.path);
		expect(paths.length).toBeGreaterThan(100);
		expect(paths).toContain(AUTHORITY);
		expect(paths).toContain("main/dialogs/ModemConfigDialog.svelte");
		expect(paths).toContain("main/dialogs/RouterDongleDialog.svelte");
		expect(paths).toContain("main/dialogs/ModemLockSection.svelte");
	});

	it("trips on a planted copy, in either quote style and either arm order", () => {
		expect(
			scanForReadingViewCopies([
				{
					path: "main/dialogs/Planted.svelte",
					source: "const v = p ? { mode: 'available' } : { mode: 'absent' };",
				},
				{
					path: "main/dialogs/Other.svelte",
					source: 'const v = p ? { mode: "absent" } : { mode: "available" };',
				},
			]),
		).toEqual(["main/dialogs/Planted.svelte", "main/dialogs/Other.svelte"]);
	});

	it("does not trip on prose that names the collapse it forbids", () => {
		expect(
			scanForReadingViewCopies([
				{
					path: "main/dialogs/Documented.svelte",
					source:
						"// never write { mode: 'available' } : { mode: 'absent' } by hand\nconst v = readingView(p);",
				},
			]),
		).toEqual([]);
	});
});
