/// <reference types="bun" />
import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { prepareAptDiagnostic } from "../modules/system/apt-all-diagnostics.ts";

it("bounds near-PEM scanning structurally instead of timing a loaded worker", async () => {
	// Given: scheme punctuation creates many word-boundary starts in one token.
	const source = await Bun.file(
		new URL("../modules/system/apt-all-diagnostics.ts", import.meta.url),
	).text();
	// Then: forbid the retrying unbounded left context before running the large cell.
	expect(source).not.toContain(String.raw`\b[a-z][a-z0-9+.-]*:`);
	// When
	const result = prepareAptDiagnostic("-----BEGI".repeat(111_112));
	// Then
	expect(result.detail).toBe("-----BEGI".repeat(56).slice(0, 500));
});

it.each(["\u200b", "\u200d", "\u202e", "\u0000"])(
	"redacts when removal of %j alone reveals the marker",
	(format) => {
		// Given: no independent PRIVATE KEY, bearer or assignment can mask M02.
		const input = `-----BE${format}GIN CERTIFICATE-----\nALPHA9384`;
		// When
		const result = prepareAptDiagnostic(input);
		// Then
		expect(result.detail).toBe("[REDACTED]");
	},
);

it("distinguishes lone surrogates without colliding with their escaped spelling", () => {
	// Given
	const inputs = [
		"E: safe \ud800 changed",
		"E: safe \udc00 changed",
		'"E: safe \\ud800 changed"',
	];
	// When
	const results = inputs.map(prepareAptDiagnostic);
	// Then
	expect(new Set(results.map((result) => result.fingerprint)).size).toBe(3);
	expect(results.map((result) => result.detail)).toEqual(inputs);
});

it("hashes every safe unit beyond the display cap", () => {
	// Given
	const prefix = "e".repeat(1_000);
	// When
	const results = ["alpha", "beta"].map((tail) =>
		prepareAptDiagnostic(prefix + tail),
	);
	// Then
	expect(results.map((result) => result.detail)).toEqual([
		"e".repeat(500),
		"e".repeat(500),
	]);
	expect(new Set(results.map((result) => result.fingerprint)).size).toBe(2);
	expect(results[0]?.fingerprint).toBe(
		createHash("sha256").update(`${prefix}alpha`).digest("hex"),
	);
});

it("withholds a PEM block spanning the display cap and its continuation", () => {
	// Given
	const input = `E: fetch failed\n-----BEGIN CERTIFICATE-----\n${"ALPHA9384".repeat(100)}\n-----END CERTIFICATE-----\nBRAVO8273`;
	// When
	const result = prepareAptDiagnostic(input);
	// Then
	expect(result.detail).toBe("E: fetch failed [REDACTED]");
});

it("withholds the whole marked record rather than one line", () => {
	// Given
	const input = "E: failed\nAuthorization:\nALPHA9384\nBRAVO8273";
	// When
	const result = prepareAptDiagnostic(input);
	// Then
	expect(result.detail).toBe("E: failed [REDACTED]");
});

it.each(["https", "git+https", "a.b-c", "-https", "_a.https"])(
	"withholds URL userinfo and continuation with scheme %s",
	(scheme) => {
		// Given
		const input = `E: ${scheme}: / / ALPHA9384:BRAVO8273@example.invalid\nCHARLIE7162`;
		// When
		const result = prepareAptDiagnostic(input);
		// Then
		expect(result.detail).toContain("[REDACTED URL]");
		expect(result.detail).not.toMatch(/ALPHA9384|BRAVO8273|CHARLIE7162/);
	},
);

it("never hashes suppressed credential values", () => {
	// Given
	const inputs = ["ALPHA9384", "BRAVO8273"].map(
		(value) => `password=\n${value}`,
	);
	// When
	const results = inputs.map(prepareAptDiagnostic);
	// Then
	expect(new Set(results.map((result) => result.fingerprint)).size).toBe(1);
});
