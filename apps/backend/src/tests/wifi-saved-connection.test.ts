/*
 * Regression: an ACTIVE, connected saved network showed a "Connect" button
 * instead of "Disconnect" (confirmed on real hardware — SSID "SOMOS - 701").
 *
 * Root cause lived in wifiUpdateSavedConns: a saved infrastructure profile was
 * added to an interface's `saved` map ONLY when its `802-11-wireless.mac-address`
 * matched a currently-present adapter. A profile with no bound MAC (created
 * outside CeraUI — nmtui, `nmcli device wifi connect`, a baked image profile) or
 * a bound MAC that no longer matches the live adapter (MAC randomization / swapped
 * adapter) was silently dropped. The scan path (wifiUpdateScanResult) has no such
 * requirement, so the network still rendered `active: true` in `available` while
 * being absent from `saved` — the frontend `getWifiUUID` then resolved `undefined`
 * and the UI offered "Connect" on the already-connected network.
 *
 * `registerSavedWifiConnection` is the extracted keying step. The "unbound" case
 * below is the exact reproduction: before the fix the connection was NOT recorded
 * in `saved`, so the `toBe(UUID)` assertions would have failed (the value was
 * `undefined`).
 */
import { describe, expect, it } from "bun:test";
import { registerSavedWifiConnection } from "../modules/wifi/wifi.ts";
import type { SSID, WifiInterface } from "../modules/wifi/wifi-interfaces.ts";

const SSID_NAME: SSID = "SOMOS - 701";
const UUID = "11112222-3333-4444-5555-666677778888";
const ADAPTER_A = "aa:bb:cc:dd:ee:01";
const ADAPTER_B = "aa:bb:cc:dd:ee:02";

function makeInterface(id: number, ifname: string): WifiInterface {
	return {
		id,
		ifname,
		conn: null,
		hw: "Test Adapter",
		available: new Map(),
		saved: {},
	};
}

describe("registerSavedWifiConnection", () => {
	it("records an unbound profile (empty MAC) so an active network resolves a UUID", () => {
		const interfaces = { [ADAPTER_A]: makeInterface(0, "wlan0") };

		registerSavedWifiConnection(interfaces, "", SSID_NAME, UUID);

		// Pre-fix this profile was dropped (empty MAC matched no adapter) and the
		// value here was `undefined` — the "Connect"-on-connected-network bug.
		expect(interfaces[ADAPTER_A]?.saved[SSID_NAME]).toBe(UUID);
	});

	it("records a profile whose bound MAC matches no present adapter on every adapter", () => {
		const interfaces = {
			[ADAPTER_A]: makeInterface(0, "wlan0"),
			[ADAPTER_B]: makeInterface(1, "wlan1"),
		};

		// A stale/randomized bound MAC that matches neither present adapter.
		registerSavedWifiConnection(
			interfaces,
			"de:ad:be:ef:00:99",
			SSID_NAME,
			UUID,
		);

		expect(interfaces[ADAPTER_A]?.saved[SSID_NAME]).toBe(UUID);
		expect(interfaces[ADAPTER_B]?.saved[SSID_NAME]).toBe(UUID);
	});

	it("attributes a MAC-bound profile to only its adapter (multi-adapter disambiguation)", () => {
		const interfaces = {
			[ADAPTER_A]: makeInterface(0, "wlan0"),
			[ADAPTER_B]: makeInterface(1, "wlan1"),
		};

		registerSavedWifiConnection(interfaces, ADAPTER_B, SSID_NAME, UUID);

		expect(interfaces[ADAPTER_B]?.saved[SSID_NAME]).toBe(UUID);
		expect(interfaces[ADAPTER_A]?.saved[SSID_NAME]).toBeUndefined();
	});

	/*
	 * Duplicate-SSID precedence: two profiles for the SAME ssid — one precisely
	 * bound to a present adapter, one on the fallback path (unbound / stale MAC).
	 * The precise binding must win on its adapter regardless of nmcli enumeration
	 * order; the fallback only fills the adapters the precise profile does not own.
	 */
	const UUID_BOUND = "aaaaaaaa-1111-2222-3333-444444444444";
	const UUID_FALLBACK = "bbbbbbbb-5555-6666-7777-888888888888";

	it("keeps a precise MAC binding when a same-SSID fallback profile is registered after it", () => {
		const interfaces = {
			[ADAPTER_A]: makeInterface(0, "wlan0"),
			[ADAPTER_B]: makeInterface(1, "wlan1"),
		};

		registerSavedWifiConnection(interfaces, ADAPTER_A, SSID_NAME, UUID_BOUND);
		registerSavedWifiConnection(interfaces, "", SSID_NAME, UUID_FALLBACK);

		expect(interfaces[ADAPTER_A]?.saved[SSID_NAME]).toBe(UUID_BOUND);
		expect(interfaces[ADAPTER_B]?.saved[SSID_NAME]).toBe(UUID_FALLBACK);
	});

	it("lets a precise MAC binding override a same-SSID fallback profile registered before it", () => {
		const interfaces = {
			[ADAPTER_A]: makeInterface(0, "wlan0"),
			[ADAPTER_B]: makeInterface(1, "wlan1"),
		};

		registerSavedWifiConnection(interfaces, "", SSID_NAME, UUID_FALLBACK);
		registerSavedWifiConnection(interfaces, ADAPTER_A, SSID_NAME, UUID_BOUND);

		expect(interfaces[ADAPTER_A]?.saved[SSID_NAME]).toBe(UUID_BOUND);
		expect(interfaces[ADAPTER_B]?.saved[SSID_NAME]).toBe(UUID_FALLBACK);
	});
});
