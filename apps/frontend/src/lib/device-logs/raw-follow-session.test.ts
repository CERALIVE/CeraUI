import type {
	LogFollowMessage,
	LogFollowStartInput,
	LogFollowStartOutput,
	LogQueryOutput,
} from "@ceraui/rpc/schemas";
import { afterEach, expect, test, vi } from "vitest";
import type { RawRow } from "./raw-rows";
import { RawView, type RawViewDeps } from "./raw-view.svelte";

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

const mounted: RawView[] = [];
afterEach(() => {
	for (const view of mounted.splice(0)) view.dispose();
});

function fakeSocket() {
	const bootId = "66d8d1808694489b8c3a3fb4795cab24";
	const checkpointCursor = `boot-start:${bootId}:0`;
	let listener: ((message: LogFollowMessage) => void) | undefined;
	let active: string | undefined;
	let serial = 0;
	let onRelease: (() => void) | undefined;
	const followStart = vi.fn((): Promise<LogFollowStartOutput> => {
		active = `sub-${++serial}`;
		return Promise.resolve({
			ok: true,
			subscriptionId: active,
			checkpointCursor,
		});
	});
	const followStop = vi.fn(() => {
		const success = active !== undefined;
		active = undefined;
		return Promise.resolve({ success, checkpointCursor });
	});
	const setFollowListener = vi.fn<RawViewDeps["setFollowListener"]>((next) => {
		listener = next;
		if (next === undefined) {
			const callback = onRelease;
			onRelease = undefined;
			callback?.();
		}
	});
	const push = (cursor: string): LogFollowMessage => ({
		subscriptionId: active ?? "no-active-follow",
		entries: [
			{
				cursor,
				bootId,
				ts: 0,
				level: "info",
				source: "app",
				unit: "ceralive.service",
				message: cursor,
				truncated: false,
				marker: null,
			},
		],
		checkpointCursor: cursor,
		dropped: 0,
	});
	const page = (cursor?: string): Extract<LogQueryOutput, { ok: true }> => ({
		ok: true,
		entries: cursor === undefined ? [] : push(cursor).entries,
		hasMore: false,
		termination: "end",
		continuation: null,
		historyEpoch: 0,
		bootId,
	});
	const query = vi.fn<() => Promise<LogQueryOutput>>(() =>
		Promise.resolve(page()),
	);
	return {
		mount() {
			const view = new RawView({
				logs: { query, followStart, followStop },
				setFollowListener,
				now: () => 0,
			});
			mounted.push(view);
			return view;
		},
		get listener() {
			return listener;
		},
		close() {
			active = undefined;
		},
		onNextRelease(callback: () => void) {
			onRelease = callback;
		},
		push,
		page,
		write(cursor: string) {
			if (active !== undefined) listener?.(push(cursor));
		},
		query,
		followStart,
		followStop,
		setFollowListener,
	};
}

function keys(view: RawView): string[] {
	return view.rows.map(({ key }: RawRow) => key);
}

test("a second view takes Follow from the first without resuming it on stop", async () => {
	const socket = fakeSocket();
	const first = socket.mount();
	const second = socket.mount();
	await first.startFollow();
	socket.write("first");
	const oldListener = socket.listener;
	if (oldListener === undefined) throw new Error("missing first listener");
	const staleBatch = socket.push("late-first");

	await second.startFollow();

	expect(first.follow).toBe("stopped");
	expect(first.announcement?.kind).toBe("stopped");
	expect(first.ended).toBeNull();
	expect(socket.setFollowListener).toHaveBeenNthCalledWith(2, undefined);
	expect(socket.followStop).not.toHaveBeenCalled();
	oldListener(staleBatch);
	oldListener({ ...staleBatch, ended: "cleared" });
	socket.write("second");
	expect(keys(first)).toEqual(["first"]);
	expect(keys(second)).toEqual(["second"]);
	expect(second.follow).toBe("following");

	await second.pauseFollow();
	await second.pauseFollow();
	socket.write("after-stop");
	expect(socket.listener).toBeUndefined();
	expect(socket.followStop).toHaveBeenCalledTimes(1);
	expect(first.follow).toBe("stopped");
	expect(keys(first)).toEqual(["first"]);
	expect(keys(second)).toEqual(["second"]);
});

test("a third start during listener release wins the handoff", async () => {
	const socket = fakeSocket();
	const first = socket.mount();
	const second = socket.mount();
	const third = socket.mount();
	await first.startFollow();
	let thirdStart: Promise<void> | undefined;
	socket.onNextRelease(() => {
		thirdStart = third.startFollow();
	});

	await second.startFollow();
	await thirdStart;
	socket.write("third");

	expect(first.follow).toBe("stopped");
	expect(second.follow).toBe("stopped");
	expect(third.follow).toBe("following");
	expect(keys(first)).toEqual([]);
	expect(keys(second)).toEqual([]);
	expect(keys(third)).toEqual(["third"]);
	expect(socket.followStart).toHaveBeenCalledTimes(2);
});

test("socket close during takeover does not revive the displaced view", async () => {
	const socket = fakeSocket();
	const first = socket.mount();
	const second = socket.mount();
	await first.startFollow();
	const reply = Promise.withResolvers<LogFollowStartOutput>();
	socket.followStart.mockReturnValueOnce(reply.promise);
	const switching = second.startFollow();

	socket.close();
	first.connectionChanged("disconnected");
	second.connectionChanged("disconnected");
	reply.resolve({ ok: true, subscriptionId: "stale", checkpointCursor: null });
	await switching;
	first.connectionChanged("connected");
	second.connectionChanged("connected");
	await second.startFollow();
	socket.write("reconnected");

	expect(first.follow).toBe("stopped");
	expect(keys(first)).toEqual([]);
	expect(second.follow).toBe("following");
	expect(keys(second)).toEqual(["reconnected"]);
});

test("a displaced view can start again without reviving its stale listener", async () => {
	const socket = fakeSocket();
	const first = socket.mount();
	const second = socket.mount();
	await first.startFollow();
	const staleListener = socket.listener;
	if (staleListener === undefined) throw new Error("missing first listener");
	await second.startFollow();
	await first.startFollow();

	staleListener({ ...socket.push("stale"), ended: "cleared" });
	socket.write("fresh");

	expect(first.follow).toBe("following");
	expect(keys(first)).toEqual(["fresh"]);
	expect(second.follow).toBe("stopped");
	expect(keys(second)).toEqual([]);
});

test("a displaced head replay cannot automatically take Follow back", async () => {
	const socket = fakeSocket();
	const first = socket.mount();
	const second = socket.mount();
	await first.startFollow();
	const page = Promise.withResolvers<LogQueryOutput>();
	socket.query.mockReturnValueOnce(page.promise);
	const reading = first.reset();
	await second.startFollow();

	page.resolve(await socket.query());
	await reading;
	socket.write("second");

	expect(first.follow).toBe("stopped");
	expect(keys(first)).toEqual([]);
	expect(second.follow).toBe("following");
	expect(keys(second)).toEqual(["second"]);
});

test("a pending filter query cannot replace rows after the view takes Follow back", async () => {
	const socket = fakeSocket();
	const first = socket.mount();
	const second = socket.mount();
	await first.startFollow();
	const page = Promise.withResolvers<LogQueryOutput>();
	socket.query.mockReturnValueOnce(page.promise);
	const reading = first.setLevel("everything");
	await second.startFollow();
	expect(first.follow).toBe("stopped");
	await first.startFollow();
	expect(second.follow).toBe("stopped");
	socket.write("fresh-after-retake");
	expect(keys(first)).toEqual(["fresh-after-retake"]);

	page.resolve(socket.page("old-filter-snapshot"));
	await reading;

	expect(first.follow).toBe("following");
	expect(keys(first)).toEqual(["fresh-after-retake"]);
	expect(first.loading).toBeNull();
});

test("takeover cancels a displaced view's pending head replacement without restarting it", async () => {
	const socket = fakeSocket();
	const first = socket.mount();
	const second = socket.mount();
	await first.startFollow();
	const page = Promise.withResolvers<LogQueryOutput>();
	socket.query.mockReturnValueOnce(page.promise);
	const reading = first.reset();
	await second.startFollow();
	socket.write("second");

	page.resolve(socket.page("old-head"));
	await reading;

	expect(first.follow).toBe("stopped");
	expect(keys(first)).toEqual([]);
	expect(first.loading).toBeNull();
	expect(second.follow).toBe("following");
	expect(keys(second)).toEqual(["second"]);
});

test("Resume after a disconnect protects live rows from a pending head replay", async () => {
	const socket = fakeSocket();
	const view = socket.mount();
	await view.startFollow();
	const page = Promise.withResolvers<LogQueryOutput>();
	socket.query.mockReturnValueOnce(page.promise);
	const reading = view.reset();
	socket.close();
	view.connectionChanged("disconnected");
	view.connectionChanged("connected");
	await view.startFollow();
	socket.write("after-resume");
	expect(keys(view)).toEqual(["after-resume"]);

	page.resolve(socket.page("old-head"));
	await reading;

	expect(view.follow).toBe("following");
	expect(keys(view)).toEqual(["after-resume"]);
});

test.each(["Clear", "a new filter"] as const)(
	"%s after takeback lets only the newer head read place rows",
	async (action) => {
		const socket = fakeSocket();
		const first = socket.mount();
		const second = socket.mount();
		await first.startFollow();
		const oldPage = Promise.withResolvers<LogQueryOutput>();
		socket.query.mockReturnValueOnce(oldPage.promise);
		const reading = first.setLevel("everything");
		await second.startFollow();
		await first.startFollow();
		socket.write("before-new-read");
		expect(keys(first)).toEqual(["before-new-read"]);

		const newPage = Promise.withResolvers<LogQueryOutput>();
		socket.query.mockReturnValueOnce(newPage.promise);
		if (action === "Clear")
			socket.listener?.({
				...socket.push("cleared"),
				entries: [],
				ended: "cleared",
			});
		const refreshed = action === "Clear" ? undefined : first.setLevel("info");
		oldPage.resolve(socket.page("old-head"));
		await reading;

		expect(first.loading).toBe("first");
		expect(keys(first)).toEqual([]);
		newPage.resolve(socket.page("new-head"));
		await refreshed;
		await vi.waitFor(() => expect(keys(first)).toEqual(["new-head"]));
		expect(first.loading).toBeNull();
		expect(first.follow).toBe(action === "Clear" ? "stopped" : "following");
		expect(first.ended).toBe(action === "Clear" ? "cleared" : null);
		expect(second.follow).toBe("stopped");
	},
);
