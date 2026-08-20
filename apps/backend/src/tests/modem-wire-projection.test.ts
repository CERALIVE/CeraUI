import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { modemSchema } from "@ceraui/rpc/schemas";
import { resolveGsmAutoconfigSupport } from "../modules/modems/gsm-autoconfig.ts";
import { buildModemsMessage } from "../modules/modems/modem-status.ts";
import {
	fromDbusView,
	fromMmcliModem,
	fromRouterView,
	ROUTER_AVAILABILITY_REASONS,
	ratsToNetworkTypeDisplay,
	routerViewFromDongleMetadata,
} from "../modules/modems/modem-wire-adapters.ts";
import {
	allocateSyntheticIds,
	type ProjectedModemSource,
	projectModemWire,
	resolveWireConfig,
	SYNTHETIC_ID_BASE,
	type WireModemEntry,
} from "../modules/modems/modem-wire-projection.ts";
import {
	getModemIds,
	type Modem,
	removeModem,
	setModem,
} from "../modules/modems/modems-state.ts";
import type { DongleMetadata } from "../modules/network/dongle-metadata.ts";
import { setup } from "../modules/setup.ts";

/**
 * The ten additive fields that must NOT appear on an mmcli-derived row.
 * `stable_key` is the deliberate eleventh — it IS emitted there.
 */
const ADDITIVE_DETAIL_KEYS = [
	"device_class",
	"availability_reason",
	"slot_label",
	"recovery_state",
	"usb_mode",
	"recommended_usb_mode",
	"data_usage",
	"firmware_revision",
	"esim",
	"cell_info",
] as const;

/**
 * One physical Quectel stick, seen through three different observers.
 *
 * The three `ID_PATH`s below are the SAME `usb_device` under different
 * interfaces — that is the whole point of the cross-adapter fixture. Note the
 * `usb-usb-` doubling: `platform-fc880000.usb` is itself a `.usb`-suffixed
 * platform device, which is why the derivation must use `lastIndexOf`.
 */
const USB_DEVICE_PATH = "platform-fc880000.usb-usb-0:1.4.1";
const MM_NET_INTERFACE_PATH = `${USB_DEVICE_PATH}:1.2`;
const MM_TTY_INTERFACE_PATH = `${USB_DEVICE_PATH}:1.4`;

function buildModemFixture(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "wwan0",
		name: "RM520N-GL - 12345",
		sim_network: "21407",
		model: "RM520N-GL",
		manufacturer: "Quectel",
		network_type: {
			supported: { "3g": "3g", "4g": "4g", "5g": "5g" },
			active: "5g4g",
		},
		config: {
			conn: "nm-uuid-1",
			autoconfig: false,
			apn: "internet",
			username: "user",
			password: "pass",
			roaming: true,
			network: "21407",
		},
		status: {
			connection: "connected",
			network: "Movistar",
			network_type: "5G",
			signal: 72,
			roaming: false,
		},
		sim_lock: { required: "none" },
		available_networks: {
			"21407": { name: "Movistar", availability: "available" },
		},
		...overrides,
	};
}

function buildDongleFixture(
	overrides: Partial<DongleMetadata> = {},
): DongleMetadata {
	return {
		version: 1,
		slot: 0,
		ifname: "enx0c5b8f279a64",
		usb_path: USB_DEVICE_PATH,
		mac: "0c:5b:8f:27:9a:64",
		driver: "cdc_ether",
		inner_ip: "192.168.8.100",
		inner_gateway: "192.168.8.1",
		veth_host: "dg0h",
		veth_host_ip: "10.208.0.1",
		state: "up",
		updated_at_ms: Date.now(),
		lease_refresh_ms: 30_000,
		...overrides,
	};
}

function clearModemState(): void {
	for (const id of getModemIds()) {
		removeModem(id);
	}
}

describe("modem wire projection — legacy byte-compat (mmcli path)", () => {
	let originalAutoconfig: boolean | undefined;

	beforeEach(() => {
		clearModemState();
		originalAutoconfig = setup.has_gsm_autoconfig;
	});

	afterEach(() => {
		clearModemState();
		if (originalAutoconfig === undefined) {
			delete setup.has_gsm_autoconfig;
		} else {
			setup.has_gsm_autoconfig = originalAutoconfig;
		}
	});

	/**
	 * The core contract. Driven against the REAL `buildModemsMessage`, not a
	 * hand-written expectation — a hand-written one would drift the moment the
	 * live builder changed, which is exactly the regression this test exists to
	 * catch.
	 */
	test("a full entry is byte-identical to the live builder once stable_key is removed", () => {
		setup.has_gsm_autoconfig = true;
		const modem = buildModemFixture();
		setModem(7, modem);

		const legacy = buildModemsMessage();
		const projected = projectModemWire(
			[fromMmcliModem(7, modem, { idPath: MM_NET_INTERFACE_PATH })],
			{ hasGsmAutoconfig: setup.has_gsm_autoconfig === true },
		);

		const entry: WireModemEntry = { ...projected.message["7"] };
		expect(entry.stable_key).toBe(USB_DEVICE_PATH);
		delete entry.stable_key;

		// `toEqual` proves nothing was LOST; the stringify proves nothing was
		// ADDED and no key MOVED — a `toEqual` alone passes on a reordered object.
		expect(entry).toEqual(legacy["7"] as WireModemEntry);
		expect(JSON.stringify(entry)).toBe(JSON.stringify(legacy["7"]));
	});

	test("a status-only partial is byte-identical to the live builder", () => {
		const modem = buildModemFixture();
		setModem(3, modem);

		const legacy = buildModemsMessage({});
		const projected = projectModemWire(
			[fromMmcliModem(3, modem, { idPath: MM_NET_INTERFACE_PATH })],
			{ hasGsmAutoconfig: setup.has_gsm_autoconfig === true, fullState: {} },
		);

		expect(JSON.stringify(projected.message["3"])).toBe(
			JSON.stringify(legacy["3"]),
		);
		// A partial carries identity-free status only — no stable_key either.
		expect(Object.keys(projected.message["3"] ?? {})).toEqual(["status"]);
	});

	test("a SIM-less modem still emits no_sim, byte-identically", () => {
		const modem = buildModemFixture({ config: undefined });
		setModem(1, modem);

		const legacy = buildModemsMessage();
		const projected = projectModemWire([fromMmcliModem(1, modem)], {
			hasGsmAutoconfig: false,
		});

		expect(projected.message["1"]?.no_sim).toBe(true);
		expect(JSON.stringify(projected.message["1"])).toBe(
			JSON.stringify(legacy["1"]),
		);
	});

	test("no additive detail field beyond stable_key appears on the mmcli path", () => {
		const modem = buildModemFixture();
		const projected = projectModemWire(
			[fromMmcliModem(2, modem, { idPath: MM_NET_INTERFACE_PATH })],
			{ hasGsmAutoconfig: false },
		);
		const entry = projected.message["2"] ?? {};

		for (const key of ADDITIVE_DETAIL_KEYS) {
			expect({ key, present: Object.hasOwn(entry, key) }).toEqual({
				key,
				present: false,
			});
		}
		expect(Object.hasOwn(entry, "stable_key")).toBe(true);
		expect(modemSchema.parse(entry).stable_key).toBe(USB_DEVICE_PATH);
	});

	test("a modem with no resolvable ID_PATH omits stable_key entirely", () => {
		const modem = buildModemFixture();
		setModem(4, modem);

		const legacy = buildModemsMessage();
		const projected = projectModemWire([fromMmcliModem(4, modem)], {
			// Read from the SAME resolver the legacy builder now uses: a literal
			// here compares two different answers to one question.
			hasGsmAutoconfig: resolveGsmAutoconfigSupport(),
		});

		// With no ID_PATH the projection is the pre-Phase-B wire, exactly.
		expect(JSON.stringify(projected.message["4"])).toBe(
			JSON.stringify(legacy["4"]),
		);
		expect(Object.hasOwn(projected.message["4"] ?? {}, "stable_key")).toBe(
			false,
		);
	});

	test("autoconfig is gated by has_gsm_autoconfig, and the APN is passed through verbatim", () => {
		const config = {
			apn: "internet",
			username: "u",
			password: "p",
			roaming: false,
			network: "",
			autoconfig: true,
		};

		expect(resolveWireConfig(config, false).autoconfig).toBe(false);
		expect(resolveWireConfig(config, true).autoconfig).toBe(true);

		// The reference implementation this shape came from ALSO cleared the APN
		// whenever auto-config resolved on. The live builder does not, so doing
		// it here would break byte-compat for any modem whose stored APN
		// outlived an auto-config toggle.
		expect(resolveWireConfig(config, true).apn).toBe("internet");
	});
});

describe("modem wire projection — stable_key identity", () => {
	test("stable_key survives re-enumeration under a new ModemManager index", () => {
		const before = fromMmcliModem(2, buildModemFixture(), {
			idPath: MM_NET_INTERFACE_PATH,
		});
		const after = fromMmcliModem(9, buildModemFixture(), {
			idPath: MM_NET_INTERFACE_PATH,
		});

		expect(before.stableKey).toBe(after.stableKey);
		expect(before.runtimeId).not.toBe(after.runtimeId);

		const projected = projectModemWire([after], { hasGsmAutoconfig: false });
		// The numeric wire key moved with the MM index; the identity did not.
		// This is precisely why a consumer must correlate on stable_key.
		expect(Object.keys(projected.message)).toEqual(["9"]);
		expect(projected.message["9"]?.stable_key).toBe(USB_DEVICE_PATH);
	});

	test("two interfaces of one physical unit collapse to one key", () => {
		const net = fromMmcliModem(2, buildModemFixture(), {
			idPath: MM_NET_INTERFACE_PATH,
		});
		const tty = fromMmcliModem(2, buildModemFixture(), {
			idPath: MM_TTY_INTERFACE_PATH,
		});

		expect(net.stableKey).toBe(tty.stableKey);
	});

	/**
	 * THE cross-adapter fixture: the whole `stable_key` design in one assertion.
	 *
	 * A HiLink-style stick in router-ethernet mode is observed by the router
	 * adapter; after a USB-composition switch the SAME hardware re-enumerates as
	 * an MM-managed modem and is observed by the mmcli adapter. Its MM index is
	 * freshly issued, its ifname changes, its wire row moves from a synthetic
	 * ≥1000 id to an MM id — and the key must not move, because that transition
	 * is the exact moment a consumer needs to follow it.
	 */
	test("the same physical device yields an IDENTICAL key through the router and mm adapters", () => {
		const router = fromRouterView(
			routerViewFromDongleMetadata(buildDongleFixture()),
		);
		const mm = fromMmcliModem(5, buildModemFixture(), {
			idPath: MM_NET_INTERFACE_PATH,
		});
		const dbus = fromDbusView(buildDbusViewFixture());

		expect(router.stableKey).toBe(USB_DEVICE_PATH);
		expect(mm.stableKey).toBe(router.stableKey);
		expect(dbus.stableKey).toBe(router.stableKey);

		// Everything else about the two rows legitimately differs.
		expect(router.kind).not.toBe(mm.kind);
		expect(router.runtimeId).toBeNull();
		expect(mm.runtimeId).toBe(5);
		expect(router.ifname).not.toBe(mm.ifname);
	});

	test("a different physical port yields a different key", () => {
		const portA = fromRouterView(
			routerViewFromDongleMetadata(buildDongleFixture()),
		);
		const portB = fromRouterView(
			routerViewFromDongleMetadata(
				buildDongleFixture({
					slot: 1,
					veth_host: "dg1h",
					usb_path: "platform-fc880000.usb-usb-0:1.4.2",
				}),
			),
		);

		expect(portA.stableKey).not.toBe(portB.stableKey);
	});
});

describe("modem wire projection — synthetic id allocation", () => {
	test("a non-MM device allocates from the reserved >=1000 floor", () => {
		const router = fromRouterView(
			routerViewFromDongleMetadata(buildDongleFixture()),
		);
		const mm = fromMmcliModem(0, buildModemFixture(), {
			idPath: MM_NET_INTERFACE_PATH,
		});

		const projected = projectModemWire([mm, router], {
			hasGsmAutoconfig: false,
		});

		expect(Object.keys(projected.message).sort()).toEqual(["0", "1000"]);
		expect(SYNTHETIC_ID_BASE).toBe(1000);
	});

	/**
	 * The QA-failure case from the plan. `>= 1000 is always free` is an
	 * assumption, not a fact: MM ids are monotonic and a long-lived board can
	 * reach the reserved range.
	 */
	test("a live MM id of 1000 pushes the synthetic id to the next free slot", () => {
		const mm = fromMmcliModem(1000, buildModemFixture(), {
			idPath: MM_NET_INTERFACE_PATH,
		});
		const router = fromRouterView(
			routerViewFromDongleMetadata(buildDongleFixture()),
		);

		const projected = projectModemWire([mm, router], {
			hasGsmAutoconfig: false,
		});
		const keys = Object.keys(projected.message).sort();

		expect(keys).toEqual(["1000", "1001"]);
		// The collision must be resolved by MOVING the synthetic row, never by
		// overwriting the live MM row.
		expect(projected.message["1000"]?.ifname).toBe("wwan0");
		expect(projected.message["1001"]?.slot_label).toBe("dongle0");
		expect(new Set(keys).size).toBe(keys.length);
	});

	test("consecutive live MM ids in the reserved range are all skipped", () => {
		const sources: ProjectedModemSource[] = [
			fromMmcliModem(1000, buildModemFixture()),
			fromMmcliModem(1001, buildModemFixture()),
			fromRouterView(routerViewFromDongleMetadata(buildDongleFixture())),
		];

		const projected = projectModemWire(sources, { hasGsmAutoconfig: false });
		expect(Object.keys(projected.message).sort()).toEqual([
			"1000",
			"1001",
			"1002",
		]);
	});

	test("a replugged dongle gets its OLD synthetic id back", () => {
		const slot0 = routerViewFromDongleMetadata(buildDongleFixture());
		const slot1 = routerViewFromDongleMetadata(
			buildDongleFixture({
				slot: 1,
				veth_host: "dg1h",
				usb_path: "platform-fc880000.usb-usb-0:1.4.2",
			}),
		);

		const pass1 = projectModemWire(
			[fromRouterView(slot0), fromRouterView(slot1)],
			{ hasGsmAutoconfig: false },
		);
		const slot1Id = pass1.syntheticIds.get(fromRouterView(slot1).allocationKey);
		expect(slot1Id).toBeDefined();

		// slot0 unplugged — slot1 must NOT be renumbered down into the freed slot.
		const pass2 = projectModemWire([fromRouterView(slot1)], {
			hasGsmAutoconfig: false,
			previousSyntheticIds: pass1.syntheticIds,
		});
		expect(pass2.syntheticIds.get(fromRouterView(slot1).allocationKey)).toBe(
			slot1Id,
		);

		// slot0 replugged — it reclaims exactly the id it held before.
		const pass3 = projectModemWire(
			[fromRouterView(slot0), fromRouterView(slot1)],
			{ hasGsmAutoconfig: false, previousSyntheticIds: pass2.syntheticIds },
		);
		expect(pass3.syntheticIds).toEqual(pass1.syntheticIds);
	});

	test("allocation is independent of array order", () => {
		const a = fromRouterView(
			routerViewFromDongleMetadata(buildDongleFixture()),
		);
		const b = fromRouterView(
			routerViewFromDongleMetadata(
				buildDongleFixture({
					slot: 1,
					veth_host: "dg1h",
					usb_path: "platform-fc880000.usb-usb-0:1.4.2",
				}),
			),
		);

		const forward = allocateSyntheticIds([a, b], new Set());
		const reversed = allocateSyntheticIds([b, a], new Set());

		expect(forward).toEqual(reversed);
	});

	test("a dongle whose metadata carries no usb_path still allocates deterministically", () => {
		const view = routerViewFromDongleMetadata(
			buildDongleFixture({ usb_path: "   " }),
		);
		const source = fromRouterView(view);

		expect(source.stableKey).toBeUndefined();
		expect(source.allocationKey).toBe("dongle-slot:dongle0");

		const projected = projectModemWire([source], { hasGsmAutoconfig: false });
		expect(Object.keys(projected.message)).toEqual(["1000"]);
		// No ID_PATH means no honest identity — the field is omitted, not faked.
		expect(Object.hasOwn(projected.message["1000"] ?? {}, "stable_key")).toBe(
			false,
		);
	});
});

describe("modem wire projection — router-ethernet rows", () => {
	test("a router row is class-marked, slot-labelled and honest about its reason", () => {
		const projected = projectModemWire(
			[fromRouterView(routerViewFromDongleMetadata(buildDongleFixture()))],
			{ hasGsmAutoconfig: false },
		);
		const entry = projected.message["1000"] ?? {};

		expect(entry.device_class).toBe("router-ethernet");
		expect(entry.slot_label).toBe("dongle0");
		expect(entry.availability_reason).toBe("router_managed");
		expect(entry.ifname).toBe("dg0h");
		expect(entry.name).toBe("dongle0");
	});

	test("each dongle lifecycle state carries its own honest reason", () => {
		const reasons = (["up", "acquiring", "down"] as const).map((state) => {
			const source = fromRouterView(
				routerViewFromDongleMetadata(buildDongleFixture({ state })),
			);
			return source.additive?.availability_reason;
		});

		expect(reasons).toEqual([
			ROUTER_AVAILABILITY_REASONS.up,
			ROUTER_AVAILABILITY_REASONS.acquiring,
			ROUTER_AVAILABILITY_REASONS.down,
		]);
		expect(new Set(reasons).size).toBe(3);
	});

	/**
	 * The anti-fabrication lock. A router dongle publishes NO radio telemetry to
	 * the host, so a zeroed status block would render as "no signal" on a dongle
	 * that is carrying traffic. Absence is the honest answer.
	 */
	test("a router row invents NO signal, SIM or scan data", () => {
		const projected = projectModemWire(
			[fromRouterView(routerViewFromDongleMetadata(buildDongleFixture()))],
			{ hasGsmAutoconfig: false },
		);
		const entry = projected.message["1000"] ?? {};

		for (const key of [
			"status",
			"config",
			"no_sim",
			"sim_lock",
			"available_networks",
		]) {
			expect({ key, present: Object.hasOwn(entry, key) }).toEqual({
				key,
				present: false,
			});
		}
		// Belt and braces: the serialized row contains no signal figure at all.
		expect(JSON.stringify(entry)).not.toContain("signal");
	});

	test("a router row is schema-valid despite those omissions", () => {
		const projected = projectModemWire(
			[fromRouterView(routerViewFromDongleMetadata(buildDongleFixture()))],
			{ hasGsmAutoconfig: false },
		);

		const parsed = modemSchema.parse(projected.message["1000"]);
		expect(parsed.device_class).toBe("router-ethernet");
		expect(parsed.status).toBeUndefined();
	});
});

describe("modem wire projection — D-Bus rows", () => {
	test("additive detail observed over D-Bus reaches the wire", () => {
		const projected = projectModemWire([fromDbusView(buildDbusViewFixture())], {
			hasGsmAutoconfig: false,
		});
		const entry = projected.message["1"] ?? {};

		expect(entry.device_class).toBe("usb");
		expect(entry.recovery_state).toBe("online");
		expect(entry.usb_mode).toBe("qmi");
		expect(entry.recommended_usb_mode).toBe("mbim");
		expect(entry.firmware_revision).toBe("RM520NGLAAR03A03M4G");
		expect(entry.esim).toEqual({
			sim_type: "physical",
			esim_status: "unknown",
		});
		expect(entry.data_usage).toEqual({
			session_bytes: 1024,
			cycle_bytes: 8192,
		});
		expect(entry.cell_info?.sinr).toBe(12.5);
		expect(entry.stable_key).toBe(USB_DEVICE_PATH);
		expect(modemSchema.parse(entry).device_class).toBe("usb");
	});

	test("a D-Bus row with no observed detail carries none of it", () => {
		const view = buildDbusViewFixture();
		const bare = fromDbusView({
			runtimeId: view.runtimeId,
			idPath: view.idPath,
			ifname: view.ifname,
			model: view.model,
			equipmentId: view.equipmentId,
			mmState: view.mmState,
			registration: view.registration,
			signal: view.signal,
			supportedNetworkTypes: view.supportedNetworkTypes,
			activeNetworkType: view.activeNetworkType,
		});

		expect(bare.additive).toBeUndefined();
		const entry =
			projectModemWire([bare], { hasGsmAutoconfig: false }).message["1"] ?? {};
		for (const key of ADDITIVE_DETAIL_KEYS) {
			expect({ key, present: Object.hasOwn(entry, key) }).toEqual({
				key,
				present: false,
			});
		}
	});

	test("the active RAT set folds to the legacy generation display, highest wins", () => {
		expect(ratsToNetworkTypeDisplay(new Set(["lte", "5gnr"]))).toBe("5G");
		expect(ratsToNetworkTypeDisplay(new Set(["gsm", "umts"]))).toBe("3G");
		expect(ratsToNetworkTypeDisplay(new Set(["lte"]))).toBe("4G");
		expect(ratsToNetworkTypeDisplay(new Set())).toBe("");
		expect(ratsToNetworkTypeDisplay(new Set(["future-rat"]))).toBe("");
	});

	/**
	 * Pins the APPEND, which the byte-compat diff structurally cannot: that test
	 * deletes `stable_key` from a spread copy, and the remaining legacy keys stay
	 * in order wherever the additive block was inserted. Without this assertion
	 * the "appended, never interleaved" contract is documentation only.
	 */
	test("the additive block is appended AFTER every legacy key, in schema order", () => {
		const entry =
			projectModemWire([fromDbusView(buildDbusViewFixture())], {
				hasGsmAutoconfig: false,
			}).message["1"] ?? {};

		expect(Object.keys(entry)).toEqual([
			"status",
			"ifname",
			"name",
			"model",
			"manufacturer",
			"network_type",
			"config",
			"sim_lock",
			"available_networks",
			"device_class",
			"recovery_state",
			"usb_mode",
			"recommended_usb_mode",
			"data_usage",
			"firmware_revision",
			"esim",
			"cell_info",
			"stable_key",
		]);
	});

	test("a D-Bus row projects the same legacy field SET as an mmcli row", () => {
		const dbus =
			projectModemWire([fromDbusView(buildDbusViewFixture())], {
				hasGsmAutoconfig: false,
			}).message["1"] ?? {};
		const mmcli =
			projectModemWire(
				[
					fromMmcliModem(1, buildModemFixture(), {
						idPath: MM_NET_INTERFACE_PATH,
					}),
				],
				{ hasGsmAutoconfig: false },
			).message["1"] ?? {};

		const legacyKeys = (entry: WireModemEntry): string[] =>
			Object.keys(entry).filter(
				(key) =>
					!(ADDITIVE_DETAIL_KEYS as readonly string[]).includes(key) &&
					key !== "stable_key",
			);

		expect(legacyKeys(dbus)).toEqual(legacyKeys(mmcli));
	});
});

function buildDbusViewFixture() {
	return {
		runtimeId: 1,
		idPath: MM_TTY_INTERFACE_PATH,
		ifname: "wwan0",
		model: "RM520N-GL",
		manufacturer: "Quectel",
		equipmentId: "861234567812345",
		mmState: "connected",
		registration: {
			status: "home",
			activeRats: new Set(["lte", "5gnr"]),
		},
		signal: 72,
		operatorName: "Movistar",
		supportedNetworkTypes: ["3g", "4g", "5g"],
		activeNetworkType: "5g4g" as string | null,
		simLockRequired: "none",
		config: {
			apn: "internet",
			username: "user",
			password: "pass",
			roaming: true,
			network: "21407",
			autoconfig: false,
		},
		availableNetworks: {
			"21407": { name: "Movistar", availability: "available" as const },
		},
		deviceClass: "usb" as const,
		recoveryState: "online" as const,
		usbMode: "qmi" as const,
		recommendedUsbMode: "mbim" as const,
		dataUsage: { session_bytes: 1024, cycle_bytes: 8192 },
		firmwareRevision: "RM520NGLAAR03A03M4G",
		esim: { sim_type: "physical" as const, esim_status: "unknown" as const },
		cellInfo: { tech: "nr" as const, sinr: 12.5 },
	};
}
