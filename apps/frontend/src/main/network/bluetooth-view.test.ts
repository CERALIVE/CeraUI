/**
 * Bluetooth surface derivations, and the copy-completeness gate behind them.
 *
 * Two properties carry this suite. The first is the GATE ORDER: the stack
 * records an operator-disabled device as `bt_unavailable{bluez_unavailable}`,
 * so a surface that read the cause literally would tell an operator their
 * Bluetooth service is broken when they simply switched it off. The second is
 * that every token the device can answer with has keyed copy in all ten
 * catalogs — `resolveMessageKey` renders an unknown key as the key itself, and
 * the required list is DERIVED from the wire enums so a fifteenth refusal
 * fails here until its copy lands.
 */
import {
	BLUETOOTH_MUTATION_REFUSALS,
	BLUETOOTH_UNAVAILABLE_CAUSES,
	type BluetoothAdapter,
	type BluetoothDevice,
	type BluetoothStatus,
	type BluetoothUnavailableCause,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { CATALOGS } from "../../tests/helpers/catalog";
import {
	adapterStateKey,
	bluetoothDeviceActions,
	bluetoothRefusalKey,
	bluetoothSurface,
	deviceClassKey,
	orderedBluetoothDevices,
	primaryBluetoothAdapter,
	showsAudioSourceHint,
	showsBluetoothMicBackendRefusal,
	showsPairingAgentGap,
} from "./bluetooth-view";

const ADAPTER_PATH = "/org/bluez/hci0";

function adapter(overrides: Partial<BluetoothAdapter> = {}): BluetoothAdapter {
	return {
		path: ADAPTER_PATH,
		powered: true,
		discovering: false,
		discoverable: false,
		pairable: true,
		...overrides,
	};
}

function device(overrides: Partial<BluetoothDevice> = {}): BluetoothDevice {
	return {
		path: `${ADAPTER_PATH}/dev_AA_BB_CC_DD_EE_11`,
		adapterPath: ADAPTER_PATH,
		address: "AA:BB:CC:DD:EE:11",
		name: "Jabra Talk 65",
		deviceClass: "audio-input",
		transport: "bredr",
		paired: false,
		trusted: false,
		connected: false,
		blocked: false,
		scoCapable: true,
		...overrides,
	};
}

function status(overrides: Partial<BluetoothStatus> = {}): BluetoothStatus {
	return {
		available: true,
		enabled: true,
		adapters: [adapter()],
		devices: [],
		agent: { registered: true, isDefaultAgent: true },
		bootReconnectDone: true,
		capabilities: {
			adapter: "capable",
			pairing: "capable",
			"audio-input": "capable",
			battery: "capable",
		},
		...overrides,
	};
}

function unavailable(
	cause: BluetoothUnavailableCause,
	overrides: Partial<BluetoothStatus> = {},
): BluetoothStatus {
	return status({
		available: false,
		unavailable: { cause },
		adapters: [],
		...overrides,
	});
}

describe("bluetoothSurface — the operator's answer outranks the stack's cause", () => {
	it("reports OFF for an operator-disabled device, not a service fault", () => {
		// The stack records exactly this shape when the operator switched
		// Bluetooth off — `bluez_unavailable` because it is not observing BlueZ.
		// Rendering that cause would blame a healthy service for a setting.
		expect(
			bluetoothSurface(unavailable("bluez_unavailable", { enabled: false })),
		).toEqual({ kind: "off" });
	});

	it("reports the service fault when the operator has Bluetooth ON", () => {
		expect(bluetoothSurface(unavailable("bluez_unavailable"))).toEqual({
			kind: "unavailable",
			reasonKey: "network.bluetooth.unavailable.bluezUnavailable",
		});
	});

	it("answers `emulated` BEFORE the preference gate", () => {
		// Telling an operator to switch Bluetooth on when the host has no radio
		// is advice they cannot act on, so this outranks `enabled: false`.
		for (const enabled of [true, false]) {
			expect(bluetoothSurface(unavailable("emulated", { enabled }))).toEqual({
				kind: "unavailable",
				reasonKey: "network.bluetooth.unavailable.emulated",
			});
		}
	});

	it.each([
		["bus_unreachable", "network.bluetooth.unavailable.busUnreachable"],
		["no_adapter", "network.bluetooth.unavailable.noAdapter"],
		["unit_missing", "network.bluetooth.unavailable.unitMissing"],
	] as const)("keys the %s cause", (cause, reasonKey) => {
		expect(bluetoothSurface(unavailable(cause))).toEqual({
			kind: "unavailable",
			reasonKey,
		});
	});

	it("degrades an unstated cause to the generic sentence, never a guess", () => {
		expect(
			bluetoothSurface(status({ available: false, adapters: [] })),
		).toEqual({
			kind: "unavailable",
			reasonKey: "network.bluetooth.unavailable.generic",
		});
	});

	it("reports READY when the stack is observing BlueZ", () => {
		expect(bluetoothSurface(status())).toEqual({ kind: "ready" });
	});

	it("reports OFF before any snapshot has arrived", () => {
		// No payload is not a claim about the hardware; the card must not band a
		// fault it has no evidence for.
		expect(bluetoothSurface(undefined)).toEqual({ kind: "off" });
	});
});

describe("bluetoothRefusalKey — every member of the shared enum is keyed", () => {
	it("maps all fourteen refusals to distinct, non-generic keys", () => {
		const keys = BLUETOOTH_MUTATION_REFUSALS.map(bluetoothRefusalKey);
		expect(keys).not.toContain("network.bluetooth.refusal.generic");
		expect(new Set(keys).size).toBe(BLUETOOTH_MUTATION_REFUSALS.length);
	});

	it("keeps `pairing_agent_unavailable` distinct from `pairing_failed`", () => {
		// The build ships no D-Bus object exporter, so this is the refusal a real
		// board answers today — collapsing it into "the pairing broke" sends the
		// operator to look at their headset instead of at the other device.
		expect(bluetoothRefusalKey("pairing_agent_unavailable")).not.toBe(
			bluetoothRefusalKey("pairing_failed"),
		);
	});

	it("answers generically for an absent or unrecognised token", () => {
		expect(bluetoothRefusalKey(undefined)).toBe(
			"network.bluetooth.refusal.generic",
		);
		expect(bluetoothRefusalKey("a_token_this_build_does_not_know")).toBe(
			"network.bluetooth.refusal.generic",
		);
	});
});

describe("Bluetooth microphone backend honesty", () => {
	it("points to Live on PipeWire and refuses the same microphone on ALSA", () => {
		const connectedMic = device({ connected: true });
		expect(showsAudioSourceHint(connectedMic, "pipewire")).toBe(true);
		expect(showsBluetoothMicBackendRefusal(connectedMic, "pipewire")).toBe(
			false,
		);
		expect(showsAudioSourceHint(connectedMic, "alsa")).toBe(false);
		expect(showsBluetoothMicBackendRefusal(connectedMic, "alsa")).toBe(true);
	});
});

describe("every token the device can answer with has copy, in all ten locales", () => {
	const REQUIRED_KEYS: readonly string[] = [
		...BLUETOOTH_MUTATION_REFUSALS.map(bluetoothRefusalKey),
		"network.bluetooth.audioRequiresPipewire",
		"network.bluetooth.refusal.generic",
		...BLUETOOTH_UNAVAILABLE_CAUSES.map((cause) =>
			bluetoothSurface(unavailable(cause, { enabled: true })),
		).map((surface) =>
			surface.kind === "unavailable" ? surface.reasonKey : "unreachable",
		),
		"network.bluetooth.unavailable.generic",
		...(["audio-input", "unknown"] as const).map((deviceClass) =>
			deviceClassKey(device({ deviceClass })),
		),
		adapterStateKey(adapter({ powered: false })),
		adapterStateKey(adapter()),
		adapterStateKey(adapter({ discovering: true })),
	];

	function lookup(catalog: unknown, key: string): unknown {
		let cursor: unknown = catalog;
		for (const segment of key.split(".")) {
			if (cursor === null || typeof cursor !== "object") return undefined;
			cursor = (cursor as Record<string, unknown>)[segment];
		}
		return cursor;
	}

	it("derives a non-trivial key list", () => {
		expect(BLUETOOTH_MUTATION_REFUSALS.length).toBe(14);
		expect(BLUETOOTH_UNAVAILABLE_CAUSES.length).toBe(5);
		expect(new Set(REQUIRED_KEYS).size).toBe(27);
	});

	it.each(Object.keys(CATALOGS))("%s", (locale) => {
		const missing = REQUIRED_KEYS.filter(
			(key) => typeof lookup(CATALOGS[locale], key) !== "string",
		);
		expect(missing).toEqual([]);
	});

	it("is falsifiable — a removed key is reported", () => {
		const damaged = structuredClone(CATALOGS.en) as Record<string, unknown>;
		const bluetooth = (damaged.network as Record<string, unknown>)
			.bluetooth as Record<string, unknown>;
		delete (bluetooth.refusal as Record<string, unknown>).adapterBusy;
		expect(
			REQUIRED_KEYS.filter((key) => typeof lookup(damaged, key) !== "string"),
		).toEqual(["network.bluetooth.refusal.adapterBusy"]);
	});
});

describe("orderedBluetoothDevices — bonded rows are pinned, discovery order kept", () => {
	const mic = device({ path: "/org/bluez/hci0/dev_A", paired: true });
	const phone = device({ path: "/org/bluez/hci0/dev_B", name: "Pixel 8 Pro" });
	const speaker = device({
		path: "/org/bluez/hci0/dev_C",
		name: "JBL Flip 6",
		deviceClass: "unknown",
	});

	it("puts paired devices first without reordering either partition", () => {
		const ordered = orderedBluetoothDevices(
			status({ devices: [phone, mic, speaker] }),
		);
		expect(ordered.map((d) => d.path)).toEqual([
			mic.path,
			phone.path,
			speaker.path,
		]);
	});

	it("does not move a bonded row as a scan folds new devices in", () => {
		// A scan delivers one advertisement per tick. Re-ranking the whole list
		// on each tick would move the row an operator is reaching for.
		const first = orderedBluetoothDevices(status({ devices: [mic, phone] }));
		const second = orderedBluetoothDevices(
			status({ devices: [mic, phone, speaker] }),
		);
		expect(second.slice(0, 2).map((d) => d.path)).toEqual(
			first.map((d) => d.path),
		);
	});

	it("answers empty before any snapshot", () => {
		expect(orderedBluetoothDevices(undefined)).toEqual([]);
	});
});

describe("bluetoothDeviceActions", () => {
	it("offers only Pair for an unbonded device", () => {
		expect(bluetoothDeviceActions(device())).toEqual(["pair"]);
	});

	it("offers connect/trust/forget for a bonded, idle device", () => {
		expect(bluetoothDeviceActions(device({ paired: true }))).toEqual([
			"connect",
			"trust",
			"forget",
		]);
	});

	it("flips to disconnect/untrust for a connected, trusted device", () => {
		expect(
			bluetoothDeviceActions(
				device({ paired: true, trusted: true, connected: true }),
			),
		).toEqual(["disconnect", "untrust", "forget"]);
	});
});

describe("showsAudioSourceHint — CONNECTED, not merely paired", () => {
	it("points at the Live source list for a connected microphone", () => {
		expect(
			showsAudioSourceHint(
				device({ paired: true, connected: true, deviceClass: "audio-input" }),
			),
		).toBe(true);
	});

	it("stays silent for a bonded microphone that is not connected", () => {
		// A bonded-but-disconnected mic has no PCM behind it, so naming it as an
		// available source is a claim the device cannot honour.
		expect(showsAudioSourceHint(device({ paired: true }))).toBe(false);
	});

	it("stays silent for a connected device that is not an audio input", () => {
		expect(
			showsAudioSourceHint(
				device({ paired: true, connected: true, deviceClass: "unknown" }),
			),
		).toBe(false);
	});
});

describe("showsPairingAgentGap", () => {
	const noAgent = {
		registered: false,
		isDefaultAgent: false,
		reason: "exporter_unavailable",
	} as const;

	it("states the gap while an unpaired device is on screen", () => {
		expect(
			showsPairingAgentGap(status({ agent: noAgent, devices: [device()] })),
		).toBe(true);
	});

	it("says nothing when every device is already bonded", () => {
		expect(
			showsPairingAgentGap(
				status({ agent: noAgent, devices: [device({ paired: true })] }),
			),
		).toBe(false);
	});

	it("says nothing when an agent is registered", () => {
		expect(showsPairingAgentGap(status({ devices: [device()] }))).toBe(false);
	});

	it("says nothing on a surface that is not observing BlueZ", () => {
		expect(
			showsPairingAgentGap(
				unavailable("no_adapter", { agent: noAgent, devices: [device()] }),
			),
		).toBe(false);
	});
});

describe("primaryBluetoothAdapter", () => {
	it("answers the first controller, or nothing at all", () => {
		expect(primaryBluetoothAdapter(status())?.path).toBe(ADAPTER_PATH);
		expect(primaryBluetoothAdapter(status({ adapters: [] }))).toBeUndefined();
		expect(primaryBluetoothAdapter(undefined)).toBeUndefined();
	});
});
