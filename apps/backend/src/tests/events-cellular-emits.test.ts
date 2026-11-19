import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { DeviceEvent } from "@ceraui/rpc/schemas";
import { initCellularEvents } from "../modules/events/cellular-events.ts";
import {
	resetEventEmitterForTest,
	setEventSink,
} from "../modules/events/emit.ts";
import * as identity from "../modules/modems/modem-wire-producer.ts";
import type { Modem } from "../modules/modems/modems-state.ts";
import { setModemsState } from "../modules/modems/state/modems-state-cache.ts";
import type { ModemsState } from "../modules/network/state-types.ts";

const KEY = "platform-xhci-hcd.0.auto-usb-0:1.4";
const BOOT = "66d8d1808694489b8c3a3fb4795cab24";
let events: DeviceEvent[];
let warnings: unknown[][];
let now: number;
let stop: () => void;
let idPath: ReturnType<typeof spyOn<typeof identity, "getModemIdPath">>;

function modem(
	status: Partial<NonNullable<Modem["status"]>> = {},
	fields: Partial<Modem> = {},
): Modem {
	return {
		ifname: "wwan0",
		name: "Test modem",
		sim_network: "Test network",
		network_type: { supported: {}, active: null },
		sim_presence: "present",
		status: {
			connection: "registered",
			network_type: "4G",
			roaming: false,
			signal: 50,
			...status,
		},
		...fields,
	};
}

function publish(snapshot: ModemsState): void {
	now += 31_000;
	setModemsState(snapshot);
}

function records() {
	expect(warnings).toEqual([]);
	return events.map(({ code, params }) => ({ code, params }));
}

beforeEach(() => {
	setModemsState({});
	events = [];
	warnings = [];
	now = 0;
	idPath = spyOn(identity, "getModemIdPath").mockImplementation((ifname) =>
		ifname === "unresolved" ? undefined : `${KEY}:1.4`,
	);
	resetEventEmitterForTest({
		now: () => now,
		bootId: () => BOOT,
		tailSeq: () => 0,
		appendEvent: () => {},
		log: () => {},
		warn: (...args) => warnings.push(args),
		schedule: () => ({ unref() {}, cancel() {} }),
	});
	setEventSink((event) => events.push(event));
	stop = initCellularEvents();
});

afterEach(() => {
	stop();
	idPath.mockRestore();
	resetEventEmitterForTest();
	setModemsState({});
});

test("presence uses the stable key and remembers the latest modem name for removal", () => {
	publish({ 7: modem() });
	publish({ 7: modem({ signal: 51 }, { name: "Renamed modem" }) });
	publish({});
	expect(records()).toEqual([
		{ code: "modem_added", params: { modemKey: KEY, name: "Test modem" } },
		{ code: "modem_removed", params: { modemKey: KEY, name: "Renamed modem" } },
	]);
});

test("ten signal-only updates and operator or roaming changes emit nothing", () => {
	publish({ 7: modem() });
	events.length = 0;
	for (let signal = 60; signal < 70; signal++) {
		publish({ 7: modem({ signal, network: "Other network", roaming: true }) });
	}
	expect(records()).toEqual([]);
});

test("connect then disconnect produces exactly the two connection events", () => {
	publish({ 7: modem() });
	events.length = 0;
	publish({ 7: modem({ connection: "connected", roaming: true }) });
	publish({ 7: modem({ connection: "connected", signal: 70, roaming: true }) });
	publish({ 7: modem({ connection: "disconnecting" }) });
	expect(events.map((event) => event.code)).toEqual([
		"modem_connected",
		"modem_disconnected",
	]);
	publish({ 7: modem({ connection: "registered" }) });
	expect(records()).toEqual([
		{
			code: "modem_connected",
			params: { modemKey: KEY, networkType: "4G", roaming: true },
		},
		{ code: "modem_disconnected", params: { modemKey: KEY } },
	]);
});

test("unknown and omitted SIM reads retain present until a stated removal", () => {
	publish({ 7: modem() });
	events.length = 0;
	publish({ 7: modem({}, { sim_presence: "unknown" }) });
	const unreadable = modem();
	delete unreadable.sim_presence;
	publish({ 7: unreadable });
	publish({ 7: modem() });
	expect(records()).toEqual([]);
	publish({ 7: modem({}, { sim_presence: "absent" }) });
	publish({ 7: modem({}, { sim_presence: "unknown" }) });
	publish({ 7: modem() });
	expect(records()).toEqual([
		{ code: "sim_removed", params: { modemKey: KEY } },
		{ code: "sim_inserted", params: { modemKey: KEY } },
	]);
});

test("a SIM-only change is observable even before status is available", () => {
	const absent = modem({}, { sim_presence: "absent" });
	delete absent.status;
	publish({ 7: absent });
	events.length = 0;
	publish({ 7: { ...absent, sim_presence: "present" } });
	expect(records()).toEqual([
		{ code: "sim_inserted", params: { modemKey: KEY } },
	]);
});

test("a rejection emits its error token once, and may recur after clearing", () => {
	publish({ 7: modem() });
	events.length = 0;
	const rejection = {
		error: "no-cells-in-location-area",
		operator_id: "999999",
	};
	publish({ 7: modem({ registration_rejection: rejection }) });
	publish({
		7: modem({
			registration_rejection: {
				...rejection,
				operator_name: "Changed metadata",
			},
		}),
	});
	publish({ 7: modem() });
	publish({ 7: modem({ registration_rejection: rejection }) });
	expect(records()).toEqual([
		{
			code: "modem_registration_rejected",
			params: { modemKey: KEY, rejection: rejection.error },
		},
		{
			code: "modem_registration_rejected",
			params: { modemKey: KEY, rejection: rejection.error },
		},
	]);
});

test("renumbering a modem preserves its connection and SIM baseline", () => {
	publish({ 7: modem() });
	events.length = 0;
	publish({ 25: modem({ connection: "connected" }, { ifname: "wwan1" }) });
	expect(records()).toEqual([
		{
			code: "modem_connected",
			params: { modemKey: KEY, networkType: "4G", roaming: false },
		},
	]);
});

test("initial connection is a baseline and missing status does not disconnect it", () => {
	publish({ 7: modem({ connection: "connected" }) });
	const unreadable = modem();
	delete unreadable.status;
	publish({ 7: unreadable });
	publish({ 7: modem({ connection: "connected" }) });
	expect(records()).toEqual([
		{ code: "modem_added", params: { modemKey: KEY, name: "Test modem" } },
	]);
});

test("unknown SIM becomes a stated insertion and a changed rejection is recorded", () => {
	publish({ 7: modem({}, { sim_presence: "unknown" }) });
	events.length = 0;
	publish({ 7: modem() });
	publish({
		7: modem({ registration_rejection: { error: "first-rejection" } }),
	});
	publish({
		7: modem({ registration_rejection: { error: "next-rejection" } }),
	});
	expect(records()).toEqual([
		{
			code: "modem_registration_rejected",
			params: { modemKey: KEY, rejection: "first-rejection" },
		},
		{
			code: "modem_registration_rejected",
			params: { modemKey: KEY, rejection: "next-rejection" },
		},
	]);
});

test("an unresolved identity emits no fabricated modem key", () => {
	publish({ 7: modem({}, { ifname: "unresolved" }) });
	publish({ 7: modem({ connection: "connected" }, { ifname: "unresolved" }) });
	publish({});
	expect(records()).toEqual([]);
});

test("stopping and starting owns exactly one subscription and fresh presence", () => {
	const again = initCellularEvents();
	expect(again).toBe(stop);
	publish({ 7: modem() });
	stop();
	publish({});
	publish({ 7: modem({ connection: "connected" }) });
	expect(records()).toEqual([
		{ code: "modem_added", params: { modemKey: KEY, name: "Test modem" } },
	]);
	stop = initCellularEvents();
	expect(records()).toEqual([
		{ code: "modem_added", params: { modemKey: KEY, name: "Test modem" } },
		{ code: "modem_added", params: { modemKey: KEY, name: "Test modem" } },
	]);
});
