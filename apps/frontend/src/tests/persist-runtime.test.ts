// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as upstream from "svelte-persistent-runes";
import { describe, expect, it } from "vitest";
import * as shipped from "$lib/stores/persist-runtime";

import { PERSIST_RUNTIME_SPECIFIER } from "../../vite.persist";

const KEY = "persist-runtime-equivalence";

/**
 * Every observable input the `$persist` preprocessor can hand the runtime.
 *
 * `undefined` is the documented no-op, `null`/`0`/`false`/`""` are the falsy
 * values a naive implementation drops, and the nested object is what proves the
 * serializer is a real JSON round-trip rather than `String(value)`.
 */
const VALUES: readonly unknown[] = [
	undefined,
	null,
	0,
	false,
	"",
	"dark",
	{ profile: "eink", nested: { rungs: [1, 2, 3] } },
	[1, "two", { three: true }],
];

function writeThenRead(
	runtime: typeof shipped | typeof upstream,
	value: unknown,
): { stored: string | null; loaded: unknown } {
	localStorage.clear();
	runtime.save(KEY, value);
	return { stored: localStorage.getItem(KEY), loaded: runtime.load(KEY) };
}

describe("persist-runtime — the substituted `$persist` runtime", () => {
	it("compares two genuinely different implementations", () => {
		// Vitest deliberately carries NO persist alias, so `upstream` really is the
		// package. Without this the whole suite would pass by comparing one module
		// against itself.
		expect(shipped.load).not.toBe(upstream.load);
		expect(shipped.save).not.toBe(upstream.save);
	});

	it.each(VALUES.map((value) => [JSON.stringify(value) ?? "undefined", value]))(
		"round-trips %s exactly as the package does",
		(_label, value) => {
			expect(writeThenRead(shipped, value)).toEqual(
				writeThenRead(upstream, value),
			);
		},
	);

	it("agrees with the package on every non-string storage state", () => {
		// An absent key, and the stored empty string the package folds into
		// `undefined` so it never reaches `JSON.parse`.
		for (const seed of [null, ""]) {
			localStorage.clear();
			if (seed !== null) localStorage.setItem(KEY, seed);

			expect(shipped.load(KEY)).toBe(upstream.load(KEY));
			expect(shipped.load(KEY)).toBeUndefined();
		}
	});

	it("lets a caller-supplied option override the default, per key", () => {
		const options = {
			serialize: (input: unknown) => `wrapped:${JSON.stringify(input)}`,
			deserialize: (input: string) =>
				JSON.parse(input.replace(/^wrapped:/, "")) as never,
		};

		localStorage.clear();
		shipped.save(KEY, { a: 1 }, options);
		const shippedStored = localStorage.getItem(KEY);
		const shippedLoaded = shipped.load(KEY, options);

		localStorage.clear();
		upstream.save(KEY, { a: 1 }, options);

		expect(shippedStored).toBe(localStorage.getItem(KEY));
		expect(shippedLoaded).toEqual(upstream.load(KEY, options));
		// The override really was in force — the default would not have wrapped it.
		expect(shippedStored).toBe('wrapped:{"a":1}');
	});

	it("keeps the storage write itself identical", () => {
		localStorage.clear();
		shipped.save(KEY, "dark");
		const fromShipped = { ...localStorage };

		localStorage.clear();
		upstream.save(KEY, "dark");

		expect(fromShipped).toEqual({ ...localStorage });
	});
});

describe("persist-runtime — the alias that installs it", () => {
	it("captures the runtime specifier and nothing else", () => {
		expect(PERSIST_RUNTIME_SPECIFIER.test("svelte-persistent-runes")).toBe(
			true,
		);

		// A prefix match here would swallow the PREPROCESSOR both Vite configs
		// import, and the preset registry a future call site is meant to reach.
		for (const subpath of [
			"svelte-persistent-runes/plugins",
			"svelte-persistent-runes/options",
			"svelte-persistent-runes/preprocessor",
		]) {
			expect(PERSIST_RUNTIME_SPECIFIER.test(subpath)).toBe(false);
		}
	});

	it("is applied by every build that emits app code", () => {
		const configs = ["vite.config.ts", "vite.federation.config.ts"];

		for (const config of configs) {
			const source = readFileSync(
				path.resolve(__dirname, "../..", config),
				"utf8",
			);
			expect(source).toContain("PERSIST_RUNTIME_ALIAS");
		}
	});
});
