// @vitest-environment jsdom
import type { ModemList, WifiStatus } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { en } from "../../tests/helpers/catalog";
import { linkName, radioName } from "./link-names";

// Numeric keys, as the backend sends them; key order is the Network list order,
// so the order written here does not matter.
const modems = {
	"2": { ifname: "wwan2", name: "Modem M3 9999", status: {} },
	"0": {
		ifname: "wwan0",
		name: "Modem M4 5678",
		status: { network: "Northwind" },
	},
	"1": {
		ifname: "wwan1",
		name: "Modem M5 1234",
		status: { network: "Harbor Cell" },
	},
} as unknown as ModemList;

const wifi = {
	r0: { ifname: "wlan0", available: [{ ssid: "HomeNetwork", active: true }] },
	r1: { ifname: "wlx00c0cafe2f27", available: [] },
} as unknown as WifiStatus;

describe("one name per link", () => {
	it("names a modem by its place in the modem list and its operator, never model or serial", () => {
		expect(linkName("wwan0", { modems })).toBe("SIM 1 · Northwind");
		expect(linkName("wwan1", { modems })).toBe("SIM 2 · Harbor Cell");
		expect(linkName("wwan2", { modems })).toBe("SIM 3");
		expect(linkName("wwan0", { modems })).not.toContain("M4");
	});

	it("keeps SIM numbers when the backend re-issues modem ids", () => {
		// Same two modems on the same USB ports, ids swapped by a restart.
		const before = {
			"0": {
				ifname: "wwan0",
				stable_key: "port-1",
				status: { network: "Northwind" },
			},
			"1": {
				ifname: "wwan1",
				stable_key: "port-2",
				status: { network: "Harbor Cell" },
			},
		} as unknown as ModemList;
		const after = {
			"0": {
				ifname: "wwan1",
				stable_key: "port-2",
				status: { network: "Harbor Cell" },
			},
			"1": {
				ifname: "wwan0",
				stable_key: "port-1",
				status: { network: "Northwind" },
			},
		} as unknown as ModemList;
		expect(linkName("wwan0", { modems: before })).toBe("SIM 1 · Northwind");
		expect(linkName("wwan0", { modems: after })).toBe("SIM 1 · Northwind");
		expect(linkName("wwan1", { modems: after })).toBe("SIM 2 · Harbor Cell");
	});

	it("names a MAC-named radio with no network by its own name, never the MAC", () => {
		expect(radioName("wlx00c0cafe2f27")).toBe("USB Wi-Fi (2f27)");
		expect(radioName("wlan1")).toBe("Wi-Fi 2");
		expect(radioName("wlx00c0cafe2f27")).not.toContain("00c0cafe");
	});

	it("names a Wi-Fi link by the network it joined", () => {
		expect(linkName("wlan0", { wifi })).toBe("Wi-Fi · HomeNetwork");
	});

	it("names a MAC-named USB radio by its last four digits", () => {
		expect(linkName("wlx00c0cafe2f27", { wifi })).toBe("USB Wi-Fi (2f27)");
	});

	it("calls a USB network device a USB tether, without guessing what it is", () => {
		expect(linkName("usb0", {})).toBe(en.networking.linkName.usbTether);
		expect(linkName("usb0", {}).toLowerCase()).not.toContain("phone");
	});

	it("keeps the type label for everything else", () => {
		expect(linkName("eth0", {})).toBe("Ethernet 1");
		expect(linkName("eth1", {})).toBe("Ethernet 2");
	});

	it("ships every name pattern in every locale", async () => {
		const { ar, de, es, fr, hi, ja, ko, ptBR, zh } = await import(
			"../../tests/helpers/catalog"
		);
		for (const dict of [en, ar, de, es, fr, hi, ja, ko, ptBR, zh]) {
			const n = dict.networking.linkName;
			expect(n.sim).toContain("{n}");
			expect(n.simOperator).toContain("{operator}");
			expect(n.wifiNetwork).toContain("{network}");
			expect(n.usbWifi).toContain("{id}");
			expect(n.usbTether.length).toBeGreaterThan(0);
		}
	});
});
