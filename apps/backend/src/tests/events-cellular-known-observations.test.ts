import { expect, test } from "bun:test";
import type { Modem } from "../modules/modems/modems-state.ts";
import {
	KEY_A,
	observation,
	type RecordedCellularEvent,
	radioStatus,
	recordingObservations,
} from "./helpers/cellular-observation-fixtures.ts";

const firstReadings = [
	["SIM present", observation({ sim_presence: "present" })],
	["SIM absent", observation({ sim_presence: "absent" })],
	["connection up", observation({ status: radioStatus("connected") })],
	["connection down", observation({ status: radioStatus("disconnecting") })],
	["registration", observation({ status: radioStatus("registered") })],
	["rejection", observation({ status: radioStatus("registered", "denied") })],
	["rejection clear", observation({ status: radioStatus() })],
] satisfies readonly (readonly [string, Modem])[];

test.each(firstReadings)(
	"first available %s records a baseline without a field event",
	(_, known) => {
		const h = recordingObservations();
		try {
			h.publish({ 0: observation() });
			h.events.length = 0;
			h.publish({ 0: known });
			h.publish({ 0: known });
			expect(h.events).toEqual([]);
		} finally {
			h.finish();
		}
	},
);

test.each(firstReadings)(
	"initial %s and startup replay emit only modem presence",
	(_, known) => {
		const h = recordingObservations({ 0: known });
		try {
			h.publish({ 0: known });
			h.restart();
			expect(h.events).toEqual([
				{ code: "modem_added", params: { modemKey: KEY_A, name: "Radio A" } },
				{ code: "modem_added", params: { modemKey: KEY_A, name: "Radio A" } },
			]);
		} finally {
			h.finish();
		}
	},
);

const gapReadings = [
	{
		name: "SIM present",
		before: observation({ sim_presence: "present" }),
		unknown: observation({ sim_presence: "unknown" }),
		after: observation({ sim_presence: "absent" }),
		expected: { code: "sim_removed", params: { modemKey: KEY_A } },
	},
	{
		name: "SIM with unchanged readable status",
		before: observation({
			status: radioStatus(),
			sim_presence: "present",
		}),
		unknown: observation({
			status: radioStatus(),
			sim_presence: "unknown",
		}),
		after: observation({
			status: radioStatus(),
			sim_presence: "absent",
		}),
		expected: { code: "sim_removed", params: { modemKey: KEY_A } },
	},
	{
		name: "SIM absent",
		before: observation({ sim_presence: "absent" }),
		unknown: observation(),
		after: observation({ sim_presence: "present" }),
		expected: { code: "sim_inserted", params: { modemKey: KEY_A } },
	},
	{
		name: "connected",
		before: observation({ status: radioStatus("connected") }),
		unknown: observation(),
		after: observation({ status: radioStatus("registered") }),
		expected: { code: "modem_disconnected", params: { modemKey: KEY_A } },
	},
	{
		name: "disconnected",
		before: observation({ status: radioStatus("registered") }),
		unknown: observation({ status: radioStatus("unknown") }),
		after: observation({ status: radioStatus("connected") }),
		expected: {
			code: "modem_connected",
			params: { modemKey: KEY_A, networkType: "LTE", roaming: false },
		},
	},
	{
		name: "rejection token",
		before: observation({ status: radioStatus("registered", "denied-a") }),
		unknown: observation(),
		after: observation({ status: radioStatus("registered", "denied-b") }),
		expected: {
			code: "modem_registration_rejected",
			params: { modemKey: KEY_A, rejection: "denied-b" },
		},
	},
	{
		name: "known clear rejection",
		before: observation({ status: radioStatus() }),
		unknown: observation(),
		after: observation({ status: radioStatus("registered", "denied") }),
		expected: {
			code: "modem_registration_rejected",
			params: { modemKey: KEY_A, rejection: "denied" },
		},
	},
] satisfies readonly {
	readonly name: string;
	readonly before: Modem;
	readonly unknown: Modem;
	readonly after: Modem;
	readonly expected: RecordedCellularEvent;
}[];

test.each(gapReadings)(
	"$name survives unknown gaps and emits only a different known value",
	({ before, unknown, after, expected }) => {
		const h = recordingObservations();
		try {
			h.publish({ 0: before });
			h.events.length = 0;
			h.publish({ 0: unknown });
			h.publish({ 0: before });
			expect(h.events).toEqual([]);
			h.publish({ 0: unknown });
			h.publish({ 0: after });
			expect(h.events).toEqual([expected]);
		} finally {
			h.finish();
		}
	},
);

test("unknown and empty connection reads retain a known connected baseline", () => {
	const h = recordingObservations();
	try {
		h.publish({ 0: observation({ status: radioStatus("connected") }) });
		h.events.length = 0;
		for (const connection of ["unknown", "", "connected"]) {
			h.publish({ 0: observation({ status: radioStatus(connection) }) });
		}
		expect(h.events).toEqual([]);
		h.publish({ 0: observation({ status: radioStatus("disconnecting") }) });
		expect(h.events).toEqual([
			{ code: "modem_disconnected", params: { modemKey: KEY_A } },
		]);
	} finally {
		h.finish();
	}
});

test("rejection read failures cannot clear a token but a positive clear permits a new rejection", () => {
	const h = recordingObservations();
	try {
		const denied = observation({ status: radioStatus("registered", "denied") });
		h.publish({ 0: observation({ status: radioStatus() }) });
		h.events.length = 0;
		h.publish({ 0: denied });
		h.publish({ 0: observation() });
		h.publish({ 0: denied });
		h.publish({
			0: {
				...denied,
				status: { ...radioStatus("registered", "denied"), signal: 51 },
			},
		});
		expect(h.events).toEqual([
			{
				code: "modem_registration_rejected",
				params: { modemKey: KEY_A, rejection: "denied" },
			},
		]);
		h.publish({ 0: observation({ status: radioStatus() }) });
		h.publish({ 0: observation() });
		h.publish({ 0: denied });
		expect(h.events).toEqual([
			{
				code: "modem_registration_rejected",
				params: { modemKey: KEY_A, rejection: "denied" },
			},
			{
				code: "modem_registration_rejected",
				params: { modemKey: KEY_A, rejection: "denied" },
			},
		]);
	} finally {
		h.finish();
	}
});
