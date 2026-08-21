/**
 * ONE AUTHORITY MINTS A `link_id`, AND THIS IS THE LOCK.
 *
 * `physical-identity.ts` owns `LINK_ID_PREFIX` and `mintLinkId`, which derive an
 * id from a device's IDENTITY KEY (a USB serial, else its `ID_PATH`, else — as
 * the stated floor — its interface name). Anywhere else, a string starting
 * `lnk_` is a FABRICATION, and the retired one is why this gate exists: the bond
 * writer used to fall back to a `lnk_<ifname>` template when identity resolution
 * failed. It read as an identity and was shaped like one, but it was keyed on
 * the interface NAME — the single property this fleet has already proven is not
 * a device, since the bench twins ship one factory MAC and a replug can swap
 * which of them gets the predictable `enx…` name. That id follows the name, so
 * the next device in the socket inherits the previous unit's telemetry row.
 *
 * A comment saying "never invent an id" is not a control. This greps the actual
 * source, with prose stripped, so the rule survives the next person to touch the
 * bond path.
 *
 * Deleting or weakening this test to land a stand-in id is exactly the move it
 * exists to stop: the honest answer to an unresolvable identity is the explicit
 * `unmappable` state (`bind-map.ts` `unmappableBondEntry`), never a plausible id.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BACKEND_SRC = join(import.meta.dir, "..");
const REPO_ROOT = join(BACKEND_SRC, "..", "..", "..");
const RPC_SRC = join(REPO_ROOT, "packages", "rpc", "src");

/** The ONE module allowed to spell the prefix at all. */
const MINTING_AUTHORITY = join(
	BACKEND_SRC,
	"modules",
	"modems",
	"physical-identity.ts",
);

/** This gate names the forbidden shapes, so it must not scan itself. */
const SELF = "link-id-authority-gate.test.ts";

/**
 * Every way a `lnk_`-prefixed id can be ASSEMBLED rather than minted. A whole
 * fixture literal (`"lnk_a"`, `"lnk_aaaaaaaaaaaaaaaa"`) is deliberately NOT one
 * of these: test data standing in for an already-minted id invents nothing.
 */
const INVENTION_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
	{ label: "a `lnk_<interpolation>` template literal", re: /lnk_\$\{/ },
	{ label: "a `lnk_` string concatenation", re: /["'`]lnk_["'`]\s*\+/ },
	{ label: "a concatenation ONTO `lnk_`", re: /\+\s*["'`]\s*lnk_/ },
	{ label: "a `lnk_` .concat() call", re: /["'`]lnk_["'`]\s*\)?\s*\.concat\(/ },
];

const isScannable = (name: string): boolean =>
	name.endsWith(".ts") && name !== SELF;

function collectSources(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const child = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...collectSources(child));
		else if (isScannable(entry.name)) found.push(child);
	}
	return found;
}

/**
 * Scan CODE, not prose. Both `bind-map.ts` and `srtla.ts` document the retired
 * `lnk_<ifname>` fallback BY NAME so a future reader knows what was removed and
 * why; a gate that cannot tell that sentence from a real interpolation is a gate
 * nobody can document around.
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.split("\n")
		.filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
		.join("\n");
}

const SOURCES = [...collectSources(BACKEND_SRC), ...collectSources(RPC_SRC)];
const CODE = new Map(
	SOURCES.map((path) => [path, stripComments(readFileSync(path, "utf8"))]),
);
const relative = (path: string): string => path.slice(REPO_ROOT.length + 1);

describe("a link identity is MINTED, never assembled", () => {
	it("scans a non-trivial set of sources, including both halves", () => {
		// Guards the gate itself: a moved directory would make every assertion
		// below pass by scanning nothing.
		expect(SOURCES.length).toBeGreaterThan(200);
		expect(SOURCES).toContain(MINTING_AUTHORITY);
		expect(
			SOURCES.some((path) => path.endsWith("streaming/srtla.ts")),
			"the bond-entry writer must be in scan scope",
		).toBe(true);
		expect(
			SOURCES.some((path) => path.endsWith("streaming/bind-map.ts")),
			"the bind-map document builder must be in scan scope",
		).toBe(true);
	});

	it("its own detectors actually fire (non-vacuity)", () => {
		// The samples are ASSEMBLED rather than written out: spelling a real
		// `lnk_` interpolation in this file would make the gate a hit for the
		// very grep the acceptance criterion runs over the whole tree.
		const PREFIX = "lnk_";
		const OPEN = "${";
		const fabrications = [
			`linkId: \`${PREFIX}${OPEN}ifname}\``,
			`linkId: "${PREFIX}" + ifname`,
			`const id = prefix + "${PREFIX}"`,
			`const id = "${PREFIX}".concat(ifname)`,
		];
		for (const sample of fabrications) {
			expect(
				INVENTION_PATTERNS.some(({ re }) => re.test(sample)),
				`no detector matched: ${sample}`,
			).toBe(true);
		}
		// …and a whole fixture literal is NOT reported, or every existing
		// bind-map fixture would have to be rewritten to satisfy the gate.
		expect(
			INVENTION_PATTERNS.some(({ re }) => re.test(`linkId: "${PREFIX}a"`)),
		).toBe(false);
	});

	for (const { label, re } of INVENTION_PATTERNS) {
		it(`has no ${label} anywhere, not even in a fixture`, () => {
			const offenders = [...CODE.entries()]
				.filter(([, source]) => re.test(source))
				.map(([path]) => relative(path));

			expect(offenders).toEqual([]);
		});
	}

	it("only the minting authority spells the prefix in shipped code", () => {
		const owners = [...CODE.entries()]
			.filter(([path]) => !path.endsWith(".test.ts"))
			.filter(([, source]) => /lnk_/.test(source))
			.map(([path]) => relative(path));

		expect(owners).toEqual([relative(MINTING_AUTHORITY)]);
	});

	it("the authority derives the id from an identity key, not an ifname", () => {
		const authority = CODE.get(MINTING_AUTHORITY) ?? "";
		expect(authority).toContain('const LINK_ID_PREFIX = "lnk_"');
		// The prefix is only ever joined to a DIGEST. An `ifname` reaching this
		// template would be the retired defect re-introduced at the authority.
		expect(authority).toMatch(
			/LINK_ID_PREFIX\}\$\{digest\.slice\(0, LINK_ID_DIGEST_CHARS\)\}/,
		);
	});
});
