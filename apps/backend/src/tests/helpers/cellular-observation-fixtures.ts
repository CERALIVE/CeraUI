import { expect, spyOn } from "bun:test";
import { EVENT_REGISTRY, type EventCode } from "@ceraui/rpc/events";
import { initCellularEvents } from "../../modules/events/cellular-events.ts";
import * as emitter from "../../modules/events/emit.ts";
import * as identity from "../../modules/modems/modem-wire-producer.ts";
import type { Modem } from "../../modules/modems/modems-state.ts";
import { setModemsState } from "../../modules/modems/state/modems-state-cache.ts";
import type { ModemsState } from "../../modules/network/state-types.ts";

export const KEY_A = "platform-xhci-hcd.0.auto-usb-0:1.4";
export const KEY_B = `${KEY_A}.1`;

export type RecordedCellularEvent = {
	readonly code: EventCode;
	readonly params: unknown;
};

export function observation(fields: Partial<Modem> = {}): Modem {
	return {
		ifname: "wwan0",
		name: "Radio A",
		sim_network: "private-carrier",
		network_type: { supported: {}, active: null },
		...fields,
	};
}

export function radioStatus(
	connection = "registered",
	rejection?: string,
): NonNullable<Modem["status"]> {
	return {
		connection,
		network_type: "LTE",
		signal: 50,
		roaming: false,
		...(rejection === undefined
			? {}
			: { registration_rejection: { error: rejection } }),
	};
}

export function recordingObservations(initial: ModemsState = {}) {
	setModemsState(initial);
	const events: RecordedCellularEvent[] = [];
	let afterEmit: ((event: RecordedCellularEvent) => void) | undefined;
	const ids = spyOn(identity, "getModemIdPath").mockImplementation((ifname) => {
		const key =
			ifname === "wwan0" ? KEY_A : ifname === "wwan1" ? KEY_B : undefined;
		return key === undefined ? undefined : `${key}:1.4`;
	});
	const emit = spyOn(emitter, "emitEvent").mockImplementation(
		(code, params) => {
			const event = { code, params: structuredClone(params) };
			events.push(event);
			expect(EVENT_REGISTRY[code].params.safeParse(params).success).toBe(true);
			afterEmit?.(event);
		},
	);
	let stop = initCellularEvents();
	return {
		events,
		publish: setModemsState,
		onEmit(callback: (event: RecordedCellularEvent) => void) {
			afterEmit = callback;
		},
		restart() {
			stop();
			stop = initCellularEvents();
			return stop;
		},
		finish() {
			stop();
			emit.mockRestore();
			ids.mockRestore();
			setModemsState({});
		},
	};
}
