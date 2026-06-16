// @vitest-environment jsdom
/**
 * ConnectPhoneSection — "connect your phone" surface in HotspotDialog (#67 Phase-0).
 *
 * The section calls `wifi.hotspotInfo` (SSID + gateway IP + active flag — NEVER a
 * password, guardrail G3) and, when the hotspot is live, renders the on-device URL
 * (`http://<gatewayIp>/`) plus a device-access QR so a phone can open CeraUI after
 * joining the hotspot. Captive-portal is out of scope, so a visible "navigate
 * manually" note replaces it. When the hotspot is off (or no gateway is known) the
 * section shows a calm "start the hotspot first" prompt instead of a broken QR.
 *
 * Contract locked here:
 *   1. Active   — device URL text "http://10.42.0.1/", a device-access QR image,
 *                 and the navigate-manually note; the QR is generated from the URL,
 *                 never from a password. No off-prompt.
 *   2. Inactive — the off-prompt renders; no QR is generated, no URL is shown.
 *   3. RTL-safe — the URL element carries dir="ltr" so it is never mirrored.
 */

import { render, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateDeviceAccessQr } from "$lib/helpers/NetworkHelper";
import { rpc } from "$lib/rpc/client";

import ConnectPhoneSection from "./ConnectPhoneSection.svelte";

// Isolate from the live WebSocket RPC client — `hotspotInfo` is a per-test spy.
vi.mock("$lib/rpc/client", () => ({
	rpc: { wifi: { hotspotInfo: vi.fn() } },
}));

// Stub the QR generator so the section stays hermetic (no real canvas/QRCode run)
// and we can assert exactly what was encoded.
vi.mock("$lib/helpers/NetworkHelper", () => ({
	generateDeviceAccessQr: vi.fn(async () => "data:image/png;base64,DEVICEQR"),
}));

const hotspotInfo = vi.mocked(rpc.wifi.hotspotInfo);
const deviceQr = vi.mocked(generateDeviceAccessQr);

beforeEach(() => {
	vi.clearAllMocks();
	deviceQr.mockResolvedValue("data:image/png;base64,DEVICEQR");
});

describe("ConnectPhoneSection — connect-your-phone (#67 Phase-0)", () => {
	it("renders the device URL + device-access QR when the hotspot is active", async () => {
		hotspotInfo.mockResolvedValue({
			ssid: "CeraLive-Hotspot",
			gatewayIp: "10.42.0.1",
			isActive: true,
		});

		const { getByTestId, queryByTestId } = render(ConnectPhoneSection);

		const url = await waitFor(() => getByTestId("device-access-url"));
		expect(url.textContent).toContain("http://10.42.0.1/");

		const qr = await waitFor(() => getByTestId("device-access-qr"));
		expect(qr.getAttribute("src")).toBe("data:image/png;base64,DEVICEQR");

		// The QR encodes the device URL — never a credential.
		expect(deviceQr).toHaveBeenCalledWith("http://10.42.0.1/");

		// Captive-portal is out: the manual-navigation note must be visible.
		expect(getByTestId("navigate-manually-note")).toBeTruthy();

		// Active state never shows the off prompt.
		expect(queryByTestId("hotspot-off-prompt")).toBeNull();
	});

	it("shows the off prompt and no QR when the hotspot is inactive", async () => {
		hotspotInfo.mockResolvedValue({
			ssid: "",
			gatewayIp: "",
			isActive: false,
		});

		const { getByTestId, queryByTestId } = render(ConnectPhoneSection);

		await waitFor(() => expect(hotspotInfo).toHaveBeenCalledTimes(1));
		await waitFor(() => getByTestId("hotspot-off-prompt"));

		expect(queryByTestId("device-access-qr")).toBeNull();
		expect(queryByTestId("device-access-url")).toBeNull();
		// No URL → no QR encode attempt (no broken image).
		expect(deviceQr).not.toHaveBeenCalled();
	});

	it("wraps the URL element in dir=ltr for RTL safety", async () => {
		hotspotInfo.mockResolvedValue({
			ssid: "CeraLive-Hotspot",
			gatewayIp: "10.42.0.1",
			isActive: true,
		});

		const { getByTestId } = render(ConnectPhoneSection);

		const url = await waitFor(() => getByTestId("device-access-url"));
		expect(url.getAttribute("dir")).toBe("ltr");
	});
});
