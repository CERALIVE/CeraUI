import type { DeviceEvent } from "@ceraui/rpc/schemas";

// Three pages bound the number of mounted, nonvirtualized rows.
export const EVENT_ROW_CAP = 300;

export function mergeEvents(
	shown: readonly DeviceEvent[],
	more: readonly DeviceEvent[],
): DeviceEvent[] {
	const ids = new Set(shown.map((event) => event.id));
	const merged = [...shown];
	for (const event of more) {
		if (ids.has(event.id)) continue;
		ids.add(event.id);
		merged.push(event);
	}
	return merged.sort((a, b) => b.seq - a.seq);
}
