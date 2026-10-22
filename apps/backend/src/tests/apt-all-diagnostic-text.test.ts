import { expect, it } from "bun:test";
import { sanitizeAptDiagnostic } from "../modules/system/apt-all-diagnostics.ts";
import {
	AptAllRefusalError,
	assertPinnedInstallSimulation,
	buildAptAllInstallArgs,
	discoverAptAllPackages,
	parseAptSimulation,
} from "../modules/system/apt-all-packages.ts";

it.each([
	["empty", "", ""],
	["binary", "E:\u0000\u0001 broken\u007f\u0080", "E: broken"],
	["ANSI", "\u001b[31mE: broken\u001b[0m", "E: broken"],
	["CRLF", " E: first\r\n second\rthird ", "E: first second third"],
	["multi-line", "first\n\nsecond\tpart", "first second part"],
	["unicode", "échec 日本語 😀\u202e", "échec 日本語 😀"],
])("normalizes %s diagnostic text", (_name, input, expected) => {
	// Given/When: untrusted stderr crosses the pure text boundary.
	const detail = sanitizeAptDiagnostic(input);
	// Then
	expect(detail).toBe(expected);
});

it("truncates huge text to 500 UTF-16 units without a dangling surrogate", () => {
	// Given
	const input = `${"x".repeat(499)}😀${"x".repeat(10_000)}`;
	// When
	const detail = sanitizeAptDiagnostic(input);
	// Then
	expect(detail.length).toBeLessThanOrEqual(500);
	expect(detail).toBe("x".repeat(499));
});

it.each([
	"password=fixture-password",
	"API_KEY=fixture-key",
	"PATH=/fixture/private/env",
	"Authorization: Bearer fixture-token",
	"Acquire::https::SslKey /fixture/key",
	"v4.public.fixture-token",
	"eyJfixture.fixture.fixture",
	"pass\u0000word=fixture-password",
	"-----BEGIN PRIVATE KEY-----\nfixture-key-body\n-----END PRIVATE KEY-----",
])("redacts sensitive text before truncation: %s", (sensitive) => {
	// Given: the safe diagnostic is on an independent line.
	const input = `E: DISCOVERY_AUDIT_SENTINEL\n${sensitive}`;
	// When
	const detail = sanitizeAptDiagnostic(input);
	// Then
	expect(detail).toContain("DISCOVERY_AUDIT_SENTINEL");
	expect(detail).toContain("[REDACTED]");
	expect(detail).not.toContain("fixture");
});

it("redacts complete URLs including userinfo and query credentials", () => {
	// Given
	const input =
		"E: failed https://fixture-user:fixture-pass@apt.example/x?token=fixture-token";
	// When
	const detail = sanitizeAptDiagnostic(input);
	// Then
	expect(detail).toBe("E: failed [REDACTED URL]");
});

it("sanitizes optional internal error detail at construction", () => {
	// Given/When
	const error = new AptAllRefusalError("discovery_failed", "source-policy", {
		exit: 100,
		detail: "password=fixture-password",
	});
	// Then
	expect(error.message).toBe("discovery_failed");
	expect(error.detail).toBe("[REDACTED]");
});

it("names the parse step when the upgrade summary is missing", () => {
	// Given/When/Then
	expect(() => parseAptSimulation("unknown output")).toThrow(
		expect.objectContaining({
			step: "parse-simulation",
			detail: "missing upgrade summary",
		}),
	);
});

it("names the install vector step for an invalid argument vector", () => {
	// Given/When/Then
	expect(() => buildAptAllInstallArgs([], "any")).toThrow(
		expect.objectContaining({ step: "install-vector" }),
	);
});

it("keeps pinned removal refusals typed with the recheck step", () => {
	// Given/When/Then
	expect(() => assertPinnedInstallSimulation("Remv libc6 [1]\n", [])).toThrow(
		expect.objectContaining({
			reason: "removals_required",
			step: "pinned-recheck",
		}),
	);
});

it("keeps first-party hold refusals typed with the held-package step", async () => {
	// Given/When/Then
	let refusal: AptAllRefusalError | undefined;
	try {
		await discoverAptAllPackages(
			"0 upgraded",
			"cerastream",
			async () => "",
			"",
		);
	} catch (error) {
		if (!(error instanceof AptAllRefusalError)) throw error;
		refusal = error;
	}
	expect(refusal).toMatchObject({
		reason: "first_party_held_back",
		step: "held-packages",
	});
});
