/**
 * The classifier's dongles on the `modems` wire (todo 53).
 *
 * Before this, a router-mode dongle only reached the modem list through
 * `getDongleRecords()` — the netns isolation manager's metadata, which no
 * shipped image produces. The Cellular section therefore never listed the one
 * device class it most obviously describes, and the operator's report was
 * exactly that: "everything should be in modems, not in Ethernet."
 *
 * The load-bearing distinction this file pins is between the TWO router
 * adapters. They describe the same hardware in two deployments, and they must
 * NOT be unified: a netns-claimed dongle hides behind a veth that owns its bond
 * toggle, while a classified one IS the bonded interface.
 */
import { describe, expect, test } from "bun:test";

import {
	fromRouterCellularView,
	fromRouterView,
	routerCellularAvailability,
	routerCellularDisplayName,
	routerViewFromDongleMetadata,
} from "../modules/modems/modem-wire-adapters.ts";
import { projectModemWire } from "../modules/modems/modem-wire-projection.ts";
import type { DongleMetadata } from "../modules/network/dongle-metadata.ts";

const HILINK = {
	ifname: "enx0c5b8f279a64",
	vendor: "Huawei",
	model: "E3372 LTE/UMTS/GSM HiLink Modem/Networkcard",
	vidPid: "12d1:14dc",
	hasAddress: true,
} as const;

describe("a classified dongle becomes a modem row", () => {
	test("carries the router class and its own interface", () => {
		const source = fromRouterCellularView(HILINK);

		expect(source.kind).toBe("router");
		expect(source.additive?.device_class).toBe("router-ethernet");
		expect(source.ifname).toBe("enx0c5b8f279a64");
	});

	test("is named for the device, not for a slot it does not occupy", () => {
		const source = fromRouterCellularView(HILINK);

		expect(source.name).toBe(`Huawei ${HILINK.model}`);
		expect(source.manufacturer).toBe("Huawei");
		expect(source.additive?.slot_label).toBeUndefined();
	});

	test("fabricates NO radio status, SIM verdict or network list", () => {
		const source = fromRouterCellularView(HILINK);

		expect(source.status).toBeUndefined();
		expect(source.simVisibility).toBe("opaque");
		expect(source.availableNetworks).toBeUndefined();
		expect(source.config).toBeUndefined();
	});

	test("carries the admin reading when the probe got one", () => {
		const source = fromRouterCellularView({
			...HILINK,
			admin: {
				admin_url: "http://192.168.8.1",
				reachable: true,
				sim: "absent",
			},
		});

		expect(source.additive?.router_admin?.sim).toBe("absent");
	});

	test("omits the admin block entirely when the probe got nothing", () => {
		expect(
			fromRouterCellularView(HILINK).additive?.router_admin,
		).toBeUndefined();
	});
});

describe("availability distinguishes the two router deployments", () => {
	test("a directly-reached dongle with an address is router_direct", () => {
		expect(routerCellularAvailability(true)).toBe("router_direct");
	});

	test("one still waiting for its lease reuses the acquiring sentence", () => {
		expect(routerCellularAvailability(false)).toBe("dongle_acquiring");
	});

	test("a NETNS dongle keeps router_managed — its veth owns the toggle", () => {
		const metadata: DongleMetadata = {
			slot: 0,
			state: "up",
			veth_host: "dg0h",
			usb_path: "platform-fc800000.usb-usb-0:1.1:1.0",
		} as DongleMetadata;

		expect(
			fromRouterView(routerViewFromDongleMetadata(metadata)).additive
				?.availability_reason,
		).toBe("router_managed");
		expect(fromRouterCellularView(HILINK).additive?.availability_reason).toBe(
			"router_direct",
		);
	});
});

describe("projection onto the numeric wire", () => {
	test("every bench dongle gets its own synthetic id and full entry", () => {
		const { message } = projectModemWire(
			[
				fromRouterCellularView(HILINK),
				fromRouterCellularView({
					...HILINK,
					ifname: "eth1",
					hasAddress: true,
				}),
				fromRouterCellularView({
					ifname: "enx344b50000000",
					vendor: "ZTE",
					model: "ZTE Mobile Boardband",
					vidPid: "19d2:1405",
					hasAddress: true,
				}),
			],
			{ hasGsmAutoconfig: false, previousSyntheticIds: new Map() },
		);

		const ifnames = Object.values(message).map((entry) => entry.ifname);
		expect(ifnames.sort()).toEqual([
			"enx0c5b8f279a64",
			"enx344b50000000",
			"eth1",
		]);
		// The duplicate-MAC twins are physically distinct devices and must never
		// collapse into one row.
		expect(Object.keys(message)).toHaveLength(3);
	});

	test("an id survives a poll in which nothing about the device moved", () => {
		const sources = [fromRouterCellularView(HILINK)];
		const first = projectModemWire(sources, {
			hasGsmAutoconfig: false,
			previousSyntheticIds: new Map(),
		});
		const second = projectModemWire(sources, {
			hasGsmAutoconfig: false,
			previousSyntheticIds: first.syntheticIds,
		});

		expect(Object.keys(second.message)).toEqual(Object.keys(first.message));
	});

	test("the admin block rides the wire entry", () => {
		const { message } = projectModemWire(
			[
				fromRouterCellularView({
					...HILINK,
					admin: {
						admin_url: "http://192.168.8.1",
						reachable: true,
						serial: "Y4QDU17621000793",
					},
				}),
			],
			{ hasGsmAutoconfig: false, previousSyntheticIds: new Map() },
		);

		const entry = Object.values(message)[0];
		expect(entry?.router_admin?.serial).toBe("Y4QDU17621000793");
	});
});

/**
 * Per-unit naming (todo 56).
 *
 * usb.ids answers with a CLASS description — `E3372 LTE/UMTS/GSM HiLink
 * Modem/Networkcard` — which is identical for every unit of the model and reads
 * as a spec sheet. The dongle's own admin API answers `E3372`, and that is what
 * composes into a name an operator recognises.
 */
describe("the dongle names itself when it can", () => {
	const admin = (model?: string) =>
		({
			admin_url: "http://192.168.8.1",
			reachable: true,
			...(model !== undefined ? { model } : {}),
		}) as never;

	test("prefers the device's own model, prefixed with the brand", () => {
		expect(
			routerCellularDisplayName("Huawei", "usb-ids blob", admin("E3372")),
		).toBe("Huawei E3372");
	});

	test("does not repeat a brand the model already carries", () => {
		expect(
			routerCellularDisplayName(
				"ZTE,Incorporated",
				"ZTE Mobile Boardband",
				admin("ZTE MF79U"),
			),
		).toBe("ZTE MF79U");
	});

	test("reduces a registration string to the brand", () => {
		expect(
			routerCellularDisplayName(
				"ZTE,Incorporated",
				"ZTE Mobile Boardband",
				admin("MF79U"),
			),
		).toBe("ZTE MF79U");
	});

	// Honesty floor: a device that said nothing keeps the descriptor's answer,
	// brand and all. A placeholder would be a name no unit actually has.
	test("falls back to the descriptor when the device published no model", () => {
		expect(routerCellularDisplayName("Huawei", HILINK.model, admin())).toBe(
			`Huawei ${HILINK.model}`,
		);
		expect(routerCellularDisplayName("Huawei", HILINK.model, undefined)).toBe(
			`Huawei ${HILINK.model}`,
		);
	});

	// Todo 66. A device that published a class name for both descriptors has no
	// model at all, so the classifier hands over the bare product id — `9024`
	// names nothing, `Qualcomm 9024` names the silicon vendor USB-IF registered.
	test("brands a descriptor-less model instead of shipping a bare id", () => {
		expect(routerCellularDisplayName("Qualcomm", "9024", undefined)).toBe(
			"Qualcomm 9024",
		);
	});

	// Two units of one SKU are identical in every published field, so the serial
	// is the only thing that separates their rows.
	test("appends the twin discriminator when the classifier measured one", () => {
		expect(
			routerCellularDisplayName("Qualcomm", "9024", undefined, "2b16081"),
		).toBe("Qualcomm 9024 · 2b16081");
		expect(routerCellularDisplayName("Qualcomm", "9024", undefined, "")).toBe(
			"Qualcomm 9024",
		);
	});

	test("the wire row carries the discriminator the view was given", () => {
		const source = fromRouterCellularView({
			ifname: "enx020a53313630",
			vendor: "Qualcomm",
			model: "9024",
			vidPid: "05c6:9024",
			hasAddress: true,
			serial: "2b16081",
		});

		expect(source.name).toBe("Qualcomm 9024 · 2b16081");
	});

	test("the wire row carries the composed name", () => {
		const source = fromRouterCellularView({ ...HILINK, admin: admin("E3372") });

		expect(source.name).toBe("Huawei E3372");
		expect(source.model).toBe("Huawei E3372");
	});
});

/**
 * The normalized signal on the wire (todo 21).
 *
 * Todo 20 built the model and put `router_admin.signal` on the schema; this is
 * the assertion that it survives the adapter and the projection to the row that
 * renders it. It is worth its own block because the failure mode is SILENT:
 * `modem-wire-producer.ts` casts the backend reading `as RouterAdmin`, so a
 * field the schema does not carry is Zod-stripped with no error and no warning
 * — the same class of defect `apps/backend/AGENTS.md` records for
 * `captureDeviceSchema.modes[]`.
 *
 * The second half of the block is the honest floor: the signal reaching the
 * wire must NOT arrive as a `status` block. That block is ModemManager's radio
 * telemetry, and a router dongle publishes none — synthesising one from a
 * vendor web API would erase the provenance the model exists to preserve, and
 * the frontend would render two different instruments as one reading.
 */
describe("the normalized signal reaches the wire, and only as itself", () => {
	const SIGNAL = {
		provenance: "hilink-admin-api",
		freshness: "live",
		bars: { state: "known", value: 4 },
		max_bars: { state: "known", value: 5 },
		dbm: { state: "known", value: -71 },
		rsrp: { state: "known", value: -95 },
		rsrq: { state: "known", value: -11 },
		snr: { state: "unknown", reason: "unsupported" },
		sinr: { state: "known", value: 9 },
	} as const;

	const withSignal = (signal: unknown) =>
		fromRouterCellularView({
			...HILINK,
			admin: {
				admin_url: "http://192.168.8.1",
				reachable: true,
				signal,
			} as never,
		});

	test("the adapter forwards it verbatim", () => {
		const source = withSignal(SIGNAL);
		expect(source.additive?.router_admin?.signal).toEqual(SIGNAL);
	});

	test("it survives the projection onto the numeric wire", () => {
		const { message } = projectModemWire([withSignal(SIGNAL)], {
			hasGsmAutoconfig: false,
			previousSyntheticIds: new Map(),
		});

		const entry = Object.values(message)[0];
		expect(entry?.router_admin?.signal?.provenance).toBe("hilink-admin-api");
		expect(entry?.router_admin?.signal?.bars).toEqual({
			state: "known",
			value: 4,
		});
		// The dialect cannot express `snr` at all, and that fact must reach the
		// consumer intact — it is what lets the row render the metric as ABSENT
		// rather than as a dash that would read "the radio reported nothing".
		expect(entry?.router_admin?.signal?.snr).toEqual({
			state: "unknown",
			reason: "unsupported",
		});
	});

	test("a degraded reading crosses the wire as its own reason", () => {
		const unreachable = {
			...SIGNAL,
			freshness: "unknown",
			bars: { state: "unknown", reason: "unreachable" },
			max_bars: { state: "unknown", reason: "unreachable" },
			dbm: { state: "unknown", reason: "unreachable" },
			rsrp: { state: "unknown", reason: "unreachable" },
			rsrq: { state: "unknown", reason: "unreachable" },
			sinr: { state: "unknown", reason: "unreachable" },
		} as const;
		const { message } = projectModemWire([withSignal(unreachable)], {
			hasGsmAutoconfig: false,
			previousSyntheticIds: new Map(),
		});

		const signal = Object.values(message)[0]?.router_admin?.signal;
		expect(signal?.freshness).toBe("unknown");
		expect(signal?.dbm).toEqual({ state: "unknown", reason: "unreachable" });
		expect(signal?.snr).toEqual({ state: "unknown", reason: "unsupported" });
	});

	test("it is NEVER promoted into a fabricated radio status block", () => {
		const { message } = projectModemWire([withSignal(SIGNAL)], {
			hasGsmAutoconfig: false,
			previousSyntheticIds: new Map(),
		});

		const entry = Object.values(message)[0];
		expect(entry?.status).toBeUndefined();
		expect(withSignal(SIGNAL).status).toBeUndefined();
	});
});

/**
 * The expanded read-only detail block on the wire (todo 23).
 *
 * Same silent failure mode as the signal block above — the reading is cast
 * `as RouterAdmin`, so an unschema'd field is Zod-stripped with no error — plus
 * one property this block adds: the row it lands on is chosen by TODO 10's
 * identity record, not by the interface name. That matters here because the two
 * bench HiLinks rename against each other on replug, so a detail block keyed on
 * the ifname would follow the NAME rather than the physical device.
 */
describe("the expanded detail block reaches the wire, on the right device", () => {
	const DETAILS = {
		network_type: "LTE",
		provider: "Claro",
		cell_id: "134318388",
		band: "B4",
	} as const;

	const withDetails = (details: unknown, identity?: unknown) =>
		fromRouterCellularView({
			...HILINK,
			admin: {
				admin_url: "http://192.168.8.1",
				reachable: true,
				details,
			} as never,
			...(identity === undefined ? {} : { identity: identity as never }),
		});

	test("the adapter forwards it verbatim", () => {
		expect(withDetails(DETAILS).additive?.router_admin?.details).toEqual(
			DETAILS,
		);
	});

	test("it survives the projection onto the numeric wire", () => {
		const { message } = projectModemWire([withDetails(DETAILS)], {
			hasGsmAutoconfig: false,
			previousSyntheticIds: new Map(),
		});

		expect(Object.values(message)[0]?.router_admin?.details).toEqual(DETAILS);
	});

	test("it lands on the row the identity record keys, not on the ifname", () => {
		const identity = {
			identityKey: "id-path:platform-usb-1.4.1",
			anchor: "id-path",
			linkId: "lnk_0123456789abcdef",
			stableKey: "platform-usb-1.4.1",
			ifname: "eth1",
			displayName: "Huawei E3372",
		};
		const source = withDetails(DETAILS, identity);
		const { message } = projectModemWire([source], {
			hasGsmAutoconfig: false,
			previousSyntheticIds: new Map(),
		});

		const entry = Object.values(message)[0];
		expect(source.allocationKey).toBe("platform-usb-1.4.1");
		expect(entry?.stable_key).toBe("platform-usb-1.4.1");
		expect(entry?.router_admin?.details).toEqual(DETAILS);
	});

	test("a device that stated nothing carries NO block, never an empty one", () => {
		const { message } = projectModemWire(
			[
				fromRouterCellularView({
					...HILINK,
					admin: { admin_url: "http://192.168.8.1", reachable: false } as never,
				}),
			],
			{ hasGsmAutoconfig: false, previousSyntheticIds: new Map() },
		);

		expect(Object.values(message)[0]?.router_admin?.details).toBeUndefined();
	});
});
