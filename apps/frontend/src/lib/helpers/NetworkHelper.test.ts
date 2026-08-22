import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	generateDeviceAccessQr,
	generateWifiQr,
	hotspotQrSecurity,
} from "./NetworkHelper";

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

	/*
	  The auth token has to describe the AP the credentials belong to.

	  A WPA3-SAE access point advertised as `T:WPA` yields a QR that SCANS
	  PERFECTLY and then fails to join — the phone offers a PSK handshake the AP
	  will not accept — so the operator sees a working code and a device that
	  will not connect, with nothing on screen linking the two. These assert the
	  EXACT payload per mode rather than "the token changed", because the token
	  is the whole of the fix.
	*/
	describe("hotspot security → QR auth token", () => {
		it("maps a WPA3-SAE hotspot to T:SAE", () => {
			expect(hotspotQrSecurity("wpa3-sae")).toBe("SAE");
		});

		it("maps a WPA2 hotspot to T:WPA", () => {
			expect(hotspotQrSecurity("wpa2")).toBe("WPA");
		});

		// An unset mode is what every hotspot had before the mode was selectable,
		// and the device resolves it to WPA2 — so the token must not change.
		it("maps an UNSET mode to T:WPA, byte-identical to before", () => {
			expect(hotspotQrSecurity(undefined)).toBe("WPA");
		});

		it("emits the exact SAE payload for an SAE hotspot", async () => {
			await generateWifiQr(
				"CERALIVE03f6",
				"ceralive123",
				hotspotQrSecurity("wpa3-sae"),
			);
			expect(lastEncodedPayload()).toBe(
				"WIFI:T:SAE;S:CERALIVE03f6;P:ceralive123;;",
			);
		});

		it("emits the exact WPA payload for a WPA2 hotspot", async () => {
			await generateWifiQr(
				"CERALIVE03f6",
				"ceralive123",
				hotspotQrSecurity("wpa2"),
			);
			expect(lastEncodedPayload()).toBe(
				"WIFI:T:WPA;S:CERALIVE03f6;P:ceralive123;;",
			);
		});

		// The escaping invariant is orthogonal to the token and must survive it:
		// a SAE hotspot whose SSID carries reserved characters still gets exactly
		// one backslash per reserved character.
		it("escapes reserved characters identically under T:SAE", async () => {
			await generateWifiQr("a\\;b", "c\\:d", hotspotQrSecurity("wpa3-sae"));
			expect(lastEncodedPayload()).toBe("WIFI:T:SAE;S:a\\\\\\;b;P:c\\\\\\:d;;");
		});
	});
});
