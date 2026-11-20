import { expect, test } from "bun:test";
import { initCellularEvents } from "../modules/events/cellular-events.ts";
import {
	containmentRun,
	containmentScenarios,
	pairedSnapshot,
} from "./helpers/cellular-containment-fixtures.ts";
import {
	KEY_A,
	KEY_B,
	observation,
	radioStatus,
	recordingObservations,
} from "./helpers/cellular-observation-fixtures.ts";

const positions = [
	["first", 0],
	["middle", 1],
	["last", 2],
] as const;
const faults = [
	{ name: "Error", value: new Error("emitter fault") },
	{ name: "non-Error", value: "emitter fault token" },
] as const;

for (const scenario of containmentScenarios) {
	for (const [position, precedingSubscribers] of positions) {
		for (const fault of faults) {
			for (const call of [1, 2]) {
				test(`${scenario.code} contains ${fault.name} on call ${call} with its subscriber ${position}`, () => {
					const control = containmentRun({ scenario, precedingSubscribers });
					const actual = containmentRun({
						scenario,
						precedingSubscribers,
						failure: { call, value: fault.value },
					});
					expect(control.errors).toEqual([]);
					expect(control.attempted.map((event) => event.code)).toEqual(
						scenario.expected.flatMap((code) => [code, code]),
					);
					const expectedStates = scenario.steps.map(pairedSnapshot);
					expect(control.states).toEqual(expectedStates);
					expect(control.subscriberStates).toEqual([
						expectedStates.slice(0, -1),
						expectedStates.slice(0, -1),
					]);
					expect(actual.errors).toEqual([]);
					expect(actual.states).toEqual(expectedStates);
					expect(actual.subscriberStates).toEqual(control.subscriberStates);
					expect(actual.attempted).toEqual(control.attempted);
					expect(actual.delivered).toEqual(
						control.delivered.filter((_, index) => index !== call - 1),
					);
				});
			}
		}
	}
}

for (const fault of faults) {
	for (const call of [1, 2]) {
		test(`startup replay contains ${fault.name} on call ${call} without replaying presence on later updates`, () => {
			const initial = observation({ status: radioStatus() });
			const h = recordingObservations(pairedSnapshot(initial));
			let calls = 0;
			try {
				h.events.length = 0;
				h.onEmit(() => {
					calls++;
					if (calls === call) throw fault.value;
				});
				h.restart();
				h.publish(
					pairedSnapshot({
						...initial,
						status: { ...radioStatus(), signal: 51 },
					}),
				);
				h.publish(
					pairedSnapshot({
						...initial,
						status: radioStatus("connected"),
					}),
				);
				expect(h.events).toEqual([
					{ code: "modem_added", params: { modemKey: KEY_A, name: "Radio A" } },
					{ code: "modem_added", params: { modemKey: KEY_B, name: "Radio B" } },
					{
						code: "modem_connected",
						params: { modemKey: KEY_A, networkType: "LTE", roaming: false },
					},
					{
						code: "modem_connected",
						params: { modemKey: KEY_B, networkType: "LTE", roaming: false },
					},
				]);
			} finally {
				initCellularEvents()();
				h.finish();
			}
		});
	}
}

test("a throwing reentrant output keeps queued facts ordered and never replays their attempts", () => {
	const initial = observation({ status: radioStatus() });
	const connected = { ...initial, status: radioStatus("connected") };
	const h = recordingObservations(pairedSnapshot(initial));
	let calls = 0;
	try {
		h.events.length = 0;
		h.onEmit(() => {
			calls++;
			if (calls === 1) {
				h.publish({
					0: connected,
					1: { ...initial, ifname: "wwan1", name: "Radio B" },
				});
				throw new Error("reentrant emitter fault");
			}
			if (calls === 2) {
				h.publish({
					0: {
						...connected,
						status: { ...radioStatus("connected"), signal: 51 },
					},
					1: {
						...initial,
						ifname: "wwan1",
						name: "Radio B",
						status: { ...radioStatus(), signal: 51 },
					},
				});
			}
		});
		h.publish(pairedSnapshot(connected));
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
	} finally {
		h.finish();
	}
});
