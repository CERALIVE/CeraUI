import type { Page, WebSocketRoute } from "@playwright/test";

/**
 * A page-WS stand-in for the device's `bluetooth` broadcast.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHAT IT IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Todo 14 shipped `apps/backend/src/mocks/providers/bluetooth.ts` — an adapter,
 * a `bt-mic-paired` roster and a pair/trust/connect state machine — but nothing
 * consults it: `bluetooth-runtime.ts` builds its payload straight from the real
 * `BluetoothStack`, so a worker booted on `bt-mic-paired` still broadcasts the
 * dev host's honest `{enabled:false}`. Wiring that seam is a change to todo 12's
 * module and todo 13's procedures, both out of this todo's scope.
 *
 * So this is the same drop-and-inject shape `modem-ux.visual.spec.ts` already
 * uses: the backend's own `bluetooth` frames are dropped and an authoritative
 * payload is pushed instead, with the mutating RPCs answered client-side from a
 * reducer that mirrors the mock provider's rules (a disconnect retracts
 * `Battery1`; a reconnect restores the seeded level). It proves the FRONTEND
 * half end to end in a real browser — it does NOT prove the device half, and
 * the day the seam is wired this whole file is deleted rather than adapted.
 *
 * The frame shape is exactly `buildMessage(type, data)`'s: one key, no `seq`,
 * so the drop-stale guard is bypassed the same way a pulled snapshot is.
 */

export interface WireDevice {
	path: string;
	adapterPath: string;
	address: string;
	name?: string;
	deviceClass: "audio-input" | "unknown";
	transport: "bredr" | "le" | "dual" | "unknown";
	paired: boolean;
	trusted: boolean;
	connected: boolean;
	blocked: boolean;
	scoCapable: boolean;
	battery?: number;
	rssi?: number;
}

export interface WireStatus {
	available: boolean;
	enabled: boolean;
	unavailable?: { cause: string; detail?: string };
	adapters: {
		path: string;
		address?: string;
		name?: string;
		powered: boolean;
		discovering: boolean;
		discoverable: boolean;
		pairable: boolean;
	}[];
	devices: WireDevice[];
	agent: { registered: boolean; isDefaultAgent: boolean; reason?: string };
	bootReconnectDone: boolean;
	capabilities: Record<string, string>;
}

export const BT_ADAPTER_PATH = "/org/bluez/hci0";
export const BT_MIC_PATH = `${BT_ADAPTER_PATH}/dev_AA_BB_CC_DD_EE_11`;
/** The battery level the seeded mic reports WHILE CONNECTED. */
export const BT_MIC_BATTERY = 80;

/** `bt-mic-paired`: one HFP mic, bonded, trusted, connected, battery 80. */
export function btMicPairedStatus(): WireStatus {
	return {
		available: true,
		enabled: true,
		adapters: [
			{
				path: BT_ADAPTER_PATH,
				address: "AA:BB:CC:00:00:00",
				name: "ceralive-dev",
				powered: true,
				discovering: false,
				discoverable: false,
				pairable: true,
			},
		],
		devices: [
			{
				path: BT_MIC_PATH,
				adapterPath: BT_ADAPTER_PATH,
				address: "AA:BB:CC:DD:EE:11",
				name: "Jabra Talk 65",
				deviceClass: "audio-input",
				transport: "bredr",
				paired: true,
				trusted: true,
				connected: true,
				blocked: false,
				scoCapable: true,
				battery: BT_MIC_BATTERY,
			},
		],
		agent: { registered: true, isDefaultAgent: true },
		bootReconnectDone: true,
		capabilities: {
			adapter: "capable",
			pairing: "capable",
			"audio-input": "capable",
			battery: "capable",
		},
	};
}

/** The operator-off shape the stack really publishes: cause `bluez_unavailable`. */
function switchedOff(from: WireStatus): WireStatus {
	return {
		...from,
		enabled: false,
		available: false,
		unavailable: {
			cause: "bluez_unavailable",
			detail: "the operator has Bluetooth switched off",
		},
		adapters: [],
		devices: [],
	};
}

type Reply = { success: boolean; error?: string };

export interface BluetoothWire {
	/** Push the current payload to the page. */
	publish(): Promise<void>;
	/** Replace the payload and push it. */
	set(next: WireStatus): Promise<void>;
	/** Arm the next mutating RPC to answer with a typed refusal. */
	refuseNext(error: string): void;
	current(): WireStatus;
}

/**
 * Install the proxy. Must run BEFORE `page.goto`, like every other WS harness
 * in this suite — a route installed after boot misses the initial-state push.
 */
export async function installBluetoothWire(
	page: Page,
	initial: WireStatus = btMicPairedStatus(),
): Promise<BluetoothWire> {
	let state: WireStatus = structuredClone(initial);
	let refusal: string | null = null;
	let route: WebSocketRoute | null = null;

	const frame = (): string => JSON.stringify({ bluetooth: state });

	const apply = (rpc: string): Reply => {
		if (refusal !== null) {
			const error = refusal;
			refusal = null;
			return { success: false, error };
		}
		switch (rpc) {
			case "bluetooth.enable":
				state = btMicPairedStatus();
				return { success: true };
			case "bluetooth.disable":
				state = switchedOff(state);
				return { success: true };
			case "bluetooth.connect":
				state = withDevice(state, (d) => ({
					...d,
					connected: true,
					rssi: undefined,
					battery: BT_MIC_BATTERY,
				}));
				return { success: true };
			case "bluetooth.disconnect":
				// BlueZ retracts the whole `Battery1` interface on disconnect, so a
				// retained level would assert a reading nothing measured.
				state = withDevice(state, (d) => ({
					...d,
					connected: false,
					battery: undefined,
				}));
				return { success: true };
			case "bluetooth.trust":
				state = withDevice(state, (d) => ({ ...d, trusted: !d.trusted }));
				return { success: true };
			case "bluetooth.scanStart":
				state = withAdapter(state, true);
				return { success: true };
			case "bluetooth.scanStop":
				state = withAdapter(state, false);
				return { success: true };
			default:
				return { success: true };
		}
	};

	await page.routeWebSocket(/:(3002|31\d\d|6173|8090|8091)\//, (ws) => {
		route = ws;
		const server = ws.connectToServer();

		ws.onMessage((message) => {
			const text = typeof message === "string" ? message : message.toString();
			try {
				const parsed = JSON.parse(text) as { id?: unknown; path?: unknown };
				const rpc = Array.isArray(parsed.path) ? parsed.path.join(".") : null;
				if (rpc?.startsWith("bluetooth.") === true && parsed.id !== undefined) {
					const result = apply(rpc);
					ws.send(JSON.stringify({ id: parsed.id, result }));
					ws.send(frame());
					return;
				}
			} catch {
				/* non-RPC frame */
			}
			server.send(message);
		});

		server.onMessage((message) => {
			const text = typeof message === "string" ? message : message.toString();
			try {
				if ("bluetooth" in (JSON.parse(text) as object)) return;
			} catch {
				/* non-JSON / binary frame */
			}
			ws.send(message);
		});
	});

	return {
		publish() {
			route?.send(frame());
			return Promise.resolve();
		},
		set(next) {
			state = structuredClone(next);
			route?.send(frame());
			return Promise.resolve();
		},
		refuseNext(error) {
			refusal = error;
		},
		current: () => state,
	};
}

function withDevice(
	status: WireStatus,
	map: (device: WireDevice) => WireDevice,
): WireStatus {
	return { ...status, devices: status.devices.map(map) };
}

function withAdapter(status: WireStatus, discovering: boolean): WireStatus {
	return {
		...status,
		adapters: status.adapters.map((a) => ({ ...a, discovering })),
	};
}
