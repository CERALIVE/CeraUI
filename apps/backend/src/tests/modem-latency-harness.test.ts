import { describe, expect, test } from "bun:test";

import {
	type CycleWindow,
	deriveCycleMilestones,
	type UdevEpochEvent,
	type WsRowEvent,
} from "../../scripts/lib/latency-derive.ts";
import {
	budgetsAllGreen,
	evaluateBudgets,
	INTERVAL_SPECS,
	intervalMs,
	median,
	renderTable,
	summarizeCycles,
} from "../../scripts/lib/latency-report.ts";
import {
	type BusctlSignal,
	mmIndexFromObjectPath,
	parseBusctlSignals,
	parseBusctlTimestamp,
	parseUdevMonitorEvents,
	parseWireKeyAsMmIndex,
	snapshotModemRows,
	udevEventEpochMs,
} from "../../scripts/lib/latency-sources.ts";

// Captured verbatim from `udevadm monitor --property --udev
// --subsystem-match=usb/usb_device` on the bench board during a real
// SIM7600 power cycle — trimmed to the properties the harness reads.
const UDEV_CAPTURE = `UDEV  [14300.104606] remove   /devices/platform/fc400000.usb/xhci-hcd.0.auto/usb1/1-1/1-1.3/1-1.3.4 (usb)
ACTION=remove
SUBSYSTEM=usb
DEVTYPE=usb_device
ID_PATH=platform-xhci-hcd.0.auto-usb-0:1.3.4

UDEV  [14311.245323] add      /devices/platform/fc400000.usb/xhci-hcd.0.auto/usb1/1-1/1-1.3/1-1.3.4 (usb)
ACTION=add
SUBSYSTEM=usb
DEVTYPE=usb_device
ID_VENDOR_ID=1e0e
ID_PATH=platform-xhci-hcd.0.auto-usb-0:1.3.4

UDEV  [14311.246629] change   /devices/platform/fc400000.usb/xhci-hcd.0.auto/usb1/1-1/1-1.3/1-1.3.4 (usb)
ACTION=change
SUBSYSTEM=usb
DEVTYPE=usb_interface
ID_PATH=platform-xhci-hcd.0.auto-usb-0:1.3.4
`;

// Captured verbatim from `busctl --system monitor
// org.freedesktop.ModemManager1` during the same cycle.
const BUSCTL_CAPTURE = `Monitoring bus message stream.
‣ Type=signal  Endian=l  Flags=1  Version=1 Cookie=245  Timestamp="Tue 2026-08-18 00:50:30.222556 UTC"
  Sender=:1.8  Path=/org/freedesktop/ModemManager1  Interface=org.freedesktop.DBus.ObjectManager  Member=InterfacesRemoved
  MESSAGE "oas" {
          OBJECT_PATH "/org/freedesktop/ModemManager1/Modem/2";
  };

‣ Type=signal  Endian=l  Flags=1  Version=1 Cookie=246  Timestamp="Tue 2026-08-18 00:51:10.462655 UTC"
  Sender=:1.8  Path=/org/freedesktop/ModemManager1  Interface=org.freedesktop.DBus.ObjectManager  Member=InterfacesAdded
  MESSAGE "oa{sa{sv}}" {
          OBJECT_PATH "/org/freedesktop/ModemManager1/Modem/5";
  };

‣ Type=method_call  Endian=l  Flags=0  Version=1 Cookie=99  Timestamp="Tue 2026-08-18 00:51:11.000000 UTC"
  Sender=:1.42  Path=/org/freedesktop/ModemManager1  Interface=org.freedesktop.DBus.ObjectManager  Member=GetManagedObjects
  MESSAGE "" {
  };

‣ Type=signal  Endian=l  Flags=1  Version=1 Cookie=247  Timestamp="Tue 2026-08-18 00:51:12.100000 UTC"
  Sender=:1.8  Path=/org/freedesktop/ModemManager1/Modem/5  Interface=org.freedesktop.DBus.Properties  Member=PropertiesChanged
  MESSAGE "sa{sv}as" {
          STRING "org.freedesktop.ModemManager1.Modem";
  };
`;

describe("udev capture reading", () => {
	test("decodes each usb_device block by its properties", () => {
		const events = parseUdevMonitorEvents(UDEV_CAPTURE);

		expect(events).toHaveLength(3);
		expect(events[0]?.action).toBe("remove");
		expect(events[0]?.monotonicSec).toBeCloseTo(14300.104606, 5);
		expect(events[1]?.action).toBe("add");
		expect(events[1]?.properties.get("ID_PATH")).toBe(
			"platform-xhci-hcd.0.auto-usb-0:1.3.4",
		);
		expect(events[2]?.properties.get("DEVTYPE")).toBe("usb_interface");
	});

	test("projects a monotonic header onto the epoch axis", () => {
		const [remove] = parseUdevMonitorEvents(UDEV_CAPTURE);
		expect(remove).toBeDefined();
		if (!remove) return;

		expect(udevEventEpochMs(remove, 1_000_000)).toBeCloseTo(
			1_000_000 + 14300.104606 * 1000,
			2,
		);
	});

	test("drops a block whose header timestamp is unreadable", () => {
		const [event] = parseUdevMonitorEvents("ACTION=add\nDEVTYPE=usb_device\n");
		expect(event?.monotonicSec).toBeNull();
		expect(event ? udevEventEpochMs(event, 1000) : "missing").toBeNull();
	});
});

describe("busctl capture reading", () => {
	test("reads the bus's own microsecond timestamp, not read time", () => {
		const epochMs = parseBusctlTimestamp(
			'Cookie=246  Timestamp="Tue 2026-08-18 00:51:10.462655 UTC"',
		);
		expect(epochMs).toBeCloseTo(
			Date.parse("2026-08-18T00:51:10.462Z") + 0.655,
			2,
		);
	});

	test("decodes each signal with its member, interface and object path", () => {
		const signals = parseBusctlSignals(BUSCTL_CAPTURE);

		expect(signals.map((entry) => entry.member)).toEqual([
			"InterfacesRemoved",
			"InterfacesAdded",
			"PropertiesChanged",
		]);
		expect(signals).toHaveLength(3);
		expect(signals[0]?.member).toBe("InterfacesRemoved");
		expect(signals[1]?.member).toBe("InterfacesAdded");
		expect(signals[1]?.objectPath).toBe(
			"/org/freedesktop/ModemManager1/Modem/5",
		);
		expect(signals[2]?.senderPath).toBe(
			"/org/freedesktop/ModemManager1/Modem/5",
		);
		expect(signals[2]?.interfaceName).toBe("org.freedesktop.DBus.Properties");
	});

	test("resolves the MM index behind an object path", () => {
		expect(
			mmIndexFromObjectPath("/org/freedesktop/ModemManager1/Modem/5"),
		).toBe(5);
		expect(mmIndexFromObjectPath("/org/freedesktop/NetworkManager")).toBeNull();
	});
});

describe("status.modems row reading", () => {
	test("separates a provisional row from an authoritative one", () => {
		const rows = snapshotModemRows({
			"5": { model: "SIM7600", device_class: "mm" },
			"6": { availability_reason: "modem_initializing" },
			"1000": { device_class: "router-ethernet", name: "E3372" },
		});

		expect(rows.get("5")?.provisional).toBe(false);
		expect(rows.get("5")?.mmIndex).toBe(5);
		expect(rows.get("6")?.provisional).toBe(true);
		expect(rows.get("1000")?.routerBacked).toBe(true);
		expect(rows.get("1000")?.mmIndex).toBeNull();
	});

	test("keys by stable_key when the build emits one", () => {
		const rows = snapshotModemRows({
			"5": { stable_key: "usb-0:1.3.4", device_class: "mm" },
		});
		expect([...rows.keys()]).toEqual(["usb-0:1.3.4"]);
		expect(rows.get("usb-0:1.3.4")?.wireKey).toBe("5");
	});

	test("treats a synthetic id as a non-MM row", () => {
		expect(parseWireKeyAsMmIndex("5")).toBe(5);
		expect(parseWireKeyAsMmIndex("1000")).toBeNull();
		expect(parseWireKeyAsMmIndex("router-cellular:eth1")).toBeNull();
	});
});

const BOOT = 1_000_000_000_000;
const T = (offsetSec: number): number => BOOT + offsetSec * 1000;

function udevEvent(
	action: string,
	offsetSec: number,
	idPath = "usb-0:1.3.4",
): UdevEpochEvent {
	return { epochMs: T(offsetSec), action, devtype: "usb_device", idPath };
}

function signal(
	member: string,
	offsetSec: number,
	overrides: Partial<BusctlSignal> = {},
): BusctlSignal {
	return {
		epochMs: T(offsetSec),
		interfaceName:
			member === "PropertiesChanged"
				? "org.freedesktop.DBus.Properties"
				: "org.freedesktop.DBus.ObjectManager",
		member,
		objectPath:
			member === "PropertiesChanged"
				? null
				: "/org/freedesktop/ModemManager1/Modem/5",
		senderPath:
			member === "PropertiesChanged"
				? "/org/freedesktop/ModemManager1/Modem/5"
				: "/org/freedesktop/ModemManager1",
		...overrides,
	};
}

function wsEvent(offsetSec: number, modems: unknown): WsRowEvent {
	return { epochMs: T(offsetSec), rows: snapshotModemRows(modems) };
}

describe("cycle milestone derivation", () => {
	const preRows = snapshotModemRows({
		"2": { model: "SIM7600", device_class: "mm" },
	});
	const window: CycleWindow = {
		cycle: 1,
		startMs: T(0),
		endMs: T(60),
		preRows,
	};

	test("derives the full post-todo-18 timeline", () => {
		const milestones = deriveCycleMilestones(
			window,
			[udevEvent("remove", 1), udevEvent("add", 12)],
			[signal("InterfacesAdded", 30), signal("PropertiesChanged", 35)],
			[
				wsEvent(2, {}),
				wsEvent(12.4, {
					"9000": { availability_reason: "modem_initializing" },
				}),
				wsEvent(30.5, { "5": { model: "SIM7600", state: "searching" } }),
				wsEvent(35.4, { "5": { model: "SIM7600", state: "registered" } }),
			],
		);

		expect(milestones.idPath).toBe("usb-0:1.3.4");
		expect(milestones.mmIndex).toBe(5);
		expect(milestones.times.udev_remove).toBe(T(1));
		expect(milestones.times.row_removed).toBe(T(2));
		expect(milestones.times.udev_add).toBe(T(12));
		expect(milestones.times.row_provisional).toBe(T(12.4));
		expect(milestones.times.mm_export).toBe(T(30));
		expect(milestones.times.row_authoritative).toBe(T(30.5));
		expect(milestones.times.row_property_update).toBe(T(35.4));
		expect(milestones.notes).toEqual([]);
	});

	// The bench capture that exposed the fixed-baseline defect: on a real board a
	// frame arrives within a few ms of the udev event that caused it, and the two
	// timestamps come from DIFFERENT clocks — so the causing frame can sort just
	// BEFORE its own cause. A snapshot-diff derivation adopted that frame as the
	// baseline and reported an 11 s removal for a device that vanished in 0 ms.
	test("scores a frame that arrives a hair BEFORE the event it answers", () => {
		const milestones = deriveCycleMilestones(
			window,
			[udevEvent("remove", 1.07), udevEvent("add", 12.37)],
			[signal("InterfacesAdded", 41.74)],
			[
				wsEvent(1.065, {}),
				wsEvent(12.365, {
					prov: { availability_reason: "modem_initializing" },
				}),
				wsEvent(41.735, {
					prov: { availability_reason: "modem_initializing" },
					"5": { model: "SIM7600" },
				}),
			],
		);

		expect(milestones.times.row_removed).toBe(T(1.065));
		expect(milestones.times.row_provisional).toBe(T(12.365));
		expect(milestones.times.row_authoritative).toBe(T(41.735));
		expect(intervalMs(milestones, specById("removal"))).toBe(0);
		expect(intervalMs(milestones, specById("optimistic_row"))).toBe(0);
		expect(intervalMs(milestones, specById("authoritative_row"))).toBe(0);
	});

	test("refuses a span more negative than the clock-skew tolerance", () => {
		const milestones = deriveCycleMilestones(
			window,
			[udevEvent("remove", 1), udevEvent("add", 30)],
			[signal("InterfacesAdded", 40)],
			[wsEvent(2, {}), wsEvent(20, { "5": { model: "SIM7600" } })],
		);

		expect(milestones.times.row_authoritative).toBeUndefined();
	});

	test("an observe-only window reports no plug-cycle notes", () => {
		const milestones = deriveCycleMilestones(
			{ ...window, observeOnly: true },
			[],
			[signal("PropertiesChanged", 10)],
			[
				wsEvent(5, { "5": { model: "SIM7600", state: "searching" } }),
				wsEvent(11, { "5": { model: "SIM7600", state: "registered" } }),
			],
		);

		expect(milestones.times.mm_properties_changed).toBe(T(10));
		expect(milestones.times.row_property_update).toBe(T(11));
		expect(milestones.notes).toEqual([]);
	});

	test("skips a PropertiesChanged that changed nothing on the wire", () => {
		const milestones = deriveCycleMilestones(
			{ ...window, observeOnly: true },
			[],
			[signal("PropertiesChanged", 10), signal("PropertiesChanged", 20)],
			[
				wsEvent(5, { "5": { model: "SIM7600", state: "searching" } }),
				wsEvent(11, { "5": { model: "SIM7600", state: "searching" } }),
				wsEvent(21, { "5": { model: "SIM7600", state: "registered" } }),
			],
		);

		expect(milestones.times.mm_properties_changed).toBe(T(20));
		expect(milestones.times.row_property_update).toBe(T(21));
	});

	test("leaves the optimistic milestone absent on a pre-todo-18 build", () => {
		const milestones = deriveCycleMilestones(
			window,
			[udevEvent("remove", 1), udevEvent("add", 12)],
			[signal("InterfacesAdded", 30)],
			[wsEvent(2, {}), wsEvent(45, { "5": { model: "SIM7600" } })],
		);

		expect(milestones.times.row_provisional).toBeUndefined();
		expect(milestones.times.row_authoritative).toBe(T(45));
		expect(intervalMs(milestones, specById("optimistic_row"))).toBeNull();
		expect(intervalMs(milestones, specById("authoritative_row"))).toBe(15_000);
	});

	// A pre-todo-17 build leaves a GHOST row behind — the modem's previous MM
	// index, still on the wire while MM has already re-exported the device under
	// a fresh one. The ghost must never be credited as this cycle's authoritative
	// row, and the real row under the newly-exported index must be.
	test("ignores a row that appeared before the milestone it is measured from", () => {
		const milestones = deriveCycleMilestones(
			window,
			[udevEvent("remove", 1), udevEvent("add", 12)],
			[signal("InterfacesAdded", 30)],
			[
				wsEvent(2, {}),
				wsEvent(5, { "9": { model: "ghost" } }),
				wsEvent(31, { "9": { model: "ghost" }, "5": { model: "SIM7600" } }),
			],
		);

		expect(milestones.times.row_authoritative).toBe(T(31));
	});

	test("does not match an add on a different physical port", () => {
		const milestones = deriveCycleMilestones(
			window,
			[udevEvent("remove", 1), udevEvent("add", 12, "usb-0:1.4.1")],
			[],
			[wsEvent(2, {})],
		);

		expect(milestones.times.udev_add).toBeUndefined();
		expect(milestones.notes).toContain(
			"no udev add observed — the device did not re-enumerate",
		);
	});

	test("never scores a router row as an MM authoritative row", () => {
		const milestones = deriveCycleMilestones(
			window,
			[udevEvent("remove", 1), udevEvent("add", 12)],
			[signal("InterfacesAdded", 30)],
			[
				wsEvent(2, {}),
				wsEvent(31, { "1001": { device_class: "router-ethernet" } }),
			],
		);

		expect(milestones.times.row_authoritative).toBeUndefined();
	});
});

function specById(id: string) {
	const spec = INTERVAL_SPECS.find((candidate) => candidate.id === id);
	if (!spec) throw new Error(`unknown interval ${id}`);
	return spec;
}

describe("statistics and budgets", () => {
	test("medians an odd and an even sample set", () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 2, 3])).toBe(2.5);
		expect(median([])).toBeNull();
	});

	test("summarises only the intervals that produced samples", () => {
		const cycles = [
			{
				cycle: 1,
				idPath: null,
				mmIndex: 5,
				times: { udev_remove: 0, row_removed: 400 },
				notes: [],
			},
			{
				cycle: 2,
				idPath: null,
				mmIndex: 5,
				times: { udev_remove: 0, row_removed: 800 },
				notes: [],
			},
		];

		const summaries = summarizeCycles(cycles);
		const removal = summaries.find((entry) => entry.id === "removal");
		const optimistic = summaries.find((entry) => entry.id === "optimistic_row");

		expect(removal?.medianMs).toBe(600);
		expect(removal?.maxMs).toBe(800);
		expect(optimistic?.samples).toEqual([]);
		expect(optimistic?.medianMs).toBeNull();
	});

	test("reports an unmeasured budget as neither pass nor fail", () => {
		const summaries = summarizeCycles([
			{
				cycle: 1,
				idPath: null,
				mmIndex: null,
				times: { udev_remove: 0, row_removed: 400 },
				notes: [],
			},
		]);
		const verdicts = evaluateBudgets(summaries, {
			removal: 2000,
			optimistic_row: 1000,
		});

		expect(verdicts.find((v) => v.id === "removal")?.pass).toBe(true);
		expect(verdicts.find((v) => v.id === "optimistic_row")?.pass).toBeNull();
		expect(budgetsAllGreen(verdicts)).toBe(false);
	});

	test("fails a budget the median exceeds", () => {
		const summaries = summarizeCycles([
			{
				cycle: 1,
				idPath: null,
				mmIndex: null,
				times: { udev_remove: 0, row_removed: 5000 },
				notes: [],
			},
		]);
		const verdicts = evaluateBudgets(summaries, { removal: 2000 });

		expect(verdicts[0]?.pass).toBe(false);
		expect(verdicts[0]?.reason).toContain("EXCEEDS");
		expect(budgetsAllGreen(verdicts)).toBe(false);
	});

	test("never asserts an exempt interval", () => {
		expect(specById("mm_probe").exempt).toBe(true);
		expect(specById("end_to_end").exempt).toBe(true);
	});

	test("pads every table column to its widest cell", () => {
		const rendered = renderTable(["a", "bbbb"], [["cccc", "d"]]);
		expect(rendered.split("\n")).toEqual([
			"| a    | bbbb |",
			"| ---- | ---- |",
			"| cccc | d    |",
		]);
	});
});
