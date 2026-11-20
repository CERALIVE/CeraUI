import type { EventListInput, EventListOutput } from "@ceraui/rpc/schemas";
import { expect, it, vi } from "vitest";

import { EVENT_RING_EPOCH, event, eventPage } from "./__fixtures__/events";
import { EventsView } from "./events-view.svelte";

function history(epoch: string | undefined) {
	const retained = Array.from({ length: 101 }, (_, index) =>
		event(101 - index, "internet_lost"),
	);
	const view = new EventsView(
		{
			list: ({
				beforeSeq,
				limit,
			}: EventListInput): Promise<EventListOutput> => {
				const matches = retained.filter(
					({ seq }) => beforeSeq === undefined || seq < beforeSeq,
				);
				const rows = matches.slice(0, limit);
				return Promise.resolve(
					eventPage(rows, {
						epoch,
						headSeq: retained[0]?.seq ?? 0,
						retainedFromSeq: retained.at(-1)?.seq ?? 0,
						nextBeforeSeq:
							matches.length > rows.length ? (rows.at(-1)?.seq ?? null) : null,
					}),
				);
			},
			around: vi.fn(),
			setFeedListener: vi.fn(),
		},
		null,
	);
	return { retained, view };
}

it.each([
	{ identity: "no epoch", epoch: undefined },
	{ identity: "a matching epoch", epoch: EVENT_RING_EPOCH },
])(
	"reaches event 1 in a 101-event history with $identity",
	async ({ epoch }) => {
		const { retained, view } = history(epoch);
		await view.reload();

		await view.loadOlder();
		await vi.waitFor(() => expect(view.loading).toBeNull());

		expect(view.events).toEqual(retained);
		expect(view.nextBeforeSeq).toBeNull();
	},
);

it("offers Retry when the epoch is absent and the paging boundary cannot be verified", async () => {
	const { retained, view } = history(undefined);
	await view.reload();
	const visible = view.events;
	// A reply can reuse the same sequence and ID for a different record.
	retained.splice(99, 1, event(2, "internet_lost", { replacement: true }));

	await view.loadOlder();

	expect(view.failed).toBe("older");
	expect(view.events).toEqual(visible);
	expect(view.nextBeforeSeq).toBe(2);
});

it("replaces the history when an older read without an epoch finds a lower head", async () => {
	const { retained, view } = history(undefined);
	await view.reload();
	const replacement = [event(3, "internet_restored"), ...retained.slice(-2)];
	retained.splice(0, retained.length, ...replacement);

	await view.loadOlder();
	await vi.waitFor(() => expect(view.loading).toBeNull());

	expect(view.events).toEqual(replacement);
});
