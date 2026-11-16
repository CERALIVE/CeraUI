/**
 * Device event fixtures shaped like `events.list` records: family and severity
 * come from the registry for a known code, so a fixture never disagrees with
 * what the device would have stored.
 */
import { EVENT_REGISTRY } from "@ceraui/rpc/events";
import type {
	DeviceEvent,
	EventListOutput,
	LogAroundOutput,
} from "@ceraui/rpc/schemas";

import { BOOT_IDS } from "./boots";

export const EVENT_AT = Date.UTC(2026, 10, 16, 11, 0, 0);

export function event(
	seq: number,
	code: string,
	params: DeviceEvent["params"] = {},
	extra: Partial<DeviceEvent> = {},
): DeviceEvent {
	const definition = new Map(Object.entries(EVENT_REGISTRY)).get(code);
	return {
		id: `aaaaaaaa-${seq}`,
		seq,
		bootId: BOOT_IDS.current,
		at: EVENT_AT + seq * 1000,
		code,
		family: definition?.family ?? "device",
		severity: definition?.severity(params) ?? "info",
		params,
		...extra,
	};
}

export function eventPage(
	events: DeviceEvent[],
	extra: Partial<EventListOutput> = {},
): EventListOutput {
	return {
		events,
		nextBeforeSeq: null,
		headSeq: events[0]?.seq ?? 0,
		retainedFromSeq: events.at(-1)?.seq ?? 0,
		...extra,
	};
}

export type AroundPage = Extract<LogAroundOutput, { ok: true }>;

export function aroundPage(approximate = false): AroundPage {
	const page = {
		ok: true as const,
		entries: [],
		hasMore: false,
		termination: "end" as const,
		continuation: null,
		historyEpoch: 0,
		bootId: BOOT_IDS.current,
	};
	const query = {
		sources: [],
		levels: ["error" as const, "warning" as const, "info" as const],
		boot: BOOT_IDS.current,
		direction: "older" as const,
		limit: 100,
	};
	return {
		ok: true,
		anchor: null,
		approximate,
		older: page,
		newer: page,
		olderQuery: query,
		newerQuery: { ...query, direction: "newer" },
	};
}
