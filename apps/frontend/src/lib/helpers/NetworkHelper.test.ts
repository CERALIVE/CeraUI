import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateDeviceAccessQr, generateWifiQr } from "./NetworkHelper";

const toDataURL = vi.hoisted(() =>
	vi.fn(async () => "data:image/png;base64,MOCKQR"),
);
vi.mock("qrcode", () => ({ default: { toDataURL } }));

/** The exact payload string handed to the QR encoder for the last call. */
function lastEncodedPayload(): string {
	const call = toDataURL.mock.calls.at(-1);
	if (!call) throw new Error("QR encoder was never called");
	return call[0] as unknown as string;
}

describe("NetworkHelper", () => {
	beforeEach(() => {
		toDataURL.mockClear();
	});

	describe("generateDeviceAccessQr", () => {
		it("should generate a data URL QR code for a valid device URL", async () => {
			const result = await generateDeviceAccessQr("http://10.42.0.1/");
			expect(result).toMatch(/^data:image\/png;base64,/);
		});

		it("should throw on empty string input", async () => {
			await expect(generateDeviceAccessQr("")).rejects.toThrow();
		});
	});

	describe("generateWifiQr", () => {
		it("should throw on empty SSID", async () => {
			await expect(generateWifiQr("", "secret")).rejects.toThrow();
		});

		// Regression guard: today's board credentials are plain alphanumeric, and the
		// escaping fix must not change a single byte of the payload they produce.
		it("leaves a plain alphanumeric SSID and password byte-identical", async () => {
			await generateWifiQr("CERALIVE03f6", "ceralive123");
			expect(lastEncodedPayload()).toBe(
				"WIFI:T:WPA;S:CERALIVE03f6;P:ceralive123;;",
			);
		});

		it("backslash-escapes each reserved character in the SSID", async () => {
			await generateWifiQr("Cera;Live,AP:5G\\x", "plainpass");
			expect(lastEncodedPayload()).toBe(
				"WIFI:T:WPA;S:Cera\\;Live\\,AP\\:5G\\\\x;P:plainpass;;",
			);
		});

		it("backslash-escapes each reserved character in the password", async () => {
			await generateWifiQr("PlainSsid", "p:a;s,s\\word");
			expect(lastEncodedPayload()).toBe(
				"WIFI:T:WPA;S:PlainSsid;P:p\\:a\\;s\\,s\\\\word;;",
			);
		});

		// A backslash must be escaped exactly once — a sequential per-character pass
		// would re-escape the backslashes inserted for `;` `,` `:` and corrupt the field.
		it("escapes a literal backslash exactly once, never doubly", async () => {
			await generateWifiQr("a\\;b", "c\\:d");
			expect(lastEncodedPayload()).toBe("WIFI:T:WPA;S:a\\\\\\;b;P:c\\\\\\:d;;");
		});

		it("carries the requested encryption type through unchanged", async () => {
			await generateWifiQr("Ssid", "pass", "WEP");
			expect(lastEncodedPayload()).toBe("WIFI:T:WEP;S:Ssid;P:pass;;");
		});
	});
});
