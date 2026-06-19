/**
 * QR-pairing deep-link builder (Onboarding, Task 17).
 *
 * Locks the `/pair?code=…&serial=…` link shape the device QR encodes and the
 * platform `/pair` page parses. The two repos agree on this query contract, so a
 * drift here would silently break QR auto-fill.
 */
import { describe, expect, it } from "vitest";

import { buildPairingDeepLink, PAIRING_PORTAL_BASE_URL } from "./pairing-link";

describe("buildPairingDeepLink", () => {
	it("builds a /pair deep link carrying the code and serial", () => {
		const link = buildPairingDeepLink({
			code: "ABCD2345",
			serial: "CERA-DEV-1",
			baseUrl: "https://app.example.test",
		});
		const url = new URL(link);
		expect(url.origin).toBe("https://app.example.test");
		expect(url.pathname).toBe("/pair");
		expect(url.searchParams.get("code")).toBe("ABCD2345");
		expect(url.searchParams.get("serial")).toBe("CERA-DEV-1");
	});

	it("defaults to the configured portal origin", () => {
		const link = buildPairingDeepLink({ code: "ABCD2345", serial: "S1" });
		expect(link.startsWith(PAIRING_PORTAL_BASE_URL)).toBe(true);
	});

	it("trims surrounding whitespace on both fields", () => {
		const url = new URL(
			buildPairingDeepLink({
				code: "  ABCD2345 ",
				serial: " CERA-DEV-1 ",
				baseUrl: "https://app.example.test",
			}),
		);
		expect(url.searchParams.get("code")).toBe("ABCD2345");
		expect(url.searchParams.get("serial")).toBe("CERA-DEV-1");
	});

	it("URL-encodes a serial with reserved characters", () => {
		const url = new URL(
			buildPairingDeepLink({
				code: "ABCD2345",
				serial: "a b&c",
				baseUrl: "https://app.example.test",
			}),
		);
		// The raw query is percent-encoded, but decoding round-trips the serial.
		expect(url.searchParams.get("serial")).toBe("a b&c");
		expect(url.search).not.toContain("a b&c");
	});

	it("throws when the code or serial is empty", () => {
		expect(() => buildPairingDeepLink({ code: "", serial: "S1" })).toThrow();
		expect(() =>
			buildPairingDeepLink({ code: "ABCD2345", serial: "  " }),
		).toThrow();
	});
});
