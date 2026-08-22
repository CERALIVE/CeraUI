/**
 * The BlueZ object fold (b), the device-class model (c), and Battery1 (d).
 *
 * The two claims that carry the most weight:
 *
 *  1. `deviceClass` and `scoCapable` are DIFFERENT questions. An A2DP-source-only
 *     device is a genuine audio input with no SCO leg, so deriving `scoCapable`
 *     from "has an audio UUID" would publish a `PROFILE=sco` source row that can
 *     never open. The table below drives every combination that distinction
 *     turns on.
 *  2. A `PropertiesChanged` is a DELTA. Folding one onto an unknown path would
 *     mint a device from a partial view; folding one that omits a key must not
 *     reset that key. Both are asserted, in both directions.
 */
import { describe, expect, test } from "bun:test";

import { type DbusValue, variant } from "@ceralive/modem-control/transport";

import {
	deriveCapability,
	isPlaybackOnly,
	shortUuid,
} from "../modules/bluetooth/bluetooth-classes.ts";
import {
	ADAPTER_IFACE,
	BATTERY_IFACE,
	DEVICE_IFACE,
} from "../modules/bluetooth/bluetooth-constants.ts";
import { BluetoothRegistry } from "../modules/bluetooth/bluetooth-registry.ts";

const ADAPTER = "/org/bluez/hci0";
const HEADSET = "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF";
const SPEAKER = "/org/bluez/hci0/dev_11_22_33_44_55_66";

const sig = (short: string): string =>
	`0000${short}-0000-1000-8000-00805f9b34fb`;

const HFP_HEADSET_UUIDS = [sig("110b"), sig("110e"), sig("111e"), sig("1108")];
const A2DP_SOURCE_ONLY_UUIDS = [sig("110a"), sig("110c")];
const A2DP_SINK_ONLY_UUIDS = [sig("110b"), sig("110e")];

function props(entries: Record<string, [string, DbusValue]>): DbusValue {
	return Object.entries(entries).map(([name, [signature, value]]) => [
		name,
		variant(signature, value),
	]) as unknown as DbusValue;
}

function ifaces(entries: Record<string, DbusValue>): DbusValue {
	return Object.entries(entries) as unknown as DbusValue;
}

function tree(entries: Record<string, DbusValue>): DbusValue {
	return Object.entries(entries) as unknown as DbusValue;
}

const adapterProps = props({
	Address: ["s", "DC:A6:32:00:11:22"],
	Alias: ["s", "ceralive"],
	Powered: ["b", true],
	Discovering: ["b", false],
	Pairable: ["b", true],
});

function deviceProps(
	overrides: Record<string, [string, DbusValue]> = {},
): DbusValue {
	return props({
		Address: ["s", "AA:BB:CC:DD:EE:FF"],
		Name: ["s", "RODE Wireless"],
		Alias: ["s", "Presenter mic"],
		Paired: ["b", true],
		Trusted: ["b", true],
		Connected: ["b", false],
		Blocked: ["b", false],
		UUIDs: ["as", [...HFP_HEADSET_UUIDS]],
		...overrides,
	});
}

function snapshot(registry: BluetoothRegistry): void {
	registry.applyManagedObjectsBody(
		tree({
			[ADAPTER]: ifaces({ [ADAPTER_IFACE]: adapterProps }),
			[HEADSET]: ifaces({
				[DEVICE_IFACE]: deviceProps(),
				[BATTERY_IFACE]: props({ Percentage: ["y", 64] }),
			}),
		}),
	);
}

describe("device-class derivation (D1)", () => {
	test("an HFP microphone is audio-input AND scoCapable", () => {
		expect(deriveCapability(HFP_HEADSET_UUIDS)).toEqual({
			deviceClass: "audio-input",
			scoCapable: true,
		});
	});

	test("an HSP-only headset is scoCapable too", () => {
		expect(deriveCapability([sig("1108")])).toEqual({
			deviceClass: "audio-input",
			scoCapable: true,
		});
	});

	test("an A2DP-SOURCE-only device is audio-input but NOT scoCapable", () => {
		expect(deriveCapability(A2DP_SOURCE_ONLY_UUIDS)).toEqual({
			deviceClass: "audio-input",
			scoCapable: false,
		});
	});

	test("an A2DP-SINK-only speaker is neither", () => {
		expect(deriveCapability(A2DP_SINK_ONLY_UUIDS)).toEqual({
			deviceClass: "unknown",
			scoCapable: false,
		});
		expect(isPlaybackOnly(A2DP_SINK_ONLY_UUIDS)).toBe(true);
	});

	test("a device with no resolved UUIDs claims nothing", () => {
		expect(deriveCapability([])).toEqual({
			deviceClass: "unknown",
			scoCapable: false,
		});
	});

	test("a vendor UUID is never folded onto a SIG short form", () => {
		// Same first four digits as HFP, different base — a different service.
		expect(shortUuid("0000111e-0000-1000-8000-0000deadbeef")).toBeUndefined();
		expect(deriveCapability(["0000111e-0000-1000-8000-0000deadbeef"])).toEqual({
			deviceClass: "unknown",
			scoCapable: false,
		});
	});

	test("a bare 16-bit short UUID is accepted", () => {
		expect(shortUuid("111E")).toBe("111e");
		expect(deriveCapability(["111e"]).scoCapable).toBe(true);
	});

	test("an AG counterpart still counts as a SCO peer", () => {
		expect(deriveCapability([sig("111f")]).scoCapable).toBe(true);
		expect(deriveCapability([sig("1112")]).scoCapable).toBe(true);
	});
});

describe("the GetManagedObjects fold", () => {
	test("adapters and devices land as rows, with the battery attached", () => {
		const registry = new BluetoothRegistry();
		snapshot(registry);

		expect(registry.adapterPaths()).toEqual([ADAPTER]);
		const adapter = registry.adapter(ADAPTER);
		expect(adapter?.powered).toBe(true);
		expect(adapter?.name).toBe("ceralive");

		const device = registry.device(HEADSET);
		expect(device?.address).toBe("AA:BB:CC:DD:EE:FF");
		// Alias outranks Name — it is what BlueZ renders.
		expect(device?.name).toBe("Presenter mic");
		expect(device?.adapterPath).toBe(ADAPTER);
		expect(device?.deviceClass).toBe("audio-input");
		expect(device?.scoCapable).toBe(true);
		expect(device?.batteryPercentage).toBe(64);
	});

	test("an out-of-range battery reading is dropped, not clamped", () => {
		const registry = new BluetoothRegistry();
		registry.applyManagedObjectsBody(
			tree({
				[HEADSET]: ifaces({
					[DEVICE_IFACE]: deviceProps(),
					[BATTERY_IFACE]: props({ Percentage: ["y", 250] }),
				}),
			}),
		);
		expect(registry.device(HEADSET)?.batteryPercentage).toBeUndefined();
	});
});

describe("InterfacesAdded / InterfacesRemoved", () => {
	test("a discovered device is added", () => {
		const registry = new BluetoothRegistry();
		snapshot(registry);

		const changed = registry.applyInterfacesAdded(
			SPEAKER,
			ifaces({
				[DEVICE_IFACE]: props({
					Address: ["s", "11:22:33:44:55:66"],
					Name: ["s", "Bench speaker"],
					RSSI: ["n", -61],
					UUIDs: ["as", [...A2DP_SINK_ONLY_UUIDS]],
				}),
			}),
		);

		expect(changed).toBe(true);
		const row = registry.device(SPEAKER);
		expect(row?.name).toBe("Bench speaker");
		expect(row?.rssi).toBe(-61);
		expect(row?.deviceClass).toBe("unknown");
		expect(row?.paired).toBe(false);
	});

	test("a Battery1 arriving on its own attaches to the existing device row", () => {
		const registry = new BluetoothRegistry();
		registry.applyInterfacesAdded(
			SPEAKER,
			ifaces({
				[DEVICE_IFACE]: props({ Address: ["s", "11:22:33:44:55:66"] }),
			}),
		);
		const changed = registry.applyInterfacesAdded(
			SPEAKER,
			ifaces({ [BATTERY_IFACE]: props({ Percentage: ["y", 12] }) }),
		);

		expect(changed).toBe(true);
		expect(registry.device(SPEAKER)?.batteryPercentage).toBe(12);
	});

	test("a Battery1 for a device we have never seen creates nothing", () => {
		const registry = new BluetoothRegistry();
		const changed = registry.applyInterfacesAdded(
			SPEAKER,
			ifaces({ [BATTERY_IFACE]: props({ Percentage: ["y", 12] }) }),
		);
		expect(changed).toBe(false);
		expect(registry.device(SPEAKER)).toBeUndefined();
	});

	test("removing Device1 retires the row", () => {
		const registry = new BluetoothRegistry();
		snapshot(registry);

		const changed = registry.applyInterfacesRemoved(HEADSET, [
			DEVICE_IFACE,
		] as unknown as DbusValue);
		expect(changed).toBe(true);
		expect(registry.device(HEADSET)).toBeUndefined();
	});

	test("removing ONLY Battery1 keeps the device and clears the reading", () => {
		const registry = new BluetoothRegistry();
		snapshot(registry);

		const changed = registry.applyInterfacesRemoved(HEADSET, [
			BATTERY_IFACE,
		] as unknown as DbusValue);
		expect(changed).toBe(true);
		expect(registry.device(HEADSET)).toBeDefined();
		expect(registry.device(HEADSET)?.batteryPercentage).toBeUndefined();
	});
});

describe("PropertiesChanged is a delta", () => {
	test("a change for an unknown path is DROPPED, never adopted as a new row", () => {
		const registry = new BluetoothRegistry();
		const changed = registry.applyPropertiesChanged(
			SPEAKER,
			DEVICE_IFACE,
			props({ Connected: ["b", true] }),
		);
		expect(changed).toBe(false);
		expect(registry.devices()).toEqual([]);
	});

	test("an omitted key is left ALONE, not reset to its default", () => {
		const registry = new BluetoothRegistry();
		snapshot(registry);

		registry.applyPropertiesChanged(
			HEADSET,
			DEVICE_IFACE,
			props({ Connected: ["b", true] }),
		);

		const row = registry.device(HEADSET);
		expect(row?.connected).toBe(true);
		expect(row?.paired).toBe(true);
		expect(row?.trusted).toBe(true);
		expect(row?.scoCapable).toBe(true);
	});

	test("`invalidated` clears the named property", () => {
		const registry = new BluetoothRegistry();
		snapshot(registry);
		registry.applyPropertiesChanged(
			HEADSET,
			DEVICE_IFACE,
			props({ RSSI: ["n", -40] }),
		);
		expect(registry.device(HEADSET)?.rssi).toBe(-40);

		registry.applyPropertiesChanged(HEADSET, DEVICE_IFACE, props({}), [
			"RSSI",
		] as unknown as DbusValue);
		expect(registry.device(HEADSET)?.rssi).toBeUndefined();
	});

	test("a battery change folds onto the device row", () => {
		const registry = new BluetoothRegistry();
		snapshot(registry);
		registry.applyPropertiesChanged(
			HEADSET,
			BATTERY_IFACE,
			props({ Percentage: ["y", 5] }),
		);
		expect(registry.device(HEADSET)?.batteryPercentage).toBe(5);
	});

	test("an adapter's Discovering edge folds", () => {
		const registry = new BluetoothRegistry();
		snapshot(registry);
		registry.applyPropertiesChanged(
			ADAPTER,
			ADAPTER_IFACE,
			props({ Discovering: ["b", true] }),
		);
		expect(registry.adapter(ADAPTER)?.discovering).toBe(true);
	});
});

describe("pending states + reconnect candidates", () => {
	test("a pending stamp survives a resnapshot — it describes OUR work", () => {
		const registry = new BluetoothRegistry();
		snapshot(registry);
		registry.setDevicePending(HEADSET, { op: "pair", startedAtMs: 42 });

		snapshot(registry);
		expect(registry.device(HEADSET)?.pending).toEqual({
			op: "pair",
			startedAtMs: 42,
		});
	});

	test("only trusted, paired, disconnected devices are reconnect candidates", () => {
		const registry = new BluetoothRegistry();
		snapshot(registry);
		registry.applyInterfacesAdded(
			SPEAKER,
			ifaces({
				[DEVICE_IFACE]: props({
					Address: ["s", "11:22:33:44:55:66"],
					Paired: ["b", true],
					Trusted: ["b", false],
				}),
			}),
		);

		expect(registry.reconnectCandidates().map((d) => d.path)).toEqual([
			HEADSET,
		]);

		registry.applyPropertiesChanged(
			HEADSET,
			DEVICE_IFACE,
			props({ Connected: ["b", true] }),
		);
		expect(registry.reconnectCandidates()).toEqual([]);
	});
});
