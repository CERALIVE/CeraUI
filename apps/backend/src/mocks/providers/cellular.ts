/*
	CeraUI - Cellular (Phase-B) Mock Provider

	Feeds the three Phase-B cellular surfaces a developer otherwise needs real
	hardware to see at all: the udev `ID_PATH` behind each modem (⇒ `stable_key`
	on the wire), the netns router-dongle rows, and the D-Bus observation view
	with its additive detail block.

	Two conventions from `AGENTS.md` → DEV MOCK SEAMS are followed deliberately:

	  - **Fixtures go through the REAL reader, not around it.** The dongle rows
	    are served as file CONTENT to `dongle-metadata.ts`'s own deps seam, so dev
	    exercises the production parse / schema / staleness / ambiguity rules
	    rather than a shortcut that bypasses them. `updated_at_ms` is stamped at
	    read time for exactly that reason — a frozen timestamp would read as stale
	    within 90 s and the rows would silently vanish.
	  - **Every export is inert outside mock mode.** Nothing here is reachable
	    without `shouldUseMocks()`, and the modules that consume it import it
	    lazily so the mock graph stays off their production load paths.
*/

import type {
	ModemObservationPort,
	ObservationList,
} from "@ceralive/modem-control";
import type {
	DbusTransport,
	MethodCall,
	MethodReply,
	SignalListener,
	SignalSpec,
	Subscription,
	TransportEvent,
} from "@ceralive/modem-control/transport";

import type { ShadowModeDeps } from "../../modules/cellular/shadow.ts";
import {
	opaqueDeviceKey,
	type ShadowModemState,
	type ShadowStateSet,
} from "../../modules/cellular/shadow-divergence.ts";
import type { DbusModemView } from "../../modules/modems/modem-wire-adapters.ts";
import {
	DONGLE_METADATA_DIR,
	type DongleMetadata,
} from "../../modules/network/dongle-metadata.ts";
import { mockModems } from "../mock-config.ts";
import { getScenarioConfig, shouldUseMocks } from "../mock-service.ts";

/**
 * One synthetic RK3588 USB tree, shared by every fixture here so a dev modem
 * row, its dongle sibling and its D-Bus view all derive the SAME `stable_key`
 * the real `deriveModemStableKey` would.
 *
 * The `usb-usb-` doubling is real, not a typo: `platform-fc880000.usb` is itself
 * a `.usb`-suffixed platform device, and reproducing it here is what keeps the
 * mock honest about the `lastIndexOf` rule the derivation depends on.
 */
const USB_ROOT = "platform-fc880000.usb-usb-0:1";

/** `ifname → ID_PATH` for every mock modem, one per USB port. */
export function getMockModemIdPaths(): ReadonlyMap<string, string> {
	if (!shouldUseMocks()) return new Map();
	const paths = new Map<string, string>();
	for (const modem of mockModems) {
		// `:1.2` is the QMI net interface — the same sub-device an anchored real
		// modem enumerates under, so the derived key strips back to the parent.
		paths.set(modem.interfaceName, `${USB_ROOT}.${modem.id + 1}:1.2`);
	}
	return paths;
}

// ── router-mode dongles ──────────────────────────────────────────────────────

/**
 * Two dongles covering the honest-state ladder the row has to render: one
 * carrying traffic (`up`, which STILL gets an availability reason because it is
 * simultaneously working and unconfigurable) and one mid-DHCP (`acquiring`,
 * which is gated out of the bond and must never enter the live netif map).
 */
const MOCK_DONGLES: readonly DongleMetadata[] = [
	{
		version: 1,
		slot: 0,
		ifname: "enx0c5b8f279a64",
		usb_path: `${USB_ROOT}.5`,
		mac: "0c:5b:8f:27:9a:64",
		driver: "cdc_ether",
		inner_ip: "192.168.8.100",
		inner_gateway: "192.168.8.1",
		veth_host: "dg0h",
		veth_host_ip: "10.208.0.1",
		state: "up",
		updated_at_ms: 0,
		lease_refresh_ms: 30_000,
	},
	{
		version: 1,
		slot: 1,
		// The bench's duplicate-MAC HiLink pair, reproduced verbatim: two
		// physically distinct units shipping ONE factory MAC is the exact
		// collision the ID_PATH-keyed identity exists for, so the dev fixture
		// must not quietly give them different ones.
		ifname: "eth1",
		usb_path: `${USB_ROOT}.6`,
		mac: "0c:5b:8f:27:9a:64",
		driver: "cdc_ether",
		inner_ip: null,
		inner_gateway: null,
		veth_host: "dg1h",
		veth_host_ip: "10.208.1.1",
		state: "acquiring",
		updated_at_ms: 0,
		lease_refresh_ms: 30_000,
	},
];

function donglePath(slot: number): string {
	return `${DONGLE_METADATA_DIR}/dongle${slot}.json`;
}

export function listMockDongleFiles(): string[] {
	if (!shouldUseMocks()) return [];
	return MOCK_DONGLES.map((dongle) => donglePath(dongle.slot));
}

export function readMockDongleFile(path: string): string | undefined {
	if (!shouldUseMocks()) return undefined;
	const dongle = MOCK_DONGLES.find((d) => donglePath(d.slot) === path);
	if (dongle === undefined) return undefined;
	// Stamped NOW: the reader's 90 s staleness rule is real and applies to
	// fixtures exactly as it applies to a live claim.
	return JSON.stringify({ ...dongle, updated_at_ms: Date.now() });
}

// ── D-Bus observation views ──────────────────────────────────────────────────

/**
 * The mock D-Bus source, used when `config.modem_backend` resolved to `dbus`.
 *
 * It carries the FULL additive detail block precisely because mmcli cannot see
 * any of it — that difference is the whole reason the backend is selectable, and
 * a dev fixture that omitted it would make the two backends indistinguishable in
 * the UI they are supposed to differentiate.
 */
export function getMockDbusModemViews(): readonly DbusModemView[] {
	if (!shouldUseMocks()) return [];
	const { modems } = getScenarioConfig();
	const views: DbusModemView[] = [];
	for (const modem of mockModems.slice(0, modems)) {
		views.push({
			runtimeId: modem.id,
			idPath: getMockModemIdPaths().get(modem.interfaceName) ?? "",
			ifname: modem.interfaceName,
			model: modem.model,
			manufacturer: modem.manufacturer,
			equipmentId: modem.imei,
			mmState: "connected",
			registration: {
				status: "home",
				activeRats: new Set(
					modem.network_type.active === "5g" ? ["lte", "5gnr"] : ["lte"],
				),
			},
			signal: 60 + modem.id * 10,
			operatorName: modem.carrier,
			supportedNetworkTypes: modem.network_type.supported,
			activeNetworkType: modem.network_type.active,
			simLockRequired: "none",
			config: {
				apn: "internet",
				username: "",
				password: "",
				roaming: false,
				network: modem.operatorCode,
				autoconfig: true,
			},
			deviceClass: modem.id === 1 ? "pcie-mhi" : "usb",
			usbMode: "mbim",
			recommendedUsbMode: "mbim",
			firmwareRevision: `${modem.model}-MOCK01`,
			dataUsage: {
				session_bytes: 1_572_864 * (modem.id + 1),
				cycle_bytes: 1_342_177_280 * (modem.id + 1),
				cycle_day: 1,
				threshold_bytes: 21_474_836_480,
			},
			esim:
				modem.id === 0
					? { sim_type: "esim", esim_status: "with-profiles" }
					: { sim_type: "physical" },
			// `sinr` on an NR cell, `snr` on LTE — the schema keeps them apart on
			// purpose, so the fixture must not fold them into one key either.
			cellInfo:
				modem.network_type.active === "5g"
					? {
							tech: "nr",
							band: "n78",
							rsrp: -95 - modem.id,
							rsrq: -11,
							sinr: 14,
						}
					: {
							tech: "lte",
							band: "B3",
							rsrp: -101 - modem.id,
							rsrq: -13,
							snr: 9,
						},
		});
	}
	return views;
}

// ── shadow mode ──────────────────────────────────────────────────────────────

function inertTransport(): DbusTransport {
	return {
		connect: async (): Promise<void> => undefined,
		disconnect: async (): Promise<void> => undefined,
		isConnected: () => true,
		callMethod: async (_call: MethodCall): Promise<MethodReply> => ({
			signature: "",
			body: [],
		}),
		subscribeSignal: async (
			_spec: SignalSpec,
			_listener: SignalListener,
		): Promise<Subscription> => ({
			unsubscribe: async (): Promise<void> => undefined,
		}),
		on: (_event: TransportEvent, _handler: (payload?: unknown) => void) =>
			undefined,
		off: (_event: TransportEvent, _handler: (payload?: unknown) => void) =>
			undefined,
		subscriptionCount: () => 0,
	};
}

function observerRow(ifname: string, registration: string): unknown {
	return {
		identity: { runtimePath: `/org/freedesktop/ModemManager1/Modem/0` },
		presence: "present",
		sourceHealth: "live",
		simSlots: [{ index: 1, occupied: true, active: true, lock: "none" }],
		radioPower: "on",
		mmState: "connected",
		registration: { status: registration, activeRats: new Set(["lte"]) },
		nmActivation: "activated",
		dataInterface: { present: true, name: ifname },
		reconcileStatus: "applied",
		recoveryState: { stage: "idle", attempts: 0 },
		revision: 1,
	};
}

/**
 * The mmcli side of the comparison.
 *
 * `deviceKey` MUST go through `opaqueDeviceKey`, because the observer side does:
 * the join is an equality test on that key, so a raw ifname here produces a
 * matched `only-in-mmcli` + `only-in-dbus` PAIR on every cycle instead of the
 * one field divergence the fixture is meant to demonstrate — the exact "the two
 * sides never actually joined" failure todo 21's runbook calls a gate blocker.
 */
function mockShadowState(
	ifname: string,
	registration: string,
): ShadowModemState {
	return {
		deviceKey: opaqueDeviceKey(ifname),
		present: true,
		registration,
		signalBucket: "good",
		simPresent: true,
		networkType: "4G",
	};
}

/**
 * Shadow deps that need no bus at all, deliberately scripted to DIVERGE on one
 * dimension (`registration`: `home` vs `roaming`) for the first modem.
 *
 * Zero divergences would be the useless fixture: the runbook's whole gate is
 * read off divergence records, so a developer has to be able to see one being
 * classified, redacted and written without a second physical modem.
 */
export function getMockShadowDeps(): ShadowModeDeps {
	const ifname = mockModems[0]?.interfaceName ?? "usb0";
	return {
		createTransport: inertTransport,
		createObserver: (_transport: DbusTransport): ModemObservationPort => ({
			start: async () =>
				({
					ok: true,
					rows: [observerRow(ifname, "roaming")],
				}) as unknown as ObservationList,
			observe: () => () => undefined,
			stop: async (): Promise<void> => undefined,
		}),
		readMmcliStates: (): ShadowStateSet => ({
			states: [mockShadowState(ifname, "home")],
			unjoinable: 0,
		}),
	};
}
