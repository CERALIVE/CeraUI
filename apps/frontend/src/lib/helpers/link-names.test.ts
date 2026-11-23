// @vitest-environment jsdom
import { modemSchema, wifiInterfaceSchema } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";
import type { LinkNameSources } from "./link-names";
import * as naming from "./link-names";

function linkName(ifname: string, sources: LinkNameSources) {
	return naming.createLinkNameProjection()(sources).label(ifname);
}

const radioName = (ifname: string) => linkName(ifname, {});

function modem(
	ifname: string,
	network?: string,
	port?: string,
	controller = "platform-xhci",
) {
	return modemSchema.parse({
		ifname,
		name: "RM520N-GL - 5678",
		model: "RM520N-GL",
		network_type: { supported: [], active: null },
		...(port
			? {
					stable_key: `${controller}-usb-0:${port}`,
					port_label: `USB 0-${port}`,
				}
			: {}),
		...(network
			? {
					status: {
						network,
						connection: "connected",
						signal: 72,
						network_type: "5G",
						roaming: false,
					},
				}
			: { no_sim: true }),
	});
}

function radio(ifname: string, ssid?: string) {
	return wifiInterfaceSchema.parse({
		ifname,
		conn: ssid ? "saved-profile" : "",
		hw: "02:00:00:00:00:01",
		saved: {},
		available: ssid
			? [{ active: true, ssid, signal: 80, security: "WPA2", freq: 2437 }]
			: [],
	});
}

const wifi = {
	r0: radio("wlan0", "HomeNetwork"),
	r1: radio("wlx00c0cafe2f27"),
};

describe("one name per link", () => {
	it("names a modem by carrier and short model, not rank or serial", () => {
		const modems = { "1": modem("wwan0", "Northwind") };
		expect(linkName("wwan0", { modems })).toBe("Northwind · RM520N");
	});

	it("does not invent a SIM slot for a modem without a SIM", () => {
		const modems = { "2": modem("wwan2") };
		expect(linkName("wwan2", { modems })).toBe("RM520N");
	});

	it("uses hardware ports to tell same-carrier twins apart", () => {
		const modems = {
			"1": modem("wwan0", "Northwind", "1.1"),
			"2": modem("wwan1", "Northwind", "1.2"),
		};
		const project = naming.createLinkNameProjection();
		const names = project({ modems });
		expect(names.label("wwan0")).toBe("Northwind · RM520N · USB 0-1.1");
		expect(names.label("wwan1")).toBe("Northwind · RM520N · USB 0-1.2");
		expect(project({ modems: { "2": modems["2"] } }).label("wwan1")).toBe(
			"Northwind · RM520N · USB 0-1.2",
		);
		const replugged = project({
			modems: { "19": { ...modems["1"], ifname: "wwan3" }, "2": modems["2"] },
		});
		expect(replugged.label("wwan3")).toBe("Northwind · RM520N · USB 0-1.1");
	});

	it.each([
		{
			scenario: "USB metadata is absent",
			first: modem("wwan0", "Northwind"),
			second: modem("wwan1", "Northwind"),
		},
		{
			scenario: "two controllers report the same short USB hint",
			first: modem("wwan0", "Northwind", "1.1"),
			second: modem("wwan1", "Northwind", "1.1", "platform-other"),
		},
	])(
		"keeps the visible fallback after a twin is unplugged when $scenario",
		({ first, second }) => {
			const project = naming.createLinkNameProjection();
			const twinLabel = "Northwind · RM520N · wwan1";
			const both = project({ modems: { "1": first, "2": second } });
			expect(both.label("wwan1")).toBe(twinLabel);
			expect(both.correlation("wwan1")).toBe("wwan1");

			const survivor = project({ modems: { "2": second } });
			expect(survivor.label("wwan1")).toBe(twinLabel);
			expect(survivor.correlation("wwan1")).toBe("wwan1");

			const returned = project({ modems: { "2": second, "19": first } });
			expect(returned.label("wwan1")).toBe(twinLabel);
			expect(returned.correlation("wwan1")).toBe("wwan1");
		},
	);

	it("keeps the fallback when one of three matching modems leaves", () => {
		const project = naming.createLinkNameProjection();
		const first = modem("wwan0", "Northwind", "1");
		const second = modem("wwan1", "Northwind", "1", "platform-other");
		const third = modem("wwan2", "Northwind", "2");
		project({ modems: { "1": first, "2": second, "3": third } });

		const remaining = project({ modems: { "2": second, "3": third } });
		expect(remaining.label("wwan1")).toBe("Northwind · RM520N · wwan1");
		expect(remaining.label("wwan2")).toBe("Northwind · RM520N · USB 0-2");
	});

	it("keeps a survivor's discriminator from a roster of 258 qualified modems", () => {
		const project = naming.createLinkNameProjection();
		const survivor = modem("wwan0", "Northwind", "1");
		const modems = {
			survivor,
			...Object.fromEntries(
				Array.from({ length: 257 }, (_, index) => [
					`twin-${index}`,
					modem(`wwan${index + 1}`, "Northwind", String(index + 2)),
				]),
			),
		};
		const twinLabel = "Northwind · RM520N · USB 0-1";
		expect(project({ modems }).label(survivor.ifname)).toBe(twinLabel);

		const remaining = project({ modems: { survivor } });
		expect(remaining.label(survivor.ifname)).toBe(twinLabel);
		expect(remaining.correlation(survivor.ifname)).toBe(survivor.ifname);
	});

	it("does not inherit a qualifier from a stable key that differs by whitespace", () => {
		const project = naming.createLinkNameProjection();
		const original = modem("wwan0", "Northwind", "1");
		const sibling = modem("wwan1", "Northwind", "2");
		const replacement = modemSchema.parse({
			...original,
			stable_key: "platform-xhci-usb-0:1 ",
		});
		project({ modems: { original, sibling } });

		const remaining = project({ modems: { replacement } });
		expect(remaining.label(replacement.ifname)).toBe("Northwind · RM520N");
		expect(remaining.correlation(replacement.ifname)).toBeUndefined();
	});

	it("forgets older absent twins after many distinct observations", () => {
		const project = naming.createLinkNameProjection();
		const old = modem("wwan0", "Northwind", "1");
		const sibling = modem("wwan1", "Northwind", "2");
		const twins = project({ modems: { "1": old, "2": sibling } });
		expect(twins.label(old.ifname)).toBe("Northwind · RM520N · USB 0-1");
		expect(twins.correlation(old.ifname)).toBe(old.ifname);

		for (let port = 3; port < 260; port++) {
			project({
				modems: {
					"1": modem("wwan2", "Northwind", String(port)),
					"2": sibling,
				},
			});
		}

		const recent = project({ modems: { "2": sibling } });
		expect(recent.label(sibling.ifname)).toBe("Northwind · RM520N · USB 0-2");
		const returned = project({ modems: { "1": old } });
		expect(returned.label(old.ifname)).toBe("Northwind · RM520N");
		expect(returned.correlation(old.ifname)).toBeUndefined();
	});

	it("keeps the surviving name when an earlier modem disappears and returns with a new id", () => {
		const first = modem("wwan0", "Northwind", "1.1");
		const second = modem("wwan1", "Harbor Cell", "1.2");
		const name = linkName("wwan1", { modems: { "1": first, "2": second } });
		expect(linkName("wwan1", { modems: { "2": second } })).toBe(name);
		expect(linkName("wwan1", { modems: { "2": second, "9": first } })).toBe(
			name,
		);
		expect(linkName("wwan0", { modems: { "2": second, "9": first } })).toBe(
			"Northwind · RM520N",
		);
	});

	it("names a MAC-named radio with no network by its own name, never the MAC", () => {
		expect(radioName("wlx00c0cafe2f27")).toBe("Wi-Fi (2f27)");
		expect(radioName("wlan1")).toBe("Wi-Fi 2");
		expect(radioName("wlx00c0cafe2f27")).not.toContain("00c0cafe");
	});

	it("names a Wi-Fi link by the network it joined", () => {
		expect(linkName("wlan0", { wifi })).toBe("Wi-Fi · HomeNetwork");
	});

	it("names a MAC-named USB radio by its last four digits", () => {
		expect(linkName("wlx00c0cafe2f27", { wifi })).toBe("Wi-Fi (2f27)");
	});

	it("qualifies the same SSID with each radio's observable hint", () => {
		const sameSsid = { ...wifi, r1: radio("wlx00c0cafe2f27", "HomeNetwork") };
		expect(linkName("wlan0", { wifi: sameSsid })).toBe(
			"Wi-Fi · HomeNetwork (1)",
		);
		expect(linkName("wlx00c0cafe2f27", { wifi: sameSsid })).toBe(
			"Wi-Fi · HomeNetwork (2f27)",
		);
	});

	it("calls a USB network device a USB tether, without guessing what it is", () => {
		expect(linkName("usb0", {})).toBe("USB tether (usb0)");
		expect(linkName("usb0", {}).toLowerCase()).not.toContain("phone");
	});

	it("keeps the type label for everything else", () => {
		expect(linkName("eth0", {})).toBe("Ethernet 1");
		expect(linkName("eth1", {})).toBe("Ethernet 2");
	});

	it("leaves an unknown interface literal", () => {
		expect(linkName("tun0", {})).toBe("tun0");
	});
});
