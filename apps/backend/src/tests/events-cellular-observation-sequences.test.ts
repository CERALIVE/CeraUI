import { expect, test } from "bun:test";
import {
	KEY_A,
	KEY_B,
	observation,
	radioStatus,
	recordingObservations,
} from "./helpers/cellular-observation-fixtures.ts";

test("prefix-similar modem identities retain independent field baselines through unknown gaps", () => {
	const h = recordingObservations();
	const a = observation({ status: radioStatus(), sim_presence: "present" });
	const b = observation({
		ifname: "wwan1",
		name: "Radio B",
		status: radioStatus("connected", "denied-b"),
		sim_presence: "absent",
	});
	try {
		h.publish({ 1: a, 2: b });
		h.events.length = 0;
		h.publish({ 1: observation({ sim_presence: "unknown" }), 2: b });
		const changedA = observation({
			status: radioStatus("connected", "denied-a"),
			sim_presence: "absent",
		});
		h.publish({ 1: changedA, 2: b });
		expect(h.events).toEqual([
			{
				code: "modem_connected",
				params: { modemKey: KEY_A, networkType: "LTE", roaming: false },
			},
			{
				code: "modem_registration_rejected",
				params: { modemKey: KEY_A, rejection: "denied-a" },
			},
			{ code: "sim_removed", params: { modemKey: KEY_A } },
		]);
		h.events.length = 0;
		const changedB = {
			...b,
			status: radioStatus(),
			sim_presence: "present" as const,
		};
		h.publish({ 1: changedA, 2: changedB });
		expect(h.events).toEqual([
			{ code: "modem_disconnected", params: { modemKey: KEY_B } },
			{ code: "sim_inserted", params: { modemKey: KEY_B } },
		]);
		h.events.length = 0;
		h.publish({
			71: changedA,
			99: { ...changedB, status: radioStatus("registered", "denied-b") },
		});
		expect(h.events).toEqual([
			{
				code: "modem_registration_rejected",
				params: { modemKey: KEY_B, rejection: "denied-b" },
			},
		]);
	} finally {
		h.finish();
	}
});

test("rapid successive known transitions are recorded before the real emitter can coalesce them", () => {
	const h = recordingObservations();
	try {
		h.publish({
			0: observation({ status: radioStatus(), sim_presence: "present" }),
		});
		h.events.length = 0;
		h.publish({
			0: observation({
				status: radioStatus("connected", "denied"),
				sim_presence: "absent",
			}),
		});
		h.publish({ 0: observation({ sim_presence: "unknown" }) });
		h.publish({
			0: observation({
				status: radioStatus("connected", "denied"),
				sim_presence: "absent",
			}),
		});
		expect(h.events).toEqual([
			{
				code: "modem_connected",
				params: { modemKey: KEY_A, networkType: "LTE", roaming: false },
			},
			{
				code: "modem_registration_rejected",
				params: { modemKey: KEY_A, rejection: "denied" },
			},
			{ code: "sim_removed", params: { modemKey: KEY_A } },
		]);
		h.events.length = 0;
		h.publish({
			0: observation({ status: radioStatus(), sim_presence: "present" }),
		});
		h.publish({
			0: observation({
				status: radioStatus("registered", "denied"),
				sim_presence: "present",
			}),
		});
		expect(h.events).toEqual([
			{ code: "modem_disconnected", params: { modemKey: KEY_A } },
			{ code: "sim_inserted", params: { modemKey: KEY_A } },
			{
				code: "modem_registration_rejected",
				params: { modemKey: KEY_A, rejection: "denied" },
			},
		]);
	} finally {
		h.finish();
	}
});

test("all modem baselines are published before an emitter reenters with a signal-only snapshot", () => {
	const h = recordingObservations();
	const a = observation({ status: radioStatus() });
	const b = observation({
		ifname: "wwan1",
		name: "Radio B",
		status: radioStatus(),
	});
	const nextA = { ...a, status: radioStatus("connected") };
	const nextB = {
		...b,
		status: { ...radioStatus("connected"), network_type: "NR" },
	};
	let reentered = false;
	try {
		h.publish({ 1: a, 2: b });
		h.events.length = 0;
		h.onEmit((event) => {
			if (event.code === "modem_connected" && !reentered) {
				reentered = true;
				h.publish({
					1: { ...nextA, status: { ...nextA.status, signal: 51 } },
					2: { ...nextB, status: { ...nextB.status, signal: 51 } },
				});
			}
		});
		h.publish({ 1: nextA, 2: nextB });
		expect(reentered).toBe(true);
		expect(h.events).toEqual([
			{
				code: "modem_connected",
				params: { modemKey: KEY_A, networkType: "LTE", roaming: false },
			},
			{
				code: "modem_connected",
				params: { modemKey: KEY_B, networkType: "NR", roaming: false },
			},
		]);
	} finally {
		h.finish();
	}
});

test("removal retires only that exact identity and re-addition starts fresh field baselines", () => {
	const h = recordingObservations();
	const a = observation({
		status: radioStatus("connected"),
		sim_presence: "present",
	});
	const b = observation({
		ifname: "wwan1",
		name: "Radio B",
		status: radioStatus("connected"),
	});
	try {
		h.publish({ 1: a, 2: b });
		h.events.length = 0;
		h.publish({ 2: b });
		h.publish({
			7: observation({ status: radioStatus(), sim_presence: "absent" }),
			2: b,
		});
		expect(h.events).toEqual([
			{ code: "modem_removed", params: { modemKey: KEY_A, name: "Radio A" } },
			{ code: "modem_added", params: { modemKey: KEY_A, name: "Radio A" } },
		]);
		h.events.length = 0;
		h.publish({ 7: a, 2: b });
		expect(h.events).toEqual([
			{
				code: "modem_connected",
				params: { modemKey: KEY_A, networkType: "LTE", roaming: false },
			},
			{ code: "sim_inserted", params: { modemKey: KEY_A } },
		]);
	} finally {
		h.finish();
	}
});

test("registration changes and unresolved modem rows create no cellular facts", () => {
	const h = recordingObservations();
	try {
		h.publish({ 0: observation({ status: radioStatus("searching") }) });
		h.events.length = 0;
		for (const connection of ["registered", "connecting", "registered"]) {
			h.publish({
				0: observation({ status: radioStatus(connection) }),
				1: observation({
					ifname: "unresolved",
					status: radioStatus("connected", "denied"),
					sim_presence: "present",
				}),
			});
		}
		expect(h.events).toEqual([]);
	} finally {
		h.finish();
	}
});
