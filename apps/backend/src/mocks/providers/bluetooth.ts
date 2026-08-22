/*
	CeraUI - Bluetooth Mock Provider

	Dev/e2e parity for the BlueZ path WITHOUT a controller: an adapter, a
	discoverable roster, a pair/trust state machine and a timed scan window, all
	in memory. Nothing here spawns, dials a bus, or touches `systemctl` — it is a
	PARALLEL layer, never imported by `modules/bluetooth/`.

	─────────────────────────────────────────────────────────────────────────────
	THE FIXTURES DO NOT STATE `deviceClass` / `scoCapable` / `transport`
	─────────────────────────────────────────────────────────────────────────────

	All three are DERIVED, through the production code that derives them on a real
	board: `deriveCapability()` (`modules/bluetooth/bluetooth-classes.ts`) turns a
	seed's advertised UUIDs into the class pair, and `buildBluetoothStatus()`
	(`bluetooth-wire.ts`) projects a registry row onto the wire — transport
	included. A fixture that hand-wrote `scoCapable: true` beside an A2DP-source
	UUID would publish a `PROFILE=sco` source row whose every open fails on
	hardware, which is exactly the defect todo 12's class split exists to prevent;
	deriving it makes that fixture UNEXPRESSIBLE rather than merely discouraged.

	It is also why the interior state is REGISTRY rows (`BluetoothDeviceRow`,
	uuids and all) rather than wire rows: the wire payload is produced by the one
	real projection, so a mock and a board cannot disagree about the shape or the
	claims ladder.

	─────────────────────────────────────────────────────────────────────────────
	WHY THE FIXTURES ARE LITERALS AND NOT `buildMockBtDevice()` CALLS
	─────────────────────────────────────────────────────────────────────────────

	`mock-schemas.ts` validates the shipped fixtures at `initMockService()` time,
	so it imports this module; `fixture-factory.ts` imports `mock-schemas.ts`.
	Building the fixtures through the factory would close that into a cycle — the
	same reason `mock-config.ts`'s modem/wifi fixtures are independent literals of
	the factory's defaults. The two copies are pinned against each other by
	`fixture-factory.test.ts`, so drift in either direction fails loudly.
*/

import type {
	BluetoothAdapter,
	BluetoothDevice,
	BluetoothMutationKind,
	BluetoothMutationRefusal,
	BluetoothStatus,
} from "@ceraui/rpc/schemas";

import { btUnavailable } from "../../modules/bluetooth/bluetooth-availability.ts";
import { deriveCapability } from "../../modules/bluetooth/bluetooth-classes.ts";
import type {
	BluetoothAdapterRow,
	BluetoothDeviceRow,
} from "../../modules/bluetooth/bluetooth-registry.ts";
import type { BluetoothStackState } from "../../modules/bluetooth/bluetooth-stack.ts";
import {
	buildBluetoothStatus,
	projectBluetoothAdapter,
	projectBluetoothDevice,
} from "../../modules/bluetooth/bluetooth-wire.ts";
import { getScenarioConfig, type ScenarioBluetooth } from "../mock-config.ts";

// ─── SIG service UUIDs (fully expanded, as BlueZ publishes them) ─────────────

/** Headset (HSP HS) — a SCO-bearing profile. */
export const UUID_HSP_HS = "00001108-0000-1000-8000-00805f9b34fb";
/** Hands-free (HFP HF) — a SCO-bearing profile. */
export const UUID_HFP_HF = "0000111e-0000-1000-8000-00805f9b34fb";
/** A2DP source — the device streams audio TO the board. NO SCO leg. */
export const UUID_A2DP_SOURCE = "0000110a-0000-1000-8000-00805f9b34fb";
/** A2DP sink — the device RECEIVES audio. Never an input. */
export const UUID_A2DP_SINK = "0000110b-0000-1000-8000-00805f9b34fb";
/** AV remote control — carried by most speakers; contributes nothing to the class. */
export const UUID_AVRCP = "0000110e-0000-1000-8000-00805f9b34fb";

// ─── Object paths + addresses ───────────────────────────────────────────────
//
// Addresses use the same locally-administered `AA:BB:CC:` prefix the WiFi BSSID
// fixtures use, so no mock value can collide with a real vendor OUI. Every
// device path encodes its own address, exactly as BlueZ names them — a fixture
// whose path and address disagree is rejected at init (`mockBtDeviceSchema`).

export const MOCK_BT_ADAPTER_PATH = "/org/bluez/hci0";
export const MOCK_BT_ADAPTER_ADDRESS = "AA:BB:CC:00:00:00";

export const MOCK_BT_MIC_ADDRESS = "AA:BB:CC:DD:EE:11";
export const MOCK_BT_PHONE_ADDRESS = "AA:BB:CC:DD:EE:22";
export const MOCK_BT_SPEAKER_ADDRESS = "AA:BB:CC:DD:EE:33";
export const MOCK_BT_BARE_ADDRESS = "AA:BB:CC:DD:EE:44";

/** The BlueZ device path for an address under {@link MOCK_BT_ADAPTER_PATH}. */
export function mockBtDevicePath(address: string): string {
	return `${MOCK_BT_ADAPTER_PATH}/dev_${address.toUpperCase().replace(/:/g, "_")}`;
}

export const MOCK_BT_MIC_PATH = mockBtDevicePath(MOCK_BT_MIC_ADDRESS);
export const MOCK_BT_PHONE_PATH = mockBtDevicePath(MOCK_BT_PHONE_ADDRESS);
export const MOCK_BT_SPEAKER_PATH = mockBtDevicePath(MOCK_BT_SPEAKER_ADDRESS);
export const MOCK_BT_BARE_PATH = mockBtDevicePath(MOCK_BT_BARE_ADDRESS);

/** The mic's `Battery1.Percentage` while it is CONNECTED. */
export const MOCK_BT_MIC_BATTERY_PERCENT = 80;

// ─── Seeds ──────────────────────────────────────────────────────────────────

/**
 * One discoverable device, before any class derivation.
 *
 * `battery` is the level the device reports WHILE CONNECTED. BlueZ retracts a
 * `Battery1` interface when a headset disconnects (see `bluetooth-registry.ts`),
 * so the mock does too: the seed is the value a (re)connect restores, never a
 * value that stands while the device is away.
 */
interface MockBtSeed {
	readonly address: string;
	/** Absent for a bare advertisement BlueZ has not named yet. */
	readonly name?: string;
	readonly uuids: readonly string[];
	readonly battery?: number;
	/** Advertisement RSSI, present only while the device is being discovered. */
	readonly rssi?: number;
}

/**
 * The discoverable roster, in the order a scan folds it in.
 *
 * Deliberately spans all four class outcomes, because three of them are the
 * cases a hand-written fixture gets wrong:
 *
 *   mic     — HFP + HSP        ⇒ audio-input, scoCapable TRUE
 *   phone   — A2DP source only ⇒ audio-input, scoCapable FALSE (the forcing case)
 *   speaker — A2DP sink only   ⇒ unknown (a speaker is not an input)
 *   bare    — no UUIDs at all  ⇒ unknown (absence of evidence is not evidence)
 */
const MOCK_BT_SEEDS: readonly MockBtSeed[] = [
	{
		address: MOCK_BT_MIC_ADDRESS,
		name: "Jabra Talk 65",
		uuids: [UUID_HSP_HS, UUID_HFP_HF],
		battery: MOCK_BT_MIC_BATTERY_PERCENT,
		rssi: -47,
	},
	{
		address: MOCK_BT_PHONE_ADDRESS,
		name: "Pixel 8 Pro",
		uuids: [UUID_A2DP_SOURCE],
		rssi: -63,
	},
	{
		address: MOCK_BT_SPEAKER_ADDRESS,
		name: "JBL Flip 6",
		uuids: [UUID_A2DP_SINK, UUID_AVRCP],
		rssi: -71,
	},
	{
		address: MOCK_BT_BARE_ADDRESS,
		uuids: [],
		rssi: -88,
	},
];

const SEED_BY_PATH: ReadonlyMap<string, MockBtSeed> = new Map(
	MOCK_BT_SEEDS.map((seed) => [mockBtDevicePath(seed.address), seed]),
);

/** Build a registry row from a seed, DERIVING the class pair from its UUIDs. */
function rowFromSeed(
	seed: MockBtSeed,
	state: {
		paired: boolean;
		trusted: boolean;
		connected: boolean;
		blocked: boolean;
		/** Discovery-only: an RSSI is published while advertising, not once bonded. */
		advertising: boolean;
	},
): BluetoothDeviceRow {
	const path = mockBtDevicePath(seed.address);
	const capability = deriveCapability(seed.uuids);
	return {
		path,
		adapterPath: MOCK_BT_ADAPTER_PATH,
		address: seed.address,
		name: seed.name,
		paired: state.paired,
		trusted: state.trusted,
		connected: state.connected,
		blocked: state.blocked,
		rssi: state.advertising ? seed.rssi : undefined,
		uuids: seed.uuids,
		deviceClass: capability.deviceClass,
		scoCapable: capability.scoCapable,
		// A disconnected device publishes no `Battery1` — see MockBtSeed.
		batteryPercentage: state.connected ? seed.battery : undefined,
		pending: undefined,
	};
}

const MOCK_BT_ADAPTER_ROW: BluetoothAdapterRow = {
	path: MOCK_BT_ADAPTER_PATH,
	address: MOCK_BT_ADAPTER_ADDRESS,
	name: "ceralive-dev",
	powered: true,
	discovering: false,
	discoverable: false,
	pairable: true,
	pending: undefined,
};

/** A freshly-advertised row: known to BlueZ, bonded to nothing. */
function discoveredRow(seed: MockBtSeed): BluetoothDeviceRow {
	return rowFromSeed(seed, {
		paired: false,
		trusted: false,
		connected: false,
		blocked: false,
		advertising: true,
	});
}

/**
 * The bonded mic — paired, trusted, connected, and therefore publishing its
 * battery.
 *
 * ONE builder for both the `bt-mic-paired` seed and the exported fixture, so the
 * scenario an operator sees and the fixture a test asserts against cannot drift.
 */
function pairedMicRow(seed: MockBtSeed): BluetoothDeviceRow {
	return rowFromSeed(seed, {
		paired: true,
		trusted: true,
		connected: true,
		blocked: false,
		// A bonded device is no longer advertising, so BlueZ publishes no RSSI for
		// it — a remembered one would read as a live measurement.
		advertising: false,
	});
}

function micSeed(): MockBtSeed {
	const seed = SEED_BY_PATH.get(MOCK_BT_MIC_PATH);
	if (seed === undefined) throw new Error("the mock BT mic seed is missing");
	return seed;
}

/** The discoverable roster as a scan first sees it — unpaired, advertising. */
export function mockBtDiscoverableFixtures(): BluetoothDevice[] {
	return MOCK_BT_SEEDS.map((seed) =>
		projectBluetoothDevice(discoveredRow(seed)),
	);
}

/**
 * The pairable BT mic once it is bonded: `audio-input`, `scoCapable`, battery
 * 80%. The anchor `buildMockBtDevice()` mirrors, and what `bt-mic-paired` seeds.
 */
export function mockBtPairedMicFixture(): BluetoothDevice {
	return projectBluetoothDevice(pairedMicRow(micSeed()));
}

/**
 * Every shipped BT device fixture, projected onto the wire.
 *
 * The projection is deliberately part of the fixture: `validateMockFixtures()`
 * therefore checks the DATA and the production projection of it in one step, so
 * a projection that stopped producing a schema-valid row fails at init too.
 */
export function mockBtDeviceFixtures(): BluetoothDevice[] {
	return [...mockBtDiscoverableFixtures(), mockBtPairedMicFixture()];
}

/** Every shipped BT adapter fixture, projected onto the wire. */
export function mockBtAdapterFixtures(): BluetoothAdapter[] {
	return [projectBluetoothAdapter(MOCK_BT_ADAPTER_ROW)];
}

// ─── Scan timing ────────────────────────────────────────────────────────────

/** How long the mock waits between two simulated `InterfacesAdded` folds. */
export const MOCK_BT_DISCOVERY_TICK_MS = 700;

/**
 * The bounded window a mock scan runs for.
 *
 * The real stack's window is 30 s (`DISCOVERY_WINDOW_MS`); a dev scan that took
 * that long would be indistinguishable from one that hung, so the mock keeps the
 * BOUND and shortens it. What matters for parity is that the scan stops itself.
 */
export const MOCK_BT_DISCOVERY_WINDOW_MS = 8_000;

export interface MockBtScanTiming {
	readonly tickMs: number;
	readonly windowMs: number;
}

// ─── Mutation results ───────────────────────────────────────────────────────

/**
 * The refusal vocabulary is the SHARED `bluetoothMutationRefusalSchema` one, not
 * a mock-local set — a dev refusal an operator surface renders must be the same
 * string a board would answer with, or the surface is only tested against
 * fiction.
 */
export type MockBtMutationResult =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly error: BluetoothMutationRefusal;
			readonly heldBy?: BluetoothMutationKind;
	  };

const OK: MockBtMutationResult = { ok: true };

function refuse(
	error: BluetoothMutationRefusal,
	heldBy?: BluetoothMutationKind,
): MockBtMutationResult {
	return heldBy === undefined
		? { ok: false, error }
		: { ok: false, error, heldBy };
}

// ─── Session state ──────────────────────────────────────────────────────────

interface MockBtState {
	/** Absent when the active scenario simulates no Bluetooth at all. */
	readonly scenario: ScenarioBluetooth | undefined;
	adapter: BluetoothAdapterRow | undefined;
	devices: Map<string, BluetoothDeviceRow>;
	agentRegistered: boolean;
	bootReconnectDone: boolean;
}

let state: MockBtState = emptyState();
let scanTimers: Array<ReturnType<typeof setTimeout>> = [];
let scanAdapterPath: string | undefined;
let scenarioOverride: Partial<ScenarioBluetooth> | undefined;

function emptyState(): MockBtState {
	return {
		scenario: undefined,
		adapter: undefined,
		devices: new Map(),
		agentRegistered: false,
		bootReconnectDone: false,
	};
}

/** What an override means when the active scenario declares no Bluetooth. */
const OVERRIDE_BASE: ScenarioBluetooth = {
	adapter: true,
	enabled: true,
	micPaired: false,
	agent: true,
};

function effectiveScenario(): ScenarioBluetooth | undefined {
	const base = getScenarioConfig().bluetooth;
	if (base === undefined && scenarioOverride === undefined) return undefined;
	return { ...OVERRIDE_BASE, ...base, ...scenarioOverride };
}

/**
 * TEST/DEV-ONLY seam: layer a partial Bluetooth shape over the active scenario
 * and re-seed, mirroring `setMockEngineCapabilities()`.
 *
 * It is what makes the ADAPTER-ABSENT and operator-disabled arms reachable
 * without a scenario per combination: those are states of one board, not
 * different boards, and a scenario for each would multiply the roster for no
 * gain. Cleared by `resetMockBluetoothState()`.
 */
export function setMockBtScenario(
	overrides: Partial<ScenarioBluetooth> | null,
): void {
	scenarioOverride = overrides ?? undefined;
	seedMockBluetooth();
}

/**
 * Re-seed from the ACTIVE scenario and drop every timer.
 *
 * Wired into both `initMockService()` and `resetMockState()` — the seeded shape
 * is a pure function of the scenario, so re-deriving it IS the pristine state
 * and no snapshot has to be cloned (a scan timer is not `structuredClone`-able,
 * which is precisely why this state does not live in `mockState`).
 */
export function resetMockBluetoothState(): void {
	scenarioOverride = undefined;
	seedMockBluetooth();
}

function seedMockBluetooth(): void {
	clearMockBtScanTimers();
	scanAdapterPath = undefined;

	const scenario = effectiveScenario();
	if (scenario === undefined) {
		state = emptyState();
		return;
	}

	const devices = new Map<string, BluetoothDeviceRow>();
	if (scenario.adapter && scenario.enabled && scenario.micPaired) {
		devices.set(MOCK_BT_MIC_PATH, pairedMicRow(micSeed()));
	}

	state = {
		scenario,
		// The stack only observes BlueZ once the operator preference is on, so a
		// disabled scenario exposes NO adapter — the same shape a real board in
		// that state reports, rather than an adapter nothing is watching.
		adapter:
			scenario.adapter && scenario.enabled
				? { ...MOCK_BT_ADAPTER_ROW }
				: undefined,
		devices,
		agentRegistered: scenario.adapter && scenario.enabled && scenario.agent,
		bootReconnectDone: scenario.adapter && scenario.enabled,
	};
}

/**
 * Test seam: drive the pairing-agent state.
 *
 * `exporter_unavailable` is the state of every REAL device today (this build
 * ships no D-Bus object server), so a surface has to be exercisable in both
 * arms: the scenarios seed a registered agent so the pairing flow is reachable
 * in dev, and this is how the honest gap is driven.
 */
export function setMockBtAgentRegistered(registered: boolean): void {
	state.agentRegistered = registered;
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/** The interior stack-state view the wire projection is built from. */
function stackState(): BluetoothStackState {
	const scenario = state.scenario;
	const base = {
		enabled: scenario?.enabled ?? false,
		adapters: state.adapter === undefined ? [] : [state.adapter],
		devices: [...state.devices.values()],
		agent: state.agentRegistered
			? { registered: true, isDefaultAgent: true }
			: {
					registered: false,
					isDefaultAgent: false,
					reason: "exporter_unavailable" as const,
				},
		bootReconnectDone: state.bootReconnectDone,
	};

	if (scenario === undefined) {
		return {
			available: false,
			unavailable: btUnavailable(
				"emulated",
				"the active mock scenario simulates no Bluetooth hardware",
			),
			...base,
		};
	}
	if (!scenario.adapter) {
		return {
			available: false,
			unavailable: btUnavailable(
				"no_adapter",
				"the active mock scenario has no Bluetooth controller",
			),
			...base,
		};
	}
	if (!scenario.enabled) {
		// The stack's own wording for this state — an operator-disabled device is
		// simply not observing BlueZ. The procedure layer is what turns it into
		// `bluetooth_disabled`; see `mockBtRefusal()`.
		return {
			available: false,
			unavailable: btUnavailable(
				"bluez_unavailable",
				"the operator has Bluetooth switched off",
			),
			...base,
		};
	}
	return { available: true, ...base };
}

/** The whole `bluetooth` wire payload, through the REAL projection. */
export function getMockBluetoothStatus(): BluetoothStatus {
	return buildBluetoothStatus(stackState());
}

/** One device row as it currently stands, or `undefined` if it is not known. */
export function getMockBtDevice(path: string): BluetoothDevice | undefined {
	const row = state.devices.get(path);
	return row === undefined ? undefined : projectBluetoothDevice(row);
}

/** Every known device row, in registry order. */
export function getMockBtDevices(): BluetoothDevice[] {
	return [...state.devices.values()].map(projectBluetoothDevice);
}

/** Whether a scan window is currently open. */
export function isMockBtScanning(): boolean {
	return state.adapter?.discovering === true;
}

/** Live scan timers. `0` is what a clean `resetMockState()` must leave behind. */
export function getMockBtScanTimerCount(): number {
	return scanTimers.length;
}

// ─── The gate ladder ────────────────────────────────────────────────────────

/**
 * The refusal a mutation must answer with, or `undefined` when it may proceed.
 *
 * ORDER MIRRORS `bluetooth.procedure.ts`, with ONE documented divergence: a
 * scenario that simulates no Bluetooth at all answers
 * `bt_unavailable_in_emulated_mode` BEFORE the preference gate. Telling an
 * operator to switch Bluetooth on when the host has none is advice they cannot
 * act on; past that, "the operator switched it off" outranks every cause, which
 * is the procedure's own rule.
 */
function mockBtRefusal(): BluetoothMutationRefusal | undefined {
	const scenario = state.scenario;
	if (scenario === undefined) return "bt_unavailable_in_emulated_mode";
	if (!scenario.enabled) return "bluetooth_disabled";
	if (!scenario.adapter) return "no_adapter";
	return undefined;
}

function requireDevice(
	path: string,
): { row: BluetoothDeviceRow } | MockBtMutationResult {
	const gate = mockBtRefusal();
	if (gate !== undefined) return refuse(gate);
	const row = state.devices.get(path);
	if (row === undefined) return refuse("unknown_device");
	return { row };
}

function isRefusal(
	value: { row: BluetoothDeviceRow } | MockBtMutationResult,
): value is MockBtMutationResult {
	return !("row" in value);
}

function writeDevice(row: BluetoothDeviceRow): void {
	state.devices.set(row.path, row);
}

// ─── The pair / trust state machine ─────────────────────────────────────────

/**
 * Pair a device.
 *
 * BlueZ's `Device1.Pair` establishes the bond AND leaves the link up, so the
 * mock connects too — a pairing that left `connected:false` would send an
 * operator looking for a Connect button the real flow never needs. Idempotent:
 * re-pairing an already-paired device succeeds and changes nothing, exactly as
 * BlueZ answers.
 */
export function mockBtPair(path: string): MockBtMutationResult {
	const found = requireDevice(path);
	if (isRefusal(found)) return found;
	if (found.row.paired) return OK;

	writeDevice(reconnectRow({ ...found.row, paired: true }));
	return OK;
}

/**
 * Set (or REVOKE) the trust flag.
 *
 * BlueZ exposes `Trusted` as a plain settable property, so trusting an unpaired
 * device is legal and modelled — what it buys is nothing until the bond exists,
 * which is why the boot-reconnect set is `trusted && paired && !connected`.
 */
export function mockBtSetTrusted(
	path: string,
	trusted: boolean,
): MockBtMutationResult {
	const found = requireDevice(path);
	if (isRefusal(found)) return found;
	writeDevice({ ...found.row, trusted });
	return OK;
}

/**
 * Forget a device — `Adapter1.RemoveDevice`.
 *
 * The row is RETIRED, not flagged: BlueZ drops the object entirely, so a
 * forgotten device is gone from the registry until it advertises again (a scan
 * re-discovers it from the same seed, unpaired).
 */
export function mockBtForget(path: string): MockBtMutationResult {
	const found = requireDevice(path);
	if (isRefusal(found)) return found;
	state.devices.delete(path);
	return OK;
}

/** Connect. Restores the seeded `Battery1` level the disconnect retracted. */
export function mockBtConnect(path: string): MockBtMutationResult {
	const found = requireDevice(path);
	if (isRefusal(found)) return found;
	writeDevice(reconnectRow(found.row));
	return OK;
}

/**
 * Disconnect.
 *
 * The battery reading goes with it. BlueZ retracts the whole `Battery1`
 * interface when a headset disconnects (`InterfacesRemoved`), so a mock that
 * kept publishing 80% would be asserting a level nothing measured — the same
 * raise-but-never-lower class the wire schema's required booleans exist to
 * prevent.
 */
export function mockBtDisconnect(path: string): MockBtMutationResult {
	const found = requireDevice(path);
	if (isRefusal(found)) return found;
	writeDevice({
		...found.row,
		connected: false,
		batteryPercentage: undefined,
	});
	return OK;
}

/** Power an adapter on or off. */
export function mockBtSetPowered(
	adapterPath: string,
	powered: boolean,
): MockBtMutationResult {
	const gate = mockBtRefusal();
	if (gate !== undefined) return refuse(gate);
	const adapter = state.adapter;
	if (adapter === undefined || adapter.path !== adapterPath) {
		return refuse("unknown_adapter");
	}
	state.adapter = { ...adapter, powered };
	return OK;
}

/** Re-apply the connected facts a seed carries (battery), leaving flags alone. */
function reconnectRow(row: BluetoothDeviceRow): BluetoothDeviceRow {
	const seed = SEED_BY_PATH.get(row.path);
	return {
		...row,
		connected: true,
		// A bonded, connected device is not advertising — no RSSI.
		rssi: undefined,
		batteryPercentage: seed?.battery,
	};
}

// ─── The scan lifecycle ─────────────────────────────────────────────────────

/**
 * Start a bounded discovery.
 *
 * The scan starts EMPTY and folds one device in per tick, which is the shape a
 * real `InterfacesAdded` stream has — a roster that appeared all at once would
 * let a surface pass without ever rendering the state it spends most of its time
 * in. Every timer is `unref`'d: a scan window must never hold the event loop
 * open, and a dev process must never be kept alive by one.
 *
 * Refused rather than queued when a scan is already running, mirroring the
 * stack's per-adapter S5 lock: `adapter_busy`, naming the holder.
 */
export function startMockBtScan(
	adapterPath: string,
	timing: Partial<MockBtScanTiming> = {},
): MockBtMutationResult {
	const gate = mockBtRefusal();
	if (gate !== undefined) return refuse(gate);

	const adapter = state.adapter;
	if (adapter === undefined || adapter.path !== adapterPath) {
		return refuse("unknown_adapter");
	}
	if (adapter.discovering) return refuse("adapter_busy", "discovery");

	const tickMs = timing.tickMs ?? MOCK_BT_DISCOVERY_TICK_MS;
	const windowMs = timing.windowMs ?? MOCK_BT_DISCOVERY_WINDOW_MS;

	state.adapter = { ...adapter, discovering: true };
	scanAdapterPath = adapterPath;

	const pending = MOCK_BT_SEEDS.filter(
		(seed) => !state.devices.has(mockBtDevicePath(seed.address)),
	);
	pending.forEach((seed, index) => {
		arm(
			setTimeout(
				() => {
					discover(seed);
				},
				tickMs * (index + 1),
			),
		);
	});

	arm(
		setTimeout(() => {
			stopMockBtScan(adapterPath);
		}, windowMs),
	);

	return OK;
}

/** Stop a discovery window early. Idempotent — a stopped scan stops cleanly. */
export function stopMockBtScan(adapterPath: string): MockBtMutationResult {
	const gate = mockBtRefusal();
	if (gate !== undefined) return refuse(gate);

	const adapter = state.adapter;
	if (adapter === undefined || adapter.path !== adapterPath) {
		return refuse("unknown_adapter");
	}
	clearMockBtScanTimers();
	scanAdapterPath = undefined;
	state.adapter = { ...adapter, discovering: false };
	return OK;
}

function discover(seed: MockBtSeed): void {
	const path = mockBtDevicePath(seed.address);
	if (state.devices.has(path)) return;
	writeDevice(discoveredRow(seed));
}

function arm(timer: ReturnType<typeof setTimeout>): void {
	timer.unref?.();
	scanTimers.push(timer);
}

function clearMockBtScanTimers(): void {
	for (const timer of scanTimers) clearTimeout(timer);
	scanTimers = [];
}

/** The adapter a scan window is currently open on, if any. */
export function getMockBtScanAdapterPath(): string | undefined {
	return scanAdapterPath;
}
