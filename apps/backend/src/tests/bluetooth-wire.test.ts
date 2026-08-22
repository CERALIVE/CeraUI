/**
 * The Bluetooth WIRE projection — the layer between todo 12's stack and the
 * `@ceraui/rpc` shapes an operator surface renders.
 *
 * The claims that carry the most weight:
 *
 *  - A recoverable boolean is published EXPLICITLY, so a disconnect can be
 *    rendered rather than latched (the `policy_route_missing` class).
 *  - `battery`/`rssi` are OMITTED when unread — never a measured zero.
 *  - `transport` is positive-evidence-only: a device that proves nothing reads
 *    `unknown`, and the proof reuses `bluetooth-classes.ts` rather than a second
 *    UUID table.
 *  - The five-state claims say `unavailable` for pairing on a build that ships
 *    no D-Bus object server, so the agent gap is stated rather than discovered
 *    from a pairing that never lands.
 *  - The whole payload parses against the published schema.
 */
import { describe, expect, test } from "bun:test";

import { bluetoothStatusSchema } from "@ceraui/rpc/schemas";

import type { BluetoothDeviceRow } from "../modules/bluetooth/bluetooth-registry.ts";
import type { BluetoothStackState } from "../modules/bluetooth/bluetooth-stack.ts";
import {
	buildBluetoothStatus,
	deriveBluetoothTransport,
	projectBluetoothDevice,
	resolveBluetoothCapabilityClaims,
} from "../modules/bluetooth/bluetooth-wire.ts";

const ADAPTER = "/org/bluez/hci0";
const HEADSET = "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF";

const HFP_UUID = "0000111e-0000-1000-8000-00805f9b34fb";
const A2DP_SOURCE_UUID = "0000110a-0000-1000-8000-00805f9b34fb";
const A2DP_SINK_UUID = "0000110b-0000-1000-8000-00805f9b34fb";
const VENDOR_UUID = "0000fe2c-0000-1000-8000-0000deadbeef";

function deviceRow(over: Partial<BluetoothDeviceRow> = {}): BluetoothDeviceRow {
	return {
		path: HEADSET,
		adapterPath: ADAPTER,
		address: "AA:BB:CC:DD:EE:FF",
		name: "DJI Mic Mini",
		paired: true,
		trusted: true,
		connected: true,
		blocked: false,
		rssi: undefined,
		uuids: [HFP_UUID],
		deviceClass: "audio-input",
		scoCapable: true,
		batteryPercentage: undefined,
		pending: undefined,
		...over,
	};
}

function stackState(
	over: Partial<BluetoothStackState> = {},
): BluetoothStackState {
	return {
		available: true,
		enabled: true,
		adapters: [
			{
				path: ADAPTER,
				address: "11:22:33:44:55:66",
				name: "ceralive",
				powered: true,
				discovering: false,
				discoverable: false,
				pairable: true,
				pending: undefined,
			},
		],
		devices: [deviceRow()],
		agent: { registered: true, isDefaultAgent: true },
		bootReconnectDone: true,
		...over,
	};
}

describe("device projection", () => {
	test("the four recoverable booleans are always present, including when false", () => {
		const row = projectBluetoothDevice(
			deviceRow({
				paired: false,
				trusted: false,
				connected: false,
				blocked: false,
			}),
		);
		expect(row.paired).toBe(false);
		expect(row.trusted).toBe(false);
		expect(row.connected).toBe(false);
		expect(row.blocked).toBe(false);
		for (const key of ["paired", "trusted", "connected", "blocked"]) {
			expect(Object.hasOwn(row, key)).toBe(true);
		}
	});

	test("an unread battery/rssi is OMITTED, never zero-filled", () => {
		const row = projectBluetoothDevice(deviceRow());
		expect(Object.hasOwn(row, "battery")).toBe(false);
		expect(Object.hasOwn(row, "rssi")).toBe(false);
	});

	test("a measured zero battery survives as a zero", () => {
		const row = projectBluetoothDevice(deviceRow({ batteryPercentage: 0 }));
		expect(row.battery).toBe(0);
	});

	test("the S7 pending stamp rides the row", () => {
		const row = projectBluetoothDevice(
			deviceRow({ pending: { op: "pair", startedAtMs: 1234 } }),
		);
		expect(row.pending).toEqual({ op: "pair", startedAtMs: 1234 });
	});
});

describe("transport is positive evidence only", () => {
	test("HFP proves BR/EDR", () => {
		expect(deriveBluetoothTransport(deviceRow())).toBe("bredr");
	});

	test("an A2DP SOURCE with no SCO leg still proves BR/EDR", () => {
		expect(
			deriveBluetoothTransport(
				deviceRow({
					uuids: [A2DP_SOURCE_UUID],
					deviceClass: "audio-input",
					scoCapable: false,
				}),
			),
		).toBe("bredr");
	});

	test("an A2DP SINK — not an audio input at all — still proves BR/EDR", () => {
		expect(
			deriveBluetoothTransport(
				deviceRow({
					uuids: [A2DP_SINK_UUID],
					deviceClass: "unknown",
					scoCapable: false,
				}),
			),
		).toBe("bredr");
	});

	test("a device that proves nothing reads `unknown`, never a guessed bucket", () => {
		expect(
			deriveBluetoothTransport(
				deviceRow({ uuids: [], deviceClass: "unknown", scoCapable: false }),
			),
		).toBe("unknown");
		expect(
			deriveBluetoothTransport(
				deviceRow({
					uuids: [VENDOR_UUID],
					deviceClass: "unknown",
					scoCapable: false,
				}),
			),
		).toBe("unknown");
	});
});

describe("the five-state capability claims", () => {
	test("Bluetooth switched OFF is `implemented` — shipped, gate off", () => {
		const claims = resolveBluetoothCapabilityClaims(
			stackState({ enabled: false }),
		);
		expect(claims.adapter).toBe("implemented");
		expect(claims.pairing).toBe("implemented");
	});

	test("an observed controller with the gate on is `capable`", () => {
		expect(resolveBluetoothCapabilityClaims(stackState()).adapter).toBe(
			"capable",
		);
	});

	test("a board BlueZ says has no controller is `unavailable`, not merely unknown", () => {
		const claims = resolveBluetoothCapabilityClaims(
			stackState({
				available: false,
				adapters: [],
				devices: [],
				unavailable: {
					ok: false,
					error: "bt_unavailable",
					cause: "no_adapter",
				},
			}),
		);
		expect(claims.adapter).toBe("unavailable");
	});

	test("a stack that never started is `enabled` — an unread capability is not an absent one", () => {
		const claims = resolveBluetoothCapabilityClaims(
			stackState({
				available: false,
				adapters: [],
				devices: [],
				unavailable: {
					ok: false,
					error: "bt_unavailable",
					cause: "bluez_unavailable",
				},
			}),
		);
		expect(claims.adapter).toBe("enabled");
	});

	test("the missing D-Bus object server makes pairing `unavailable`, stated out loud", () => {
		const claims = resolveBluetoothCapabilityClaims(
			stackState({
				agent: {
					registered: false,
					isDefaultAgent: false,
					reason: "exporter_unavailable",
				},
			}),
		);
		expect(claims.pairing).toBe("unavailable");
	});

	test("a BlueZ-refused agent is `enabled` — that is a READ failure, not an absence", () => {
		const claims = resolveBluetoothCapabilityClaims(
			stackState({
				agent: {
					registered: false,
					isDefaultAgent: false,
					reason: "bluez_refused",
				},
			}),
		);
		expect(claims.pairing).toBe("enabled");
	});

	test("nothing reaches `certified` — no Bluetooth drill has been run on a board", () => {
		for (const state of Object.values(
			resolveBluetoothCapabilityClaims(stackState()),
		)) {
			expect(state).not.toBe("certified");
		}
	});

	test("no paired audio device leaves audio-input `enabled`, never `unavailable`", () => {
		const claims = resolveBluetoothCapabilityClaims(
			stackState({ devices: [] }),
		);
		expect(claims["audio-input"]).toBe("enabled");
		expect(claims.battery).toBe("enabled");
	});
});

describe("the whole payload", () => {
	test("a healthy stack parses against the published schema", () => {
		const parsed = bluetoothStatusSchema.parse(
			buildBluetoothStatus(stackState()),
		);
		expect(parsed.adapters).toHaveLength(1);
		expect(parsed.devices[0]?.transport).toBe("bredr");
		expect(parsed.unavailable).toBeUndefined();
	});

	test("an unavailable stack carries its cause and still states the operator's answer", () => {
		const parsed = bluetoothStatusSchema.parse(
			buildBluetoothStatus(
				stackState({
					available: false,
					enabled: true,
					adapters: [],
					devices: [],
					unavailable: {
						ok: false,
						error: "bt_unavailable",
						cause: "bus_unreachable",
						detail: "connect ENOENT",
					},
				}),
			),
		);
		expect(parsed.available).toBe(false);
		expect(parsed.enabled).toBe(true);
		expect(parsed.unavailable?.cause).toBe("bus_unreachable");
	});
});
