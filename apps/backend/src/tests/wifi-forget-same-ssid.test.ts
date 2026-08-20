/*
  Regression lock: Forget must remove the NETWORK, not one profile of it.

  NetworkManager holds a profile per CONNECTION, and `WifiInterface.saved` is
  keyed by SSID — so two profiles for one SSID collapse to one operator row and
  one reachable uuid. Board-observed on a Rock 5B+ (2026-08-19): the adapter held
  `4G-UFI-611A` AND `ufi-recovery`, both `802-11-wireless.ssid = 4G-UFI-611A`.
  Forget was clicked, the delete SUCCEEDED, and the row still read "Saved"
  because the sibling kept the SSID in the map — indistinguishable, to the
  operator, from a Forget that did nothing. That is half of the reported
  "forgetting a network is not working" (the other half was an nmcli storm, see
  `wifi-rescan-coalescing.test.ts`).

  `savedAll` is what makes the siblings reachable. It is deliberately NOT on the
  wire: connect and disconnect still act on the ONE `saved` uuid, because those
  mean "act on this connection" where Forget means "remove this network".
*/

import { afterEach, describe, expect, test } from "bun:test";

import {
	registerSavedWifiConnection,
	wifiSiblingConnections,
} from "../modules/wifi/wifi.ts";
import {
	addWifiInterface,
	getWifiInterfacesByMacAddress,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import type {
	MacAddress,
	SSID,
	WifiInterface,
} from "../modules/wifi/wifi-interfaces.ts";

const ADAPTER: MacAddress = "aa:bb:cc:dd:ee:01";
const SSID_NAME: SSID = "4G-UFI-611A";
// The board's own two profiles for that one SSID.
const PRIMARY = "406807e2-7cee-4b57-afbb-0493ec278cb6";
const SIBLING = "e58a2b4e-57e6-4c0d-b6c3-55f137e8e4a9";

function makeInterface(): WifiInterface {
	return {
		id: 0,
		ifname: "wlan0",
		conn: null,
		hw: "Test Adapter",
		available: new Map(),
		saved: {},
		savedAll: {},
	};
}

describe("same-SSID saved profiles", () => {
	test("both profiles are recorded, while `saved` still names exactly one", () => {
		// Given: an adapter with no saved profiles.
		const interfaces = { [ADAPTER]: makeInterface() };

		// When: two unbound profiles for the SAME ssid are registered.
		registerSavedWifiConnection(interfaces, "", SSID_NAME, PRIMARY);
		registerSavedWifiConnection(interfaces, "", SSID_NAME, SIBLING);

		// Then: the wire-facing map is unchanged (first-wins, as before)...
		const iface = interfaces[ADAPTER];
		expect(iface?.saved[SSID_NAME]).toBe(PRIMARY);
		// ...and BOTH are reachable for Forget.
		expect(iface?.savedAll[SSID_NAME]).toEqual([PRIMARY, SIBLING]);
	});

	test("a MAC-bound profile records its sibling on ITS adapter only", () => {
		// Given: two present adapters.
		const other: MacAddress = "aa:bb:cc:dd:ee:02";
		const interfaces = { [ADAPTER]: makeInterface(), [other]: makeInterface() };

		// When: two profiles bound to the FIRST adapter share one ssid.
		registerSavedWifiConnection(interfaces, ADAPTER, SSID_NAME, PRIMARY);
		registerSavedWifiConnection(interfaces, ADAPTER, SSID_NAME, SIBLING);

		// Then: forgetting on that adapter reaches both, and the other adapter is
		// untouched — a bound profile is not another radio's network to remove.
		expect(interfaces[ADAPTER]?.savedAll[SSID_NAME]).toEqual([
			PRIMARY,
			SIBLING,
		]);
		expect(interfaces[other]?.savedAll[SSID_NAME]).toBeUndefined();
	});

	test("re-registering the same uuid does not duplicate it", () => {
		// Given/When: the sweep runs twice over one profile.
		const interfaces = { [ADAPTER]: makeInterface() };
		registerSavedWifiConnection(interfaces, "", SSID_NAME, PRIMARY);
		registerSavedWifiConnection(interfaces, "", SSID_NAME, PRIMARY);

		// Then: Forget issues one delete for it, not two.
		expect(interfaces[ADAPTER]?.savedAll[SSID_NAME]).toEqual([PRIMARY]);
	});

	test("different SSIDs never pool their profiles", () => {
		// Given/When: two profiles for two different networks.
		const interfaces = { [ADAPTER]: makeInterface() };
		registerSavedWifiConnection(interfaces, "", SSID_NAME, PRIMARY);
		registerSavedWifiConnection(interfaces, "", "SOMOS - 701", SIBLING);

		// Then: forgetting one network can never delete the other's profile.
		expect(interfaces[ADAPTER]?.savedAll[SSID_NAME]).toEqual([PRIMARY]);
		expect(interfaces[ADAPTER]?.savedAll["SOMOS - 701"]).toEqual([SIBLING]);
	});
});

describe("wifiSiblingConnections — what Forget actually deletes", () => {
	afterEach(() => {
		for (const mac of Object.keys(getWifiInterfacesByMacAddress())) {
			removeWifiInterface(mac);
		}
	});

	test("the board's own two-profile SSID resolves BOTH uuids", () => {
		// Given: the registry as the board reported it.
		const iface = makeInterface();
		addWifiInterface(ADAPTER, iface);
		registerSavedWifiConnection(
			getWifiInterfacesByMacAddress() as Record<MacAddress, WifiInterface>,
			"",
			SSID_NAME,
			PRIMARY,
		);
		registerSavedWifiConnection(
			getWifiInterfacesByMacAddress() as Record<MacAddress, WifiInterface>,
			"",
			SSID_NAME,
			SIBLING,
		);

		// When/Then: Forget on the row's uuid reaches the sibling too.
		expect(wifiSiblingConnections(PRIMARY).sort()).toEqual(
			[PRIMARY, SIBLING].sort(),
		);
	});

	test("a lone profile resolves to itself and nothing else", () => {
		// Given: one profile per SSID, two SSIDs.
		const iface = makeInterface();
		addWifiInterface(ADAPTER, iface);
		const registry = getWifiInterfacesByMacAddress() as Record<
			MacAddress,
			WifiInterface
		>;
		registerSavedWifiConnection(registry, "", SSID_NAME, PRIMARY);
		registerSavedWifiConnection(registry, "", "SOMOS - 701", SIBLING);

		// When/Then: Forget stays scoped to the network it was asked about.
		expect(wifiSiblingConnections(PRIMARY)).toEqual([PRIMARY]);
		expect(wifiSiblingConnections(SIBLING)).toEqual([SIBLING]);
	});

	test("an unknown uuid resolves to itself — never to somebody else's profile", () => {
		// Given: a registry that has never seen this uuid.
		addWifiInterface(ADAPTER, makeInterface());

		// When/Then: the caller's own target, and no collateral.
		expect(wifiSiblingConnections("no-such-uuid")).toEqual(["no-such-uuid"]);
	});
});
