/**
 * THE TAXONOMY IS EXHAUSTIVE IN BOTH DIRECTIONS, AND HAS NO DEFAULT CASE.
 *
 * Two fences, and this suite proves each of them is really there rather than
 * merely intended:
 *
 *  1. **No wire token is unclassified.** The required key set is DERIVED from
 *     the Zod enums themselves, never re-typed here, so a member added upstream
 *     lands in this assertion automatically instead of waiting for someone to
 *     remember this file.
 *  2. **No class is unkeyed, and there is no `default` to hide one.** The
 *     `default` arm is what would let an unkeyed class compile and render a
 *     generic sentence, so its ABSENCE is asserted against the shipped source
 *     with comments stripped — the compiler enforces the totality, and this
 *     enforces that the compiler is still the thing enforcing it.
 *
 * The source scan is proven non-vacuous in both directions: the detector must
 * find a planted `default:` and must not find one in the real file.
 */

import { readFileSync } from "node:fs";
import {
	modemConfigRefusalSchema,
	modemCredentialsRefusalSchema,
	modemMutationRefusalSchema,
	modemScanFailureSchema,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	classifyModemRefusal,
	type ModemRefusalToken,
	modemRefusalCopyKey,
	REFUSAL_CLASS_OF,
	REFUSAL_CLASSES,
	refusalCopyKey,
} from "./refusal-taxonomy";

const SOURCE_PATH = new URL("./refusal-taxonomy.ts", import.meta.url).pathname;

/** Every token the four in-scope wire enums can produce, de-duplicated. */
const WIRE_TOKENS: readonly string[] = [
	...new Set([
		...modemMutationRefusalSchema.options,
		...modemConfigRefusalSchema.options,
		...modemCredentialsRefusalSchema.options,
		...modemScanFailureSchema.options,
	]),
];

/**
 * Comments are stripped before the scan, so the module's own PROSE about the
 * `default` arm it does not have cannot satisfy — or trip — the detector.
 */
function strippedSource(): string {
	return readFileSync(SOURCE_PATH, "utf8")
		.replaceAll(/\/\*[\s\S]*?\*\//g, "")
		.replaceAll(/^\s*\/\/.*$/gm, "");
}

describe("the switch has NO default arm", () => {
	it("the shipped source contains no `default:` and no `??` fallback", () => {
		const source = strippedSource();
		expect(source).not.toMatch(/\bdefault\s*:/);
		// A record lookup with a nullish fallback is the same defect one step
		// quieter — it makes an unmapped class compile and render a stand-in.
		expect(source).not.toContain("??");
	});

	it("the detector is non-vacuous — it FINDS a planted default", () => {
		const planted = `${strippedSource()}\n\tdefault:\n\t\treturn "generic";`;
		expect(planted).toMatch(/\bdefault\s*:/);
	});

	it("still contains the switch it is guarding", () => {
		// Without this, deleting the whole function would pass the two above.
		expect(strippedSource()).toMatch(/switch\s*\(\s*refusalClass\s*\)/);
	});
});

describe("every class is keyed, and no two share a key", () => {
	it("resolves a non-empty dot-path for all of them", () => {
		for (const refusalClass of REFUSAL_CLASSES) {
			const key = refusalCopyKey(refusalClass);
			expect(key.length).toBeGreaterThan(0);
			expect(key).toContain(".");
		}
	});

	it("one class, one key", () => {
		const keys = REFUSAL_CLASSES.map(refusalCopyKey);
		expect(new Set(keys).size).toBe(REFUSAL_CLASSES.length);
	});

	it("carries the eleven the taxonomy was specified around", () => {
		// Spelled out rather than derived: a table that quietly stopped producing
		// one of these would still look internally complete.
		for (const required of [
			"unsupported",
			"blocked-by-state",
			"auth-failed",
			"unsupported-profile",
			"locked-out",
			"device-busy",
			"timed-out-unknown-outcome",
			"hardware-gone",
			"reconciliation-required",
			"admission-refused",
			"identity-unresolved",
		] as const) {
			expect(REFUSAL_CLASSES).toContain(required);
		}
	});

	it("keeps `auth-failed` and `unsupported-profile` apart", () => {
		// The one pair the effort forbids collapsing: a rejected password and a
		// login shape this build cannot perform send the operator to opposite
		// remedies, and they are indistinguishable at the call site.
		expect(refusalCopyKey("auth-failed")).not.toBe(
			refusalCopyKey("unsupported-profile"),
		);
	});
});

describe("every wire token is classified", () => {
	it("covers the four in-scope enums exactly — no gap, no stale row", () => {
		expect(Object.keys(REFUSAL_CLASS_OF).sort()).toEqual(
			[...WIRE_TOKENS].sort(),
		);
	});

	it("resolves each token to a class the copy table knows", () => {
		for (const token of WIRE_TOKENS) {
			const resolved = classifyModemRefusal(token as ModemRefusalToken);
			expect(REFUSAL_CLASSES).toContain(resolved);
		}
	});

	it("uses every class it declares", () => {
		// A class no token reaches is dead copy in ten catalogs, and it would make
		// the per-class rendered gate impossible to satisfy honestly.
		const used = new Set(Object.values(REFUSAL_CLASS_OF));
		expect([...used].sort()).toEqual([...REFUSAL_CLASSES].sort());
	});

	it("resolves every token to keyed copy, never to the raw token", () => {
		// `unreachable` is deliberately both a token and a class name, so the
		// property worth asserting is about the KEY an operator's sentence is
		// looked up by — that is the value a leak would surface.
		for (const token of WIRE_TOKENS) {
			const key = modemRefusalCopyKey(token as ModemRefusalToken);
			expect(key).not.toBe(token);
			expect(key.startsWith("network.")).toBe(true);
		}
	});
});
