import { describe, expect, test } from "bun:test";

import {
	decodeAccessTechnologies,
	decodeMmState,
	decodeRegistrationState,
	decodeUnlockRequired,
	modeMaskToLabel,
	runtimeIdFromPath,
} from "../modules/cellular/dbus-mm-enums.ts";
import { foldDbusModemViews } from "../modules/cellular/dbus-view-fold.ts";
import { fromDbusView } from "../modules/modems/modem-wire-adapters.ts";

import {
	MM_ACCESS_TECH_LTE,
	MM_MODE_4G,
	MM_MODE_5G,
	MM_STATE_SEARCHING,
	managedObjectsTree,
	modemObjects,
} from "./support/mm-tree-fixture.ts";

const QUECTEL = {
	path: "/org/freedesktop/ModemManager1/Modem/14",
	ifname: "wwan0",
	model: "RM530N-GL",
	manufacturer: "Quectel",
	equipmentId: "861234567890123",
	physdev: "/sys/devices/platform/usb/1-1.3",
	operatorName: "Movistar",
	signal: 61,
	revision: "RM530NGLAAR11A02M4G",
	simPath: "/org/freedesktop/ModemManager1/SIM/2",
	simType: 2,
	esimStatus: 2,
	unlockRetries: [[1, 3]] as const,
} as const;

describe("MM enum decoding", () => {
	test("Given an MMModemMode mask, When folded, Then it reproduces mmcli's label grammar", () => {
		expect(modeMaskToLabel(MM_MODE_4G | MM_MODE_5G)).toBe("5g4g");
		expect(modeMaskToLabel(MM_MODE_4G)).toBe("4g");
	});

	test("Given no mode bits, When folded, Then the answer is undefined rather than an empty label", () => {
		expect(modeMaskToLabel(0)).toBeUndefined();
		expect(modeMaskToLabel(undefined)).toBeUndefined();
	});

	test("Given an access-technology mask, When decoded, Then several MM bits fold onto one adapter token", () => {
		expect([...decodeAccessTechnologies(MM_ACCESS_TECH_LTE)]).toEqual(["lte"]);
		expect([...decodeAccessTechnologies((1 << 9) | (1 << 5))]).toEqual([
			"umts",
		]);
		expect([...decodeAccessTechnologies(0)]).toEqual([]);
	});

	test("Given a registration state, When decoded, Then SMS-only variants fold onto their base token", () => {
		expect(decodeRegistrationState(6)).toBe("home");
		expect(decodeRegistrationState(8)).toBe("roaming");
		expect(decodeRegistrationState(999)).toBe("unknown");
	});

	test("Given MMModemLock 'none', When decoded, Then it is the STRING none, not absence", () => {
		expect(decodeUnlockRequired(1)).toBe("none");
		expect(decodeUnlockRequired(3)).toBe("sim-pin2");
		expect(decodeUnlockRequired(0)).toBeUndefined();
	});

	test("Given an MM state number, When decoded, Then it matches mmcli's own token", () => {
		expect(decodeMmState(11)).toBe("connected");
		expect(decodeMmState(-1)).toBe("failed");
		expect(decodeMmState(undefined)).toBe("unknown");
	});

	test("Given an object path, When the runtime id is parsed, Then only a trailing integer qualifies", () => {
		expect(runtimeIdFromPath("/org/freedesktop/ModemManager1/Modem/14")).toBe(
			14,
		);
		expect(runtimeIdFromPath("/org/freedesktop/ModemManager1")).toBeUndefined();
	});
});

describe("the ObservationList tree -> DbusModemView fold", () => {
	test("Given a full modem object, When folded, Then every observed field is carried", () => {
		const [view] = foldDbusModemViews(modemObjects(QUECTEL));

		expect(view).toBeDefined();
		expect(view?.runtimeId).toBe(14);
		expect(view?.ifname).toBe("wwan0");
		expect(view?.idPath).toBe("/sys/devices/platform/usb/1-1.3");
		expect(view?.mmState).toBe("connected");
		expect(view?.signal).toBe(61);
		expect(view?.operatorName).toBe("Movistar");
		expect(view?.model).toBe("RM530N-GL");
		expect(view?.manufacturer).toBe("Quectel");
		expect(view?.equipmentId).toBe("861234567890123");
		expect(view?.firmwareRevision).toBe("RM530NGLAAR11A02M4G");
		expect(view?.registration.status).toBe("home");
		expect([...(view?.registration.activeRats ?? [])]).toEqual(["lte"]);
		expect(view?.supportedNetworkTypes).toEqual(["4g", "5g4g"]);
		expect(view?.activeNetworkType).toBe("5g4g");
		expect(view?.simLockRequired).toBe("none");
		expect(view?.simLockRemainingAttempts).toBe(3);
		expect(view?.esim).toEqual({
			sim_type: "esim",
			esim_status: "with-profiles",
		});
	});

	test("Given a modem with no net port, When folded, Then it is SKIPPED rather than half-described", () => {
		const tree = modemObjects({
			path: "/org/freedesktop/ModemManager1/Modem/3",
			ifname: "wwan0",
		});
		// Strip the net port: a modem MM has not finished probing has no data
		// interface, and a row without one cannot be routed or bonded.
		const stripped = JSON.parse(
			JSON.stringify(tree).replace('["wwan0",2]', '["ttyUSB1",3]'),
		);

		expect(foldDbusModemViews(stripped)).toEqual([]);
	});

	test("Given an unobserved property, When folded, Then the key is OMITTED, never zeroed", () => {
		const [view] = foldDbusModemViews(
			modemObjects({ path: "/org/freedesktop/ModemManager1/Modem/0" }),
		);

		expect(view).toBeDefined();
		expect(view && "operatorName" in view).toBe(false);
		expect(view && "model" in view).toBe(false);
		expect(view && "esim" in view).toBe(false);
	});

	test("Given a searching modem, When folded, Then scanning is set so the wire connection reads 'scanning'", () => {
		const [view] = foldDbusModemViews(
			modemObjects({
				path: "/org/freedesktop/ModemManager1/Modem/1",
				state: MM_STATE_SEARCHING,
			}),
		);

		expect(view?.scanning).toBe(true);
		expect(view && fromDbusView(view).status.connection).toBe("scanning");
	});

	test("Given a folded view, When adapted, Then it produces a routable mm-managed source", () => {
		const [view] = foldDbusModemViews(modemObjects(QUECTEL));
		const source = view && fromDbusView(view);

		expect(source?.kind).toBe("mm-managed");
		expect(source?.ifname).toBe("wwan0");
		expect(source?.status.network).toBe("Movistar");
		expect(source?.status.network_type).toBe("4G");
		expect(source?.stableKey).toBeDefined();
	});

	test("Given a multi-modem tree, When folded, Then wire order is preserved and stable across folds", () => {
		const tree = managedObjectsTree([
			{ path: "/org/freedesktop/ModemManager1/Modem/2", ifname: "wwan1" },
			QUECTEL,
			{ path: "/org/freedesktop/ModemManager1/Modem/9", ifname: "wwan2" },
		]);

		const first = foldDbusModemViews(tree);
		const second = foldDbusModemViews(tree);

		expect(first.map((v) => v.runtimeId)).toEqual([2, 14, 9]);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});
});
