/**
 * The Events list as it renders: one group per boot run in list order (newest
 * first), with a marker where the device clock ran backwards between two
 * adjacent records of one boot, and the modem names the history recorded.
 * Times are never corrected and records never re-sorted here.
 */
import type { DeviceEvent } from "@ceraui/rpc/schemas";

export type TimelineItem =
	| {
			readonly kind: "event";
			readonly key: string;
			readonly event: DeviceEvent;
	  }
	| { readonly kind: "clock"; readonly key: string };

export interface TimelineGroup {
	readonly key: string;
	readonly bootId: string;
	readonly items: readonly TimelineItem[];
}

export function timelineGroups(
	events: readonly DeviceEvent[],
): TimelineGroup[] {
	const groups: {
		key: string;
		bootId: string;
		items: TimelineItem[];
		at: number;
	}[] = [];
	for (const event of events) {
		const item: TimelineItem = { kind: "event", key: event.id, event };
		const group = groups.at(-1);
		if (group?.bootId === event.bootId) {
			if (event.at > group.at)
				group.items.push({ kind: "clock", key: `clock-${event.id}` });
			group.items.push(item);
			group.at = event.at;
		} else {
			// A boot's nth run keeps its key as newer events join it, so its rows keep their DOM and focus.
			const run = groups.filter(
				(other) => other.bootId === event.bootId,
			).length;
			const key = `${event.bootId}-${run}`;
			groups.push({ key, bootId: event.bootId, items: [item], at: event.at });
		}
	}
	return groups;
}

export function modemNames(
	events: readonly DeviceEvent[],
): Map<string, string> {
	const names = new Map<string, string>();
	for (const { code, params } of events) {
		const { modemKey, name } = params;
		if (
			(code === "modem_added" || code === "modem_removed") &&
			typeof modemKey === "string" &&
			typeof name === "string" &&
			!names.has(modemKey)
		)
			names.set(modemKey, name);
	}
	return names;
}
