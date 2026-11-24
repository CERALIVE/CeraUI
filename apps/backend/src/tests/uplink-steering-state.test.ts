import { describe, expect, test } from "bun:test";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import {
	isBondCandidate,
	NETIF_ERR_HOTSPOT,
	NETIF_ERR_SHAREDLAN,
} from "../modules/network/network-interfaces.ts";
import {
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import { buildShareRuleset } from "../modules/network/uplink-steering/ruleset.ts";
import { readDesiredSteeringState } from "../modules/network/uplink-steering/state-builder.ts";
import { isConcurrentApIfname } from "../modules/wifi/wifi-concurrent-interface.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./helpers/constructed-usb-twins.ts";
import {
	harness,
	health,
	netif,
} from "./uplink-steering-state-test-fixtures.ts";
import { readReadySteeringState } from "./uplink-steering-test-fixtures.ts";

describe("readDesiredSteeringState", () => {
	test.each(["clap-wlan0", "clap-a1b2c3d4"])(
		"retained virtual name %s is a client zone and never an uplink",
		async (name) => {
			const state = await readReadySteeringState(
				harness({
					interfaces: () => ({
						[name]: netif("10.42.0.1", "255.255.255.0", NETIF_ERR_HOTSPOT),
						wlan0: netif("192.168.2.8"),
					}),
					isClientZone: isConcurrentApIfname,
					isBondCandidate,
					health: () => [health(name, "up", 100), health("wlan0", "up", 100)],
				}),
			);
			expect(state.clientZones).toEqual([
				{ ifname: name, ipv4Cidr: "10.42.0.0/24" },
			]);
			expect(state.uplinks.map((uplink) => uplink.ifname)).toEqual(["wlan0"]);
		},
	);

	test.each(["netif", "zones"] as const)(
		"keeps the first plan pending before %s readiness, even with no client zones",
		async (missing) => {
			const h = harness({
				netifReady: () => missing !== "netif",
				zonesReady: () => missing !== "zones",
				interfaces: () => ({}),
			});
			expect(await readDesiredSteeringState(h)).toEqual({
				pending: true,
				netifReady: missing !== "netif",
				reason: missing,
			});
			expect(h.planned).toEqual([]);
		},
	);

	test("holds the first plan for uncovered identities and omits only new identities after apply", async () => {
		const h = harness({ identityCovered: () => false });
		expect(await readDesiredSteeringState(h)).toMatchObject({
			pending: true,
			reason: "identity",
		});
		expect(h.planned).toEqual([]);
		const state = await readReadySteeringState(h, { hasAppliedState: true });
		expect(state.uplinks.map((entry) => entry.ifname)).toEqual(["wlan0"]);
	});

	test("uses the shared identity deadline to plan an uncovered fallback", async () => {
		const h = harness({
			identityCovered: () => false,
			identityDeadlineExpired: () => true,
			physicalIdentity: (ifname) => `ifname:${ifname}`,
		});
		const state = await readReadySteeringState(h);
		expect(
			state.uplinks.find((entry) => entry.ifname === "wwan0")?.identity,
		).toBe("ifname:wwan0");
	});

	test("a populated snapshot without wlan devices is ready without Wi-Fi discovery", async () => {
		const h = harness({ interfaces: () => ({}) });
		expect(await readDesiredSteeringState(h)).toEqual({
			clientZones: [],
			uplinks: [],
			routes: [],
		});
	});

	test("assigns the constructed Dell placeholders two distinct steering marks", async () => {
		try {
			await refreshUsbNetMarkers(
				constructedTwins.map((d) => d.ifname),
				constructedTwinDeps(),
			);
			const h = harness({
				interfaces: () => ({
					eth9: netif("10.43.0.1", "255.255.255.0", NETIF_ERR_SHAREDLAN),
					wwu1u4c2: netif("100.64.1.2"),
					wwu1c2: netif("100.64.2.2"),
				}),
				health: () => [],
				physicalIdentity: (ifname) =>
					resolveModemPhysicalIdentity(ifname).identityKey,
			});
			const state = await readReadySteeringState(h);
			expect(state.uplinks).toHaveLength(2);
			expect(new Set(state.uplinks.map((u) => u.mark)).size).toBe(2);
		} finally {
			resetUsbNetMarkers();
		}
	});
	test("derives both client zones and consumes health weights", async () => {
		const h = harness();
		const state = await readReadySteeringState(h);

		expect(state.clientZones).toEqual([
			{ ifname: "clap-wlan0", ipv4Cidr: "10.42.0.0/24" },
			{ ifname: "eth9", ipv4Cidr: "10.43.0.0/24" },
		]);
		expect(
			state.uplinks.map(({ ifname, weight }) => ({ ifname, weight })),
		).toEqual([
			{ ifname: "wlan0", weight: 25 },
			{ ifname: "wwan0", weight: 100 },
		]);
		expect(
			state.uplinks.find((item) => item.ifname === "wlan0")?.identity,
		).toBe("wifi-mac:00:11:22:33:44:55");
		expect(h.planned.map((candidate) => candidate.ifname)).toEqual([
			"wlan0",
			"wwan0",
		]);
	});

	test("defaults an unobserved uplink to full weight during health startup", async () => {
		const h = harness({ health: () => [] });
		const state = await readReadySteeringState(h);

		expect(state.uplinks.map((item) => item.weight)).toEqual([100, 100, 100]);
	});

	test("withholds WiFi until its permanent identity is available", async () => {
		const h = harness({ wifiIdentity: () => undefined });
		const state = await readReadySteeringState(h);

		expect(state.uplinks.map((item) => item.ifname)).toEqual(["wwan0"]);
	});

	test("keeps the non-colliding state and ruleset bytes from main", async () => {
		const state = await readReadySteeringState(harness());
		expect(JSON.stringify(state)).toMatchSnapshot();
		expect(buildShareRuleset(state)).toMatchSnapshot();
	});
});
