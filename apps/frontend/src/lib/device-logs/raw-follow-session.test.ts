import type { LogFollowStartInput, LogQueryOutput } from "@ceraui/rpc/schemas";
import { expect, test, vi } from "vitest";
import { RawView } from "./raw-view.svelte";

test("Resume keeps the boot-start checkpoint across disconnect without rereading the head", async () => {
	const bootId = "66d8d1808694489b8c3a3fb4795cab24";
	const checkpointCursor = `boot-start:${bootId}:0`;
	const empty = {
		ok: true,
		entries: [],
		hasMore: false,
		termination: "end",
		continuation: null,
		historyEpoch: 0,
		bootId,
	} satisfies LogQueryOutput;
	const query = vi.fn(async () => empty);
	const followStart = vi.fn(async (_input: LogFollowStartInput) => ({
		ok: true as const,
		subscriptionId: "sub",
		checkpointCursor,
	}));
	const view = new RawView({
		logs: {
			query,
			followStart,
			followStop: async () => ({ success: true, checkpointCursor }),
		},
		setFollowListener: () => undefined,
		now: () => 0,
	});
	try {
		await view.start();
		await view.startFollow();
		view.connectionChanged("disconnected");
		expect(view.follow).toBe("disconnected");
		view.connectionChanged("connected");
		await view.startFollow();
		expect(query).toHaveBeenCalledTimes(1);
		expect(followStart.mock.calls).toEqual([
			[{ sources: [], levels: ["error", "warning", "info"] }],
			[
				{
					sources: [],
					levels: ["error", "warning", "info"],
					afterCursor: checkpointCursor,
				},
			],
		]);
		expect(view.follow).toBe("following");
	} finally {
		view.dispose();
	}
});
