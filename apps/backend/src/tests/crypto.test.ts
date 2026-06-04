import { describe, expect, test } from "bun:test";

import { randomBase64 } from "../helpers/crypto.ts";

describe("randomBase64 — Bun-native replacement for randomBytes().toString('base64')", () => {
	test("randomBase64(9) matches the hotspot-password baseline: 12 chars, base64 charset", () => {
		const value = randomBase64(9);
		expect(value).toHaveLength(12);
		expect(value).toMatch(/^[A-Za-z0-9+/]+$/);
	});

	test("output length matches node randomBytes(n).toString('base64') for several sizes", () => {
		for (const n of [3, 9, 24, 32]) {
			const expectedLength = Buffer.alloc(n).toString("base64").length;
			expect(randomBase64(n)).toHaveLength(expectedLength);
		}
	});

	test("returns distinct values across calls", () => {
		const a = randomBase64(9);
		const b = randomBase64(9);
		expect(a).not.toBe(b);
	});
});
