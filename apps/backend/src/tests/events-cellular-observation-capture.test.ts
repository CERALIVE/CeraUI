import { expect, test } from "bun:test";
import { initCellularEvents } from "../modules/events/cellular-events.ts";
import {
	KEY_A,
	KEY_B,
	observation,
	radioStatus,
	recordingObservations,
} from "./helpers/cellular-observation-fixtures.ts";

test.each([
	["present", "absent", "sim_removed"],
	["absent", "present", "sim_inserted"],
] as const)(
	"first known SIM %s after an explicit unknown read is only a baseline",
	(first, next, code) => {
		const h = recordingObservations();
		try {
			h.publish({ 0: observation({ sim_presence: "unknown" }) });
			h.events.length = 0;
			h.publish({ 0: observation({ sim_presence: first }) });
			expect(h.events).toEqual([]);
			h.publish({ 0: observation({ sim_presence: next }) });
			expect(h.events).toEqual([{ code, params: { modemKey: KEY_A } }]);
		} finally {
			h.finish();
		}
	},
);

test.each([
	[
		"connected",
		"registered",
		{ code: "modem_disconnected", params: { modemKey: KEY_A } },
	],
	[
		"registered",
		"connected",
		{
			code: "modem_connected",
			params: { modemKey: KEY_A, networkType: "LTE", roaming: false },
		},
	],
] as const)(
	"first known connection %s after unknown status establishes its own baseline",
	(first, next, expected) => {
		const h = recordingObservations();
		try {
			h.publish({
				0: observation({
					status: radioStatus("unknown"),
					sim_presence: "unknown",
				}),
			});
			h.events.length = 0;
			h.publish({
				0: observation({ status: radioStatus(first), sim_presence: "unknown" }),
			});
			expect(h.events).toEqual([]);
			h.publish({
				0: observation({ status: radioStatus(next), sim_presence: "unknown" }),
			});
			expect(h.events).toEqual([expected]);
		} finally {
			h.finish();
		}
	},
);

test("repeated initialization keeps one subscription and records each producer call once", () => {
	const h = recordingObservations();
	try {
		h.publish({ 0: observation({ status: radioStatus() }) });
		h.events.length = 0;
		const stop = initCellularEvents();
		const secondStop = initCellularEvents();
		expect(typeof stop).toBe("function");
		expect(typeof secondStop).toBe("function");
		expect(h.events).toEqual([]);
		h.publish({ 0: observation({ status: radioStatus("connected") }) });
		secondStop();
		h.publish({ 0: observation({ status: radioStatus("registered") }) });
		expect(h.events).toEqual([
			{
				code: "modem_connected",
				params: { modemKey: KEY_A, networkType: "LTE", roaming: false },
			},
		]);
	} finally {
		h.finish();
	}
});

test("ten signal operator and roaming refreshes produce no raw event calls", () => {
	const h = recordingObservations();
	try {
		h.publish({ 0: observation({ status: radioStatus("connected") }) });
		h.events.length = 0;
		for (let signal = 60; signal < 70; signal++) {
			h.publish({
				0: observation({
					status: {
						...radioStatus("connected"),
						signal,
						network: `operator-${signal}`,
						network_type: signal % 2 ? "LTE" : "NR",
						roaming: signal % 2 === 0,
					},
				}),
			});
		}
		expect(h.events).toEqual([]);
	} finally {
		h.finish();
	}
});

test("queued presence keeps its observed name while a reentrant snapshot updates the removal baseline", () => {
	const h = recordingObservations();
	const a = observation({ status: radioStatus() });
	const b = observation({
		ifname: "wwan1",
		name: "Radio B",
		status: radioStatus(),
	});
	let reentered = false;
	try {
		h.onEmit((event) => {
			if (event.code === "modem_added" && !reentered) {
				reentered = true;
				b.name = "Renamed B";
				h.publish({
					1: { ...a, status: { ...radioStatus(), signal: 51 } },
					2: b,
				});
			}
		});
		h.publish({ 1: a, 2: b });
		h.publish({ 1: a });
		expect(h.events).toEqual([
			{ code: "modem_added", params: { modemKey: KEY_A, name: "Radio A" } },
			{ code: "modem_added", params: { modemKey: KEY_B, name: "Radio B" } },
			{ code: "modem_removed", params: { modemKey: KEY_B, name: "Renamed B" } },
		]);
	} finally {
		h.finish();
	}
});

test("connection params capture observed network type and roaming before emission can reenter", () => {
	const h = recordingObservations();
	const a = observation({ status: radioStatus() });
	const b = observation({
		ifname: "wwan1",
		name: "Radio B",
		status: radioStatus(),
	});
	const statusB = {
		...radioStatus("connected"),
		network_type: "NR",
		roaming: true,
	};
	const nextA = { ...a, status: radioStatus("connected") };
	const nextB = { ...b, status: statusB };
	let reentered = false;
	try {
		h.publish({ 1: a, 2: b });
		h.events.length = 0;
		h.onEmit((event) => {
			if (event.code === "modem_connected" && !reentered) {
				reentered = true;
				statusB.network_type = "HSPA";
				statusB.roaming = false;
				statusB.signal = 51;
				h.publish({ 1: nextA, 2: nextB });
			}
		});
		h.publish({ 1: nextA, 2: nextB });
		expect(h.events).toEqual([
			{
				code: "modem_connected",
				params: { modemKey: KEY_A, networkType: "LTE", roaming: false },
			},
			{
				code: "modem_connected",
				params: { modemKey: KEY_B, networkType: "NR", roaming: true },
			},
		]);
	} finally {
		h.finish();
	}
});

test("different known observations received during emission keep their original fact order", () => {
	const h = recordingObservations();
	const a = observation({ status: radioStatus() });
	const b = observation({
		ifname: "wwan1",
		name: "Radio B",
		status: radioStatus(),
	});
	const nextA = { ...a, status: radioStatus("connected") };
	const nextB = { ...b, status: radioStatus("connected") };
	let reentered = false;
	try {
		h.publish({ 1: a, 2: b });
		h.events.length = 0;
		h.onEmit((event) => {
			if (event.code === "modem_connected" && !reentered) {
				reentered = true;
				h.publish({ 1: nextA, 2: b });
			}
		});
		h.publish({ 1: nextA, 2: nextB });
		expect(h.events).toEqual([
			{
				code: "modem_connected",
				params: { modemKey: KEY_A, networkType: "LTE", roaming: false },
			},
			{
				code: "modem_connected",
				params: { modemKey: KEY_B, networkType: "LTE", roaming: false },
			},
			{ code: "modem_disconnected", params: { modemKey: KEY_B } },
		]);
		h.events.length = 0;
		h.publish({
			1: nextA,
			2: { ...b, status: { ...radioStatus(), signal: 51 } },
		});
		expect(h.events).toEqual([]);
	} finally {
		h.finish();
	}
});
