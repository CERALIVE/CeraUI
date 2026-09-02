/**
 * Bluetooth surface derivations — pure, rune-free, and the ONLY place a wire
 * token becomes an i18n key.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * "THE OPERATOR SWITCHED IT OFF" OUTRANKS THE STACK'S OWN CAUSE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `BluetoothStack` records an operator-disabled device as
 * `{available: false, unavailable: {cause: 'bluez_unavailable'}}` — correct from
 * its own point of view (it is not observing BlueZ) and the opposite fact to an
 * operator, for whom a switch they can flip and a dead service are different
 * problems. `bluetoothSurface` therefore applies the SAME gate order
 * `bluetooth.procedure.ts` applies to a mutation, with the mock provider's one
 * documented divergence: `emulated` is answered FIRST, because telling someone
 * to switch Bluetooth on when the host has no radio is advice they cannot act on.
 */
import type {
	AudioBackend,
	BluetoothAdapter,
	BluetoothDevice,
	BluetoothDeviceClass,
	BluetoothMutationRefusal,
	BluetoothStatus,
	BluetoothUnavailableCause,
} from "@ceraui/rpc/schemas";

/** What the whole card is currently reporting. */
export type BluetoothSurface =
	| { readonly kind: "unavailable"; readonly reasonKey: string }
	| { readonly kind: "off" }
	| { readonly kind: "ready" };

/** The per-device controls a row offers, in render order. */
export type BluetoothAction =
	| "pair"
	| "connect"
	| "disconnect"
	| "trust"
	| "untrust"
	| "forget";

const UNAVAILABLE_KEYS: Record<BluetoothUnavailableCause, string> = {
	emulated: "network.bluetooth.unavailable.emulated",
	bluez_unavailable: "network.bluetooth.unavailable.bluezUnavailable",
	bus_unreachable: "network.bluetooth.unavailable.busUnreachable",
	no_adapter: "network.bluetooth.unavailable.noAdapter",
	unit_missing: "network.bluetooth.unavailable.unitMissing",
};

/**
 * Every member of the shared refusal enum, keyed.
 *
 * TOTAL by type, so a fifteenth refusal fails the build here rather than
 * reaching an operator as its own dotted path — the same reason the device's
 * `refusalFromUnavailable` is a `switch` over the closed cause union.
 */
const REFUSAL_KEYS: Record<BluetoothMutationRefusal, string> = {
	bt_unavailable_in_emulated_mode: "network.bluetooth.refusal.emulated",
	bluetooth_disabled: "network.bluetooth.refusal.disabled",
	bluez_unavailable: "network.bluetooth.refusal.bluezUnavailable",
	bus_unreachable: "network.bluetooth.refusal.busUnreachable",
	no_adapter: "network.bluetooth.refusal.noAdapter",
	unit_missing: "network.bluetooth.refusal.unitMissing",
	service_start_failed: "network.bluetooth.refusal.serviceStartFailed",
	adapter_busy: "network.bluetooth.refusal.adapterBusy",
	pairing_failed: "network.bluetooth.refusal.pairingFailed",
	pairing_agent_unavailable:
		"network.bluetooth.refusal.pairingAgentUnavailable",
	unknown_device: "network.bluetooth.refusal.unknownDevice",
	unknown_adapter: "network.bluetooth.refusal.unknownAdapter",
	not_connected: "network.bluetooth.refusal.notConnected",
	bluez_error: "network.bluetooth.refusal.bluezError",
};

const DEVICE_CLASS_KEYS: Record<BluetoothDeviceClass, string> = {
	"audio-input": "network.bluetooth.classAudioInput",
	unknown: "network.bluetooth.classUnknown",
};

/** Keyed copy for one refusal. A token this build does not know stays generic. */
export function bluetoothRefusalKey(
	refusal: BluetoothMutationRefusal | string | undefined,
): string {
	if (refusal === undefined) return "network.bluetooth.refusal.generic";
	return (
		REFUSAL_KEYS[refusal as BluetoothMutationRefusal] ??
		"network.bluetooth.refusal.generic"
	);
}

export function bluetoothSurface(
	status: BluetoothStatus | undefined,
): BluetoothSurface {
	if (status === undefined) return { kind: "off" };

	const cause = status.unavailable?.cause;
	if (!status.available && cause === "emulated") {
		return { kind: "unavailable", reasonKey: UNAVAILABLE_KEYS.emulated };
	}
	if (!status.enabled) return { kind: "off" };
	if (status.available) return { kind: "ready" };

	return {
		kind: "unavailable",
		reasonKey:
			cause === undefined
				? "network.bluetooth.unavailable.generic"
				: (UNAVAILABLE_KEYS[cause] ?? "network.bluetooth.unavailable.generic"),
	};
}

/**
 * The controller a scan runs on.
 *
 * The scan input REQUIRES an adapter path (a board can carry two radios and
 * picking one for the operator would start a scan on a radio they can see is
 * not the one they chose), so a surface with no adapter offers no scan at all
 * rather than a disabled one — there is no capability being withheld.
 */
export function primaryBluetoothAdapter(
	status: BluetoothStatus | undefined,
): BluetoothAdapter | undefined {
	return status?.adapters[0];
}

export function adapterStateKey(adapter: BluetoothAdapter): string {
	if (!adapter.powered) return "network.bluetooth.adapterOff";
	return adapter.discovering
		? "network.bluetooth.adapterScanning"
		: "network.bluetooth.adapterReady";
}

/**
 * Bonded devices first, then the discovery order the wire delivered.
 *
 * A stable partition rather than a sort: a scan folds one advertisement in per
 * tick, and re-ranking the whole list on every tick would move the row an
 * operator is reaching for. Bonded rows are pinned so they never travel.
 */
export function orderedBluetoothDevices(
	status: BluetoothStatus | undefined,
): readonly BluetoothDevice[] {
	const devices = status?.devices ?? [];
	return [
		...devices.filter((device) => device.paired),
		...devices.filter((device) => !device.paired),
	];
}

export function deviceClassKey(device: BluetoothDevice): string {
	return DEVICE_CLASS_KEYS[device.deviceClass];
}

/**
 * The row's controls.
 *
 * Trust and Forget are offered only for a BONDED device: BlueZ lets the flag be
 * set on an unpaired one, but it buys nothing until the bond exists (boot
 * reconnect is `trusted && paired`), so offering it there is a control with no
 * outcome — and Pair is the action that row is actually for.
 */
export function bluetoothDeviceActions(
	device: BluetoothDevice,
): readonly BluetoothAction[] {
	if (!device.paired) return ["pair"];
	return [
		device.connected ? "disconnect" : "connect",
		device.trusted ? "untrust" : "trust",
		"forget",
	];
}

/**
 * Whether the row points at the Live source list.
 *
 * Gated on CONNECTED, not merely paired: a bonded microphone that is not
 * connected has no PCM behind it, so naming it as an available audio source
 * would be a claim the device cannot honour.
 */
export function showsAudioSourceHint(
	device: BluetoothDevice,
	audioBackend?: AudioBackend,
): boolean {
	return (
		device.deviceClass === "audio-input" &&
		device.connected &&
		audioBackend !== "alsa"
	);
}

export function showsBluetoothMicBackendRefusal(
	device: BluetoothDevice,
	audioBackend?: AudioBackend,
): boolean {
	return (
		device.deviceClass === "audio-input" &&
		device.connected &&
		audioBackend === "alsa"
	);
}

/**
 * Whether to state the pairing-agent gap BEFORE the operator taps Pair.
 *
 * This build exports no `org.bluez.Agent1` object, so `agent.reason` is
 * `exporter_unavailable` on every real device and a CeraUI-initiated pairing
 * cannot answer BlueZ's callbacks. The wire carries that fact precisely so a
 * surface can say so up front; the pairing is still OFFERED, because a peer
 * needing no authorization can complete one. Shown only while an unpaired
 * device is on screen — otherwise it is a warning about nothing.
 */
export function showsPairingAgentGap(
	status: BluetoothStatus | undefined,
): boolean {
	if (status === undefined || !status.available) return false;
	if (status.agent.registered) return false;
	return status.devices.some((device) => !device.paired);
}
