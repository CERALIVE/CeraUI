// @vitest-environment jsdom
/**
 * BluetoothSection — the Network destination's Bluetooth card.
 *
 * The two properties worth a rendered-DOM test, because neither can be seen
 * from the pure module:
 *
 *  1. THE MASTER TOGGLE IS PESSIMISTIC. `osCommand` runs WITHOUT
 *     `confirmOnResolve`, so a successful RPC leaves the switch exactly where
 *     it was and only the confirming `bluetooth` broadcast moves it. A test
 *     that asserted on the pure derivation would pass on an optimistic
 *     component, which is why the position is asserted here across the RPC
 *     resolve AND across the broadcast that follows it.
 *  2. EVERY TYPED REFUSAL RENDERS INLINE, next to the control that was refused,
 *     and NEVER as a toast. The kiosk touchscreen cannot hover, and the shared
 *     enum's thirteen members each name a different operator action.
 *
 * The device fixture is todo 14's `bt-mic-paired` roster shape: one Jabra Talk
 * 65 at `audio-input` + `scoCapable`, paired, trusted, connected, battery 80.
 */
import { m } from "@ceraui/i18n/svelte";
import type {
	BluetoothAdapter,
	BluetoothDevice,
	BluetoothMutationRefusal,
	BluetoothStatus,
} from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import {
	destroyAsyncOperations,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import BluetoothSection from "./BluetoothSection.svelte";

const enable = vi.hoisted(() => vi.fn());
const disable = vi.hoisted(() => vi.fn());
const scanStart = vi.hoisted(() => vi.fn());
const scanStop = vi.hoisted(() => vi.fn());
const pair = vi.hoisted(() => vi.fn());
const trust = vi.hoisted(() => vi.fn());
const forget = vi.hoisted(() => vi.fn());
const connect = vi.hoisted(() => vi.fn());
const disconnect = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		bluetooth: {
			enable,
			disable,
			scanStart,
			scanStop,
			pair,
			trust,
			forget,
			connect,
			disconnect,
		},
	},
}));

vi.mock("svelte-sonner", () => ({
	toast: { error: toastError, success: vi.fn() },
}));

const ADAPTER_PATH = "/org/bluez/hci0";
const MIC_PATH = `${ADAPTER_PATH}/dev_AA_BB_CC_DD_EE_11`;
const PHONE_PATH = `${ADAPTER_PATH}/dev_AA_BB_CC_DD_EE_22`;

function adapter(overrides: Partial<BluetoothAdapter> = {}): BluetoothAdapter {
	return {
		path: ADAPTER_PATH,
		address: "AA:BB:CC:00:00:00",
		name: "ceralive-dev",
		powered: true,
		discovering: false,
		discoverable: false,
		pairable: true,
		...overrides,
	};
}

/** The bonded Jabra of `bt-mic-paired`: audio-input, SCO-capable, battery 80. */
function pairedMic(overrides: Partial<BluetoothDevice> = {}): BluetoothDevice {
	return {
		path: MIC_PATH,
		adapterPath: ADAPTER_PATH,
		address: "AA:BB:CC:DD:EE:11",
		name: "Jabra Talk 65",
		deviceClass: "audio-input",
		transport: "bredr",
		paired: true,
		trusted: true,
		connected: true,
		blocked: false,
		scoCapable: true,
		battery: 80,
		...overrides,
	};
}

/** An advertisement a scan has just folded in: named, unbonded, no battery. */
function discoveredPhone(
	overrides: Partial<BluetoothDevice> = {},
): BluetoothDevice {
	return {
		path: PHONE_PATH,
		adapterPath: ADAPTER_PATH,
		address: "AA:BB:CC:DD:EE:22",
		name: "Pixel 8 Pro",
		deviceClass: "audio-input",
		transport: "bredr",
		paired: false,
		trusted: false,
		connected: false,
		blocked: false,
		scoCapable: false,
		rssi: -63,
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function refused(error: BluetoothMutationRefusal) {
	return { success: false, error };
}

const toggle = () =>
	screen.getByTestId("bluetooth-enable") as HTMLButtonElement;

beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
	const proto = window.Element.prototype as unknown as Record<string, unknown>;
	proto.hasPointerCapture ??= vi.fn(() => false);
	proto.setPointerCapture ??= vi.fn();
	proto.releasePointerCapture ??= vi.fn();
	proto.scrollIntoView ??= vi.fn();
});

beforeEach(() => {
	vi.clearAllMocks();
	initAsyncOperations();
});

afterEach(() => {
	destroyAsyncOperations();
});

describe("BluetoothSection — empty state", () => {
	it("renders the adapter state and the nothing-found copy with Bluetooth on", () => {
		render(BluetoothSection, { props: { status: status() } });

		const adapterLine = screen.getByTestId("bluetooth-adapter");
		expect(adapterLine.dataset.powered).toBe("true");
		expect(adapterLine.dataset.discovering).toBe("false");
		expect(adapterLine.textContent).toContain(
			m["network.bluetooth.adapterReady"](),
		);

		expect(screen.getByTestId("bluetooth-empty").textContent).toContain(
			m["network.bluetooth.noDevices"](),
		);
		expect(screen.queryByTestId("bluetooth-devices")).toBeNull();
		expect(toggle().getAttribute("aria-checked")).toBe("true");
	});

	it("renders the OFF state — never a service fault — when the operator switched it off", () => {
		// The stack records an operator-disabled device as
		// `bt_unavailable{bluez_unavailable}`; banding that cause would blame a
		// healthy service for a setting the operator can see they changed.
		render(BluetoothSection, {
			props: {
				status: status({
					enabled: false,
					available: false,
					unavailable: { cause: "bluez_unavailable" },
					adapters: [],
				}),
			},
		});

		expect(screen.getByTestId("bluetooth-off")).toBeTruthy();
		expect(screen.queryByTestId("bluetooth-unavailable")).toBeNull();
		expect(screen.queryByTestId("bluetooth-scan")).toBeNull();
		expect(toggle().getAttribute("aria-checked")).toBe("false");
	});

	it("bands the honest `bt_unavailable` reason in emulated mode", () => {
		render(BluetoothSection, {
			props: {
				status: status({
					enabled: false,
					available: false,
					unavailable: { cause: "emulated", detail: "no radio on this host" },
					adapters: [],
				}),
			},
		});

		const band = screen.getByTestId("bluetooth-unavailable");
		expect(band.dataset.cause).toBe("emulated");
		expect(band.textContent?.trim()).toBe(
			m["network.bluetooth.unavailable.emulated"](),
		);
		// The wire's `detail` is a diagnostic for the log, never operator copy.
		expect(band.textContent).not.toContain("no radio on this host");
	});
});

describe("BluetoothSection — scanning state", () => {
	it("dispatches scanStart against the adapter path and shows live results", async () => {
		scanStart.mockResolvedValue({ success: true });
		const { rerender } = render(BluetoothSection, {
			props: { status: status() },
		});

		await fireEvent.click(screen.getByTestId("bluetooth-scan"));
		await waitFor(() =>
			expect(scanStart).toHaveBeenCalledWith({ adapterPath: ADAPTER_PATH }),
		);

		// The discovery window opens on the broadcast, not on the RPC answer.
		await rerender({
			status: status({ adapters: [adapter({ discovering: true })] }),
		});
		expect(screen.getByTestId("bluetooth-adapter").dataset.discovering).toBe(
			"true",
		);
		expect(screen.getByTestId("bluetooth-scan").textContent).toContain(
			m["network.bluetooth.scanStop"](),
		);
		expect(screen.getByTestId("bluetooth-empty").textContent).toContain(
			m["network.bluetooth.scanning"](),
		);

		// One advertisement per tick, exactly as the stack folds them in.
		await rerender({
			status: status({
				adapters: [adapter({ discovering: true })],
				devices: [discoveredPhone()],
			}),
		});
		expect(screen.getAllByTestId("bluetooth-device")).toHaveLength(1);
		expect(screen.getByTestId("bluetooth-device-name").textContent).toContain(
			"Pixel 8 Pro",
		);
		expect(screen.queryByTestId("bluetooth-empty")).toBeNull();
	});

	it("offers only Pair for an unbonded row, and stops the scan on the second tap", async () => {
		scanStop.mockResolvedValue({ success: true });
		render(BluetoothSection, {
			props: {
				status: status({
					adapters: [adapter({ discovering: true })],
					devices: [discoveredPhone()],
				}),
			},
		});

		expect(screen.getByTestId("bluetooth-action-pair")).toBeTruthy();
		expect(screen.queryByTestId("bluetooth-action-forget")).toBeNull();
		expect(screen.queryByTestId("bluetooth-action-trust")).toBeNull();

		await fireEvent.click(screen.getByTestId("bluetooth-scan"));
		await waitFor(() =>
			expect(scanStop).toHaveBeenCalledWith({ adapterPath: ADAPTER_PATH }),
		);
	});
});

describe("BluetoothSection — the bt-mic-paired steady state", () => {
	it("renders the chips, the battery, and the bonded action set", () => {
		render(BluetoothSection, {
			props: { status: status({ devices: [pairedMic()] }) },
		});

		expect(screen.getByTestId("bluetooth-device-name").textContent).toContain(
			"Jabra Talk 65",
		);
		expect(
			screen.getByTestId("bluetooth-device-icon-audio-input"),
		).toBeTruthy();
		expect(screen.getByTestId("bluetooth-chip-paired")).toBeTruthy();
		expect(screen.getByTestId("bluetooth-chip-trusted")).toBeTruthy();
		expect(screen.getByTestId("bluetooth-chip-connected")).toBeTruthy();
		expect(screen.getByTestId("bluetooth-chip-battery").textContent).toContain(
			"80",
		);

		expect(screen.getByTestId("bluetooth-action-disconnect")).toBeTruthy();
		expect(screen.getByTestId("bluetooth-action-untrust")).toBeTruthy();
		expect(screen.getByTestId("bluetooth-action-forget")).toBeTruthy();
		expect(screen.queryByTestId("bluetooth-action-pair")).toBeNull();
	});

	it("points a CONNECTED microphone at the Live source list", () => {
		render(BluetoothSection, {
			props: { status: status({ devices: [pairedMic()] }) },
		});
		expect(screen.getByTestId("bluetooth-audio-source-hint")).toBeTruthy();
		expect(screen.getByTestId("bluetooth-audio-source-link")).toBeTruthy();
	});

	it("withholds the hint while that microphone is disconnected", () => {
		// A bonded-but-disconnected mic has no PCM behind it — naming it as an
		// available audio source would be a claim the device cannot honour.
		render(BluetoothSection, {
			props: {
				status: status({
					devices: [pairedMic({ connected: false, battery: undefined })],
				}),
			},
		});
		expect(screen.queryByTestId("bluetooth-audio-source-hint")).toBeNull();
		// BlueZ retracts `Battery1` on disconnect; a remembered 80 % would assert
		// a level nothing measured.
		expect(screen.queryByTestId("bluetooth-chip-battery")).toBeNull();
		expect(screen.getByTestId("bluetooth-action-connect")).toBeTruthy();
	});

	it("dispatches the exact per-device verb the row offered", async () => {
		disconnect.mockResolvedValue({ success: true });
		render(BluetoothSection, {
			props: { status: status({ devices: [pairedMic()] }) },
		});

		await fireEvent.click(screen.getByTestId("bluetooth-action-disconnect"));
		await waitFor(() =>
			expect(disconnect).toHaveBeenCalledWith({ devicePath: MIC_PATH }),
		);
		expect(connect).not.toHaveBeenCalled();
	});

	it("revokes trust through the one flag setter, never a second verb", async () => {
		trust.mockResolvedValue({ success: true });
		render(BluetoothSection, {
			props: { status: status({ devices: [pairedMic()] }) },
		});

		await fireEvent.click(screen.getByTestId("bluetooth-action-untrust"));
		await waitFor(() =>
			expect(trust).toHaveBeenCalledWith({
				devicePath: MIC_PATH,
				trusted: false,
			}),
		);
	});
});

describe("BluetoothSection — the master toggle is PESSIMISTIC", () => {
	it("does NOT move on the RPC resolve, and moves on the confirming broadcast", async () => {
		const pending = deferred<{ success: boolean }>();
		disable.mockReturnValueOnce(pending.promise);
		const { rerender } = render(BluetoothSection, {
			props: { status: status() },
		});

		expect(toggle().getAttribute("aria-checked")).toBe("true");
		await fireEvent.click(toggle());
		await Promise.resolve();
		expect(disable).toHaveBeenCalledOnce();

		// In flight: the spinner is the SOLE optimistic element.
		await waitFor(() => expect(toggle().disabled).toBe(true));
		expect(screen.getByTestId("bluetooth-enable-pending")).toBeTruthy();
		expect(toggle().getAttribute("aria-checked")).toBe("true");

		// A re-entrant tap while pending must not dispatch a second write.
		await fireEvent.click(toggle());
		await Promise.resolve();
		expect(disable).toHaveBeenCalledOnce();

		// RPC success alone still does not move the switch.
		pending.resolve({ success: true });
		await waitFor(() => expect(disable).toHaveBeenCalledOnce());
		expect(toggle().getAttribute("aria-checked")).toBe("true");

		// Only the authoritative broadcast does.
		await rerender({
			status: status({ enabled: false, available: false, adapters: [] }),
		});
		await waitFor(() =>
			expect(toggle().getAttribute("aria-checked")).toBe("false"),
		);
		expect(screen.queryByTestId("bluetooth-enable-pending")).toBeNull();
	});

	it("dispatches enable when the operator turns a disabled radio on", async () => {
		enable.mockResolvedValue({ success: true, applied: { enabled: true } });
		render(BluetoothSection, {
			props: {
				status: status({ enabled: false, available: false, adapters: [] }),
			},
		});

		await fireEvent.click(toggle());
		await waitFor(() => expect(enable).toHaveBeenCalledWith({}));
		expect(disable).not.toHaveBeenCalled();
	});
});

describe("BluetoothSection — typed refusals render INLINE, never as a toast", () => {
	it("renders the pairing-agent refusal on the row that was refused", async () => {
		// The build ships no `org.bluez.Agent1` exporter, so this is the refusal a
		// real board answers today. It must read as "start it from the other
		// device", not as a generic failure.
		pair.mockResolvedValue(refused("pairing_agent_unavailable"));
		render(BluetoothSection, {
			props: { status: status({ devices: [discoveredPhone()] }) },
		});

		await fireEvent.click(screen.getByTestId("bluetooth-action-pair"));

		const band = await screen.findByTestId("bluetooth-device-refused");
		expect(band.textContent?.trim()).toBe(
			m["network.bluetooth.refusal.pairingAgentUnavailable"](),
		);
		expect(band.getAttribute("role")).toBe("status");
		expect(toastError).not.toHaveBeenCalled();
		// A machine token never reaches the operator.
		expect(band.textContent).not.toContain("pairing_agent_unavailable");
	});

	it("names the busy radio distinctly from a failed pairing", async () => {
		pair.mockResolvedValue(refused("adapter_busy"));
		render(BluetoothSection, {
			props: { status: status({ devices: [discoveredPhone()] }) },
		});

		await fireEvent.click(screen.getByTestId("bluetooth-action-pair"));
		const band = await screen.findByTestId("bluetooth-device-refused");
		expect(band.textContent?.trim()).toBe(
			m["network.bluetooth.refusal.adapterBusy"](),
		);
		expect(band.textContent?.trim()).not.toBe(
			m["network.bluetooth.refusal.pairingFailed"](),
		);
	});

	it("scopes a refusal to its own row", async () => {
		pair.mockResolvedValue(refused("unknown_device"));
		render(BluetoothSection, {
			props: {
				status: status({ devices: [pairedMic(), discoveredPhone()] }),
			},
		});

		await fireEvent.click(screen.getByTestId("bluetooth-action-pair"));
		await screen.findByTestId("bluetooth-device-refused");
		expect(screen.getAllByTestId("bluetooth-device-refused")).toHaveLength(1);
	});

	it("renders a refused enable beside the toggle and leaves it where it was", async () => {
		enable.mockResolvedValue(refused("bt_unavailable_in_emulated_mode"));
		render(BluetoothSection, {
			props: {
				status: status({
					enabled: false,
					available: false,
					unavailable: { cause: "emulated" },
					adapters: [],
				}),
			},
		});

		await fireEvent.click(toggle());

		const band = await screen.findByTestId("bluetooth-enable-refused");
		expect(band.textContent?.trim()).toBe(
			m["network.bluetooth.refusal.emulated"](),
		);
		expect(toastError).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(toggle().getAttribute("aria-checked")).toBe("false"),
		);
		// Re-entry released: the operator can try again.
		await waitFor(() => expect(toggle().disabled).toBe(false));
	});

	it("renders a refused scan under the header", async () => {
		scanStart.mockResolvedValue(refused("adapter_busy"));
		render(BluetoothSection, { props: { status: status() } });

		await fireEvent.click(screen.getByTestId("bluetooth-scan"));
		const band = await screen.findByTestId("bluetooth-scan-refused");
		expect(band.textContent?.trim()).toBe(
			m["network.bluetooth.refusal.adapterBusy"](),
		);
		expect(toastError).not.toHaveBeenCalled();
	});

	it("keeps the toast for a TRANSPORT fault, which carries no typed reason", async () => {
		pair.mockRejectedValue(new Error("socket closed"));
		render(BluetoothSection, {
			props: { status: status({ devices: [discoveredPhone()] }) },
		});

		await fireEvent.click(screen.getByTestId("bluetooth-action-pair"));
		await waitFor(() => expect(toastError).toHaveBeenCalled());
		expect(screen.queryByTestId("bluetooth-device-refused")).toBeNull();
	});
});

describe("BluetoothSection — the pairing-agent gap is stated before the operator taps", () => {
	const noAgent = {
		registered: false,
		isDefaultAgent: false,
		reason: "exporter_unavailable",
	} as const;

	it("shows the gap while an unbonded device is on screen", () => {
		render(BluetoothSection, {
			props: {
				status: status({ agent: noAgent, devices: [discoveredPhone()] }),
			},
		});
		expect(screen.getByTestId("bluetooth-agent-gap")).toBeTruthy();
	});

	it("says nothing once every device is bonded", () => {
		render(BluetoothSection, {
			props: { status: status({ agent: noAgent, devices: [pairedMic()] }) },
		});
		expect(screen.queryByTestId("bluetooth-agent-gap")).toBeNull();
	});
});
