import type { EventCode } from "@ceraui/rpc/events";
import type { Modem } from "../../modules/modems/modems-state.ts";
import {
	getModemsState,
	onModemsChange,
	setModemsState,
} from "../../modules/modems/state/modems-state-cache.ts";
import type { ModemsState } from "../../modules/network/state-types.ts";
import {
	observation,
	type RecordedCellularEvent,
	radioStatus,
	recordingObservations,
} from "./cellular-observation-fixtures.ts";

const registered = observation({
	status: radioStatus(),
	sim_presence: "present",
});
const connected = { ...registered, status: radioStatus("connected") };
const absent = { ...registered, sim_presence: "absent" as const };
const unknown = observation({ sim_presence: "unknown" });
const denied = { ...registered, status: radioStatus("registered", "denied") };
const changed = {
	...registered,
	status: radioStatus("registered", "denied-next"),
};
const quietRegistered = {
	...registered,
	status: { ...radioStatus(), signal: 51 },
};
const quietConnected = {
	...connected,
	status: { ...radioStatus("connected"), signal: 51 },
};
const quietChanged = {
	...changed,
	status: { ...radioStatus("registered", "denied-next"), signal: 51 },
};
const quietAbsent = { ...quietRegistered, sim_presence: "absent" as const };

export const containmentScenarios = [
	{
		code: "modem_added",
		initial: undefined,
		steps: [
			unknown,
			registered,
			unknown,
			registered,
			connected,
			quietConnected,
			quietConnected,
		],
		expected: ["modem_added", "modem_connected"],
	},
	{
		code: "modem_removed",
		initial: registered,
		steps: [
			undefined,
			unknown,
			registered,
			unknown,
			registered,
			connected,
			quietConnected,
			quietConnected,
		],
		expected: ["modem_removed", "modem_added", "modem_connected"],
	},
	{
		code: "modem_connected",
		initial: registered,
		steps: [
			connected,
			unknown,
			connected,
			registered,
			quietRegistered,
			quietRegistered,
		],
		expected: ["modem_connected", "modem_disconnected"],
	},
	{
		code: "modem_disconnected",
		initial: connected,
		steps: [
			registered,
			unknown,
			registered,
			connected,
			quietConnected,
			quietConnected,
		],
		expected: ["modem_disconnected", "modem_connected"],
	},
	{
		code: "modem_registration_rejected",
		initial: registered,
		steps: [
			denied,
			unknown,
			denied,
			changed,
			registered,
			unknown,
			changed,
			quietChanged,
			quietChanged,
		],
		expected: [
			"modem_registration_rejected",
			"modem_registration_rejected",
			"modem_registration_rejected",
		],
	},
	{
		code: "sim_inserted",
		initial: absent,
		steps: [registered, unknown, registered, absent, quietAbsent, quietAbsent],
		expected: ["sim_inserted", "sim_removed"],
	},
	{
		code: "sim_removed",
		initial: registered,
		steps: [
			absent,
			unknown,
			absent,
			registered,
			quietRegistered,
			quietRegistered,
		],
		expected: ["sim_removed", "sim_inserted"],
	},
] satisfies readonly {
	readonly code: EventCode;
	readonly initial: Modem | undefined;
	readonly steps: readonly (Modem | undefined)[];
	readonly expected: readonly EventCode[];
}[];

export function pairedSnapshot(row: Modem | undefined): ModemsState {
	return row === undefined
		? {}
		: { 0: row, 1: { ...row, ifname: "wwan1", name: "Radio B" } };
}

export function containmentRun(options: {
	readonly scenario: (typeof containmentScenarios)[number];
	readonly precedingSubscribers: number;
	readonly failure?: { readonly call: number; readonly value: unknown };
}) {
	setModemsState({});
	const subscriberStates: ModemsState[][] = [[], []];
	const stops: Array<() => void> = [];
	const subscribe = (index: number) => {
		const states = subscriberStates[index];
		if (states === undefined) throw new RangeError("Unknown subscriber");
		stops.push(
			onModemsChange(() => states.push(structuredClone(getModemsState()))),
		);
	};
	for (let index = 0; index < options.precedingSubscribers; index++)
		subscribe(index);
	const h = recordingObservations();
	for (let index = options.precedingSubscribers; index < 2; index++)
		subscribe(index);
	const states: ModemsState[] = [];
	const errors: unknown[] = [];
	const delivered: RecordedCellularEvent[] = [];
	let calls = 0;
	try {
		h.publish(pairedSnapshot(options.scenario.initial));
		h.events.length = 0;
		for (const snapshots of subscriberStates) snapshots.length = 0;
		h.onEmit((event) => {
			calls++;
			if (calls === options.failure?.call) throw options.failure.value;
			delivered.push(event);
		});
		for (const row of options.scenario.steps) {
			try {
				h.publish(pairedSnapshot(row));
			} catch (error) {
				errors.push(error);
			}
			states.push(structuredClone(getModemsState()));
		}
		return {
			attempted: [...h.events],
			delivered,
			errors,
			states,
			subscriberStates,
		};
	} finally {
		for (const stop of stops) stop();
		h.finish();
	}
}
