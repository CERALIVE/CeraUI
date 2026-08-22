// @vitest-environment jsdom
/**
 * A WPA3-only row on a SAE-incapable adapter is DISABLED WITH A REASON.
 *
 * `DESIGN.md` §1 CT-2, not CT-1: the adapter genuinely HAS a Connect control and
 * the network genuinely IS in the air, so hiding the row would misreport the RF
 * environment. It stays visible, its Connect control is disabled, and the reason
 * is rendered ON SCREEN — the shipped kiosk touchscreen cannot hover to reveal a
 * `title`, so a tooltip-only reason is not a reason.
 *
 * The fail-open half is the one that protects the FLEET: `wpa3Sae` is a
 * tri-state and NetworkManager 1.42.4 publishes no SAE key at all, so `unknown`
 * is what every shipped board reports. Withholding on it would take WPA3 away
 * from all of them, so only a POSITIVE `unsupported` disables anything.
 */
import type {
	AvailableWifiNetwork,
	WifiAdapterCapabilities,
	WifiInterface,
	WifiSaeSupport,
} from "@ceraui/rpc/schemas";
import { render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import WifiNetworkList from "./WifiNetworkList.svelte";

const network = (ssid: string, security: string): AvailableWifiNetwork => ({
	active: false,
	ssid,
	signal: 72,
	security,
	freq: 5180,
});

const WPA3_ONLY = network("Studio-WPA3", "WPA3");
const TRANSITION = network("Studio-Mixed", "WPA2 WPA3");
const WPA2 = network("Studio-Legacy", "WPA2");

function capabilities(wpa3Sae: WifiSaeSupport): WifiAdapterCapabilities {
	return {
		phy: "phy0",
		generation: "wifi6",
		bands: ["2.4", "5"],
		maxWidthMhz: { "2.4": 40, "5": 80 },
		apModes: ["2.4", "5"],
		staApCombo: { supported: true, sameChannelOnly: true },
		wpa3Sae,
		regulatory: { country: "US", is6GhzLegal: false, self_managed: false },
	};
}

function iface(wpa3Sae: WifiSaeSupport | undefined): WifiInterface {
	return {
		ifname: "wlan0",
		conn: "",
		hw: "RTL8852BE",
		saved: {},
		...(wpa3Sae ? { capabilities: capabilities(wpa3Sae) } : {}),
	};
}

const baseProps = {
	networks: [],
	ifaceBusy: false,
	scanning: false,
	deviceId: "0",
	connecting: undefined,
	disconnecting: undefined,
	forgetting: undefined,
	pendingNew: undefined,
	confirmForget: undefined,
	passwordMin: 8,
	password: "",
	showPassword: false,
	onScan: vi.fn(),
	onConnectSaved: vi.fn(),
	onDisconnect: vi.fn(),
	onConnectNew: vi.fn(),
	onForget: vi.fn(),
	onConfirmForget: vi.fn(),
	onSubmitNew: vi.fn(),
	onResetInteraction: vi.fn(),
};

function renderList(
	networks: AvailableWifiNetwork[],
	wpa3Sae: WifiSaeSupport | undefined,
) {
	return render(WifiNetworkList, {
		props: { ...baseProps, networks, iface: iface(wpa3Sae) },
	});
}

const connectButton = (ssid: string) =>
	screen.getByRole("button", { name: `Connect ${ssid}` }) as HTMLButtonElement;

const blockedBands = () => screen.queryAllByTestId("wifi-row-blocked");

describe("a SAE-incapable adapter", () => {
	it("keeps the WPA3 row visible and disables its Connect with a reason", () => {
		renderList([WPA3_ONLY], "unsupported");

		// CT-2: visible…
		expect(screen.getByText(WPA3_ONLY.ssid)).toBeTruthy();
		// …disabled…
		expect(connectButton(WPA3_ONLY.ssid).disabled).toBe(true);

		// …and the reason is ON SCREEN, not only in a tooltip.
		const band = screen.getByTestId("wifi-row-blocked");
		expect(band.getAttribute("data-ssid")).toBe(WPA3_ONLY.ssid);
		expect(band.getAttribute("role")).toBe("status");
		expect(band.textContent).toContain("WPA3-only network");
		expect(band.textContent).toContain("WPA2");
		// Never a raw i18n path (the modem-surface never-a-dotted-key rule).
		expect(band.textContent).not.toContain("wifiSelector.");
	});

	it("does NOT withhold a transition network — it has a WPA2 leg", () => {
		renderList([TRANSITION], "unsupported");

		expect(connectButton(TRANSITION.ssid).disabled).toBe(false);
		expect(blockedBands()).toHaveLength(0);
	});

	it("leaves every non-WPA3 row alone", () => {
		renderList([WPA2], "unsupported");

		expect(connectButton(WPA2.ssid).disabled).toBe(false);
		expect(blockedBands()).toHaveLength(0);
	});

	it("blocks only the offending row when several are listed", () => {
		renderList([WPA3_ONLY, TRANSITION, WPA2], "unsupported");

		expect(blockedBands()).toHaveLength(1);
		expect(connectButton(WPA3_ONLY.ssid).disabled).toBe(true);
		expect(connectButton(TRANSITION.ssid).disabled).toBe(false);
		expect(connectButton(WPA2.ssid).disabled).toBe(false);
	});
});

describe("fail-open — only positive disproof withholds a row", () => {
	it.each<[string, WifiSaeSupport | undefined]>([
		["unknown (the shipped fleet's answer under NM 1.42.4)", "unknown"],
		["supported", "supported"],
		["an adapter with no capability read at all", undefined],
	])("offers the WPA3 join when the adapter reports %s", (_, wpa3Sae) => {
		renderList([WPA3_ONLY], wpa3Sae);

		expect(connectButton(WPA3_ONLY.ssid).disabled).toBe(false);
		expect(blockedBands()).toHaveLength(0);
	});
});
