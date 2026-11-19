import type {
	DeviceEvent,
	EventListInput,
	EventListOutput,
} from "@ceraui/rpc/schemas";

// Three pages bound the number of mounted, nonvirtualized rows.
export const EVENT_ROW_CAP = 300;

export async function readEventPage(
	list: (input: EventListInput) => Promise<EventListOutput>,
	input: EventListInput & { readonly limit: number },
	window: {
		readonly rows: readonly DeviceEvent[];
		readonly head: number;
		readonly current: () => boolean;
	},
): Promise<EventListOutput | null> {
	const page = await list(input);
	const { beforeSeq } = input;
	if (
		!window.current() ||
		beforeSeq === undefined ||
		page.epoch !== undefined ||
		page.headSeq < window.head
	)
		return page;

	// Include the boundary record and one full page below it in the same snapshot.
	const overlap = await list({
		...input,
		beforeSeq: beforeSeq + 1,
		limit: input.limit + 1,
	});
	const anchor = window.rows.find(({ seq }) => seq === beforeSeq);
	if (
		overlap.epoch === undefined &&
		overlap.headSeq >= window.head &&
		(anchor === undefined ||
			JSON.stringify(anchor) !== JSON.stringify(overlap.events[0]))
	)
		return null;

	return {
		...overlap,
		events: overlap.events.filter(({ seq }) => seq < beforeSeq),
	};
}

export function shouldReloadEvents(
	page: EventListOutput,
	previous: { readonly epoch: string | undefined; readonly head: number },
	read: "first" | "older" | "gap" | "live-edge",
): boolean {
	if (read === "first") return false;
	if (page.epoch !== undefined) return page.epoch !== previous.epoch;
	const lowerHead = page.headSeq < previous.head;
	// An older page may extend a verified boundary. A lower live edge can
	// replace the window directly because it already contains the newest page.
	return read === "older" ? lowerHead : read !== "live-edge" || !lowerHead;
}

export function retainedEvents(
	rows: readonly DeviceEvent[],
	{
		retainedFromSeq,
		headSeq,
	}: Pick<EventListOutput, "retainedFromSeq" | "headSeq">,
): DeviceEvent[] {
	return rows.filter(({ seq }) => seq >= retainedFromSeq && seq <= headSeq);
}

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
