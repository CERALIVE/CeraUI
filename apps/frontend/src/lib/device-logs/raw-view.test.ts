import type {
	LogAroundOutput,
	LogEntry,
	LogFollowMessage,
	LogFollowStartInput,
	LogFollowStartOutput,
	LogFollowStopOutput,
	LogQueryInput,
	LogQueryOutput,
} from "@ceraui/rpc/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { displayRows } from "./raw-rows";
import { RawView, resetRawView } from "./raw-view.svelte";

const BOOT = "66d8d1808694489b8c3a3fb4795cab24";
const NOW = 1_800_000_000_000;
const DEFAULT_INPUT = {
	sources: [],
	levels: ["error", "warning", "info"],
	boot: "current",
	direction: "older",
	limit: 100,
};

type QueryPage = Extract<LogQueryOutput, { ok: true }>;
type AroundPage = Extract<LogAroundOutput, { ok: true }>;

function entry(cursor: string, patch: Partial<LogEntry> = {}): LogEntry {
	return {
		cursor,
		ts: NOW - 1000,
		bootId: BOOT,
		level: "info",
		source: "app",
		unit: "ceralive.service",
		message: `message ${cursor}`,
		truncated: false,
		marker: null,
		...patch,
	};
}

function page(
	cursors: readonly string[],
	patch: Partial<QueryPage> = {},
): QueryPage {
	return {
		ok: true,
		entries: cursors.map((cursor) => entry(cursor)),
		hasMore: false,
		termination: "end",
		continuation: null,
		historyEpoch: 0,
		bootId: BOOT,
		...patch,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function harness() {
	const query = vi.fn<(input: LogQueryInput) => Promise<LogQueryOutput>>();
	const followStart =
		vi.fn<(input: LogFollowStartInput) => Promise<LogFollowStartOutput>>();
	const followStop = vi.fn<() => Promise<LogFollowStopOutput>>();
	let listener: ((message: LogFollowMessage) => void) | undefined;
	const setFollowListener = vi.fn(
		(next: ((message: LogFollowMessage) => void) | undefined) => {
			listener = next;
		},
	);
	let now = NOW;
	const view = new RawView({
		logs: { query, followStart, followStop },
		setFollowListener,
		now: () => now,
	});
	views.push(view);
	return {
		view,
		query,
		followStart,
		followStop,
		setFollowListener,
		push(message: Partial<LogFollowMessage>) {
			listener?.({
				subscriptionId: "sub-1",
				entries: [],
				checkpointCursor: null,
				dropped: 0,
				...message,
			});
		},
		get listener() {
			return listener;
		},
		advance(ms: number) {
			now += ms;
		},
	};
}

const views: RawView[] = [];

afterEach(() => {
	for (const view of views.splice(0)) view.dispose();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const keys = (view: RawView) => view.rows.map((row) => row.key);

async function loaded(
	cursors: readonly string[],
	patch: Partial<QueryPage> = {},
) {
	const h = harness();
	h.query.mockResolvedValueOnce(page(cursors, patch));
	await h.view.start();
	return h;
}

/** Follow starts reply like follow.ts: after the given cursor, or without one after `head`. */
function startsAfter(h: ReturnType<typeof harness>, head: string) {
	h.followStart.mockImplementation(async (input) => ({
		ok: true,
		subscriptionId: "sub-1",
		checkpointCursor: input.afterCursor ?? head,
	}));
}

async function following(cursors: readonly string[] = ["s=3", "s=2"]) {
	const h = await loaded(cursors);
	h.followStart.mockResolvedValueOnce({
		ok: true,
		subscriptionId: "sub-1",
		checkpointCursor: "s=3",
	});
	// With no row to start after, Follow learns the head, reads it again, then starts after it.
	if (cursors.length === 0) {
		h.query.mockResolvedValueOnce(page([]));
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: "s=3",
		});
	}
	await h.view.startFollow();
	return h;
}

describe("RawView: first page", () => {
	it("asks for the default view and shows its rows", async () => {
		const h = harness();
		h.query.mockResolvedValueOnce(
			page(["s=3", "s=2"], { hasMore: true, continuation: "c1" }),
		);
		const done = h.view.start();
		expect(h.view.loading).toBe("first");
		await done;

		expect(h.query).toHaveBeenCalledExactlyOnceWith(DEFAULT_INPUT);
		expect(keys(h.view)).toEqual(["s=3", "s=2"]);
		expect(h.view.loading).toBeNull();
		expect(h.view.failure).toBeNull();
		expect(h.view.bottom).toEqual({
			query: DEFAULT_INPUT,
			continuation: "c1",
			hasMore: true,
			lost: false,
		});
		expect(h.view.capped).toBe(false);
		expect(h.view.top).toBeNull();
		expect(h.view.anchor).toBeNull();
		expect(h.view.newestFirst).toBe(true);
	});

	it("re-queries with levels ['error'] when Errors is chosen", async () => {
		const h = await loaded(["s=1"]);
		h.query.mockResolvedValueOnce(page([]));
		await h.view.setLevel("errors");
		expect(h.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			levels: ["error"],
		});
		expect(h.view.filter.level).toBe("errors");
		expect(keys(h.view)).toEqual([]);
	});

	it("re-queries for sources, time, order and a chosen boot", async () => {
		const h = await loaded([]);
		h.query.mockResolvedValue(page([]));
		await h.view.setSources(["engine"]);
		expect(h.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			sources: ["engine"],
		});
		await h.view.setOrder("oldest");
		expect(h.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			sources: ["engine"],
			direction: "newer",
		});
		expect(h.view.newestFirst).toBe(false);
		await h.view.setTime("15m");
		expect(h.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			sources: ["engine"],
			direction: "newer",
			boot: "all",
			since: NOW - 15 * 60_000,
		});
		await h.view.chooseBoot(BOOT);
		expect(h.view.filter).toMatchObject({ bootId: BOOT, time: "15m" });
		expect(h.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			sources: ["engine"],
			direction: "newer",
			boot: BOOT,
		});
		await h.view.setTime("1h");
		expect(h.view.filter.bootId).toBeNull();
	});

	it("reads every boot when All boots is chosen in the picker", async () => {
		const h = await loaded([]);
		h.query.mockResolvedValue(page([]));
		await h.view.chooseBoot(BOOT);
		await h.view.chooseBoot(null);
		expect(h.view.filter).toMatchObject({ bootId: null, time: "all" });
		expect(h.query).toHaveBeenLastCalledWith({ ...DEFAULT_INPUT, boot: "all" });
	});

	it("ignores a late response from an older generation", async () => {
		const h = harness();
		const first = deferred<LogQueryOutput>();
		const second = deferred<LogQueryOutput>();
		h.query
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const initial = h.view.start();
		const changed = h.view.setLevel("everything");
		second.resolve(page(["new"]));
		await changed;
		first.resolve(page(["old"], { hasMore: true, continuation: "stale" }));
		await initial;
		expect(keys(h.view)).toEqual(["new"]);
		expect(h.view.bottom?.continuation).toBeNull();
		expect(h.view.loading).toBeNull();
	});

	it("ignores a late failure from an older generation", async () => {
		const h = harness();
		const first = deferred<LogQueryOutput>();
		h.query
			.mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce(page(["new"]));
		const initial = h.view.start();
		await h.view.setLevel("errors");
		first.resolve({ ok: false, error: "BUSY" });
		await initial;
		expect(h.view.failure).toBeNull();
		expect(keys(h.view)).toEqual(["new"]);
	});

	it("reports each error code with the operation it came from", async () => {
		const h = harness();
		h.query.mockResolvedValueOnce({ ok: false, error: "BOOT_UNAVAILABLE" });
		await h.view.start();
		expect(h.view.failure).toEqual({ code: "BOOT_UNAVAILABLE", op: "first" });
		expect(h.view.loading).toBeNull();
		expect(h.view.bottom).toBeNull();
	});

	it("turns a rejected or missing transport into READ_FAILED and reports it", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const h = harness();
		h.query.mockRejectedValueOnce(new Error("socket closed"));
		await h.view.start();
		expect(h.view.failure).toEqual({ code: "READ_FAILED", op: "first" });
		expect(error).toHaveBeenCalledWith(
			"System Logs raw query failed:",
			expect.any(Error),
		);

		const bare = new RawView({
			logs: {} as never,
			setFollowListener: () => {},
			now: () => NOW,
		});
		views.push(bare);
		await bare.start();
		expect(bare.failure).toEqual({ code: "READ_FAILED", op: "first" });
		expect(error).toHaveBeenLastCalledWith(
			"System Logs raw query failed:",
			expect.any(TypeError),
		);
	});

	it("retries a failed first page with the same filter", async () => {
		const h = harness();
		h.query
			.mockResolvedValueOnce({ ok: false, error: "BUSY" })
			.mockResolvedValueOnce(page(["s=1"]));
		await h.view.start();
		await h.view.retry();
		expect(h.query).toHaveBeenCalledTimes(2);
		expect(h.query.mock.calls[1]?.[0]).toEqual(DEFAULT_INPUT);
		expect(h.view.failure).toBeNull();
		expect(keys(h.view)).toEqual(["s=1"]);
	});

	it("does nothing on retry without a failure", async () => {
		const h = await loaded(["s=1"]);
		await h.view.retry();
		expect(h.query).toHaveBeenCalledTimes(1);
	});

	it("shows this boot again after its logs were removed", async () => {
		const h = harness();
		h.query.mockResolvedValue(page([]));
		await h.view.start();
		await h.view.chooseBoot(BOOT);
		await h.view.showCurrentBoot();
		expect(h.view.filter).toMatchObject({ time: "current", bootId: null });
		expect(h.query).toHaveBeenLastCalledWith(DEFAULT_INPUT);
	});

	it("goes back to the defaults on Show everything", async () => {
		const h = harness();
		h.query.mockResolvedValue(page([]));
		await h.view.start();
		await h.view.setLevel("errors");
		await h.view.setSources(["kernel"]);
		h.view.setDraft("srt");
		await h.view.resetFilters();
		expect(h.view.filter).toEqual({
			sources: [],
			level: "info",
			time: "current",
			bootId: null,
			text: "",
			order: "newest",
		});
		expect(h.view.draft).toBe("");
		expect(h.query).toHaveBeenLastCalledWith(DEFAULT_INPUT);
	});
});

describe("RawView: search", () => {
	it("applies typed text after 300 ms of quiet, once", async () => {
		vi.useFakeTimers();
		const h = await loaded([]);
		h.query.mockResolvedValue(page([]));
		h.view.setDraft("sr");
		await vi.advanceTimersByTimeAsync(100);
		h.view.setDraft("srt");
		expect(h.view.draft).toBe("srt");
		await vi.advanceTimersByTimeAsync(299);
		expect(h.query).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.query).toHaveBeenCalledTimes(2);
		expect(h.query).toHaveBeenLastCalledWith({ ...DEFAULT_INPUT, text: "srt" });
		await vi.advanceTimersByTimeAsync(1000);
		expect(h.query).toHaveBeenCalledTimes(2);
	});

	it("applies at once on Enter and cancels the pending debounce", async () => {
		vi.useFakeTimers();
		const h = await loaded([]);
		h.query.mockResolvedValue(page([]));
		h.view.setDraft("link");
		await h.view.applyDraft();
		expect(vi.getTimerCount()).toBe(0);
		expect(h.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			text: "link",
		});
		await vi.advanceTimersByTimeAsync(300);
		expect(h.query).toHaveBeenCalledTimes(2);
	});

	it("does not re-query for text that is already applied", async () => {
		const h = await loaded([]);
		h.query.mockResolvedValue(page([]));
		h.view.setDraft("x");
		await h.view.applyDraft();
		await h.view.applyDraft();
		expect(h.query).toHaveBeenCalledTimes(2);
	});

	it("sends the clipped, NUL-free text the device accepts", async () => {
		const h = await loaded([]);
		h.query.mockResolvedValue(page([]));
		h.view.setDraft(`a\0${"b".repeat(300)}`);
		await h.view.applyDraft();
		expect(h.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			text: `a${"b".repeat(255)}`,
		});
	});

	it("clears the search at once", async () => {
		const h = await loaded([]);
		h.query.mockResolvedValue(page([]));
		h.view.setDraft("x");
		await h.view.applyDraft();
		await h.view.clearSearch();
		expect(h.view.draft).toBe("");
		expect(h.view.filter.text).toBe("");
		expect(h.query).toHaveBeenLastCalledWith(DEFAULT_INPUT);
	});

	it("drops a pending debounce on dispose", async () => {
		vi.useFakeTimers();
		const h = await loaded([]);
		h.view.setDraft("late");
		h.view.dispose();
		await vi.advanceTimersByTimeAsync(300);
		expect(h.query).toHaveBeenCalledTimes(1);
	});
});

describe("RawView: paging", () => {
	it("passes the previous continuation on Load more and appends", async () => {
		const h = await loaded(["s=4", "s=3"], {
			hasMore: true,
			continuation: "c1",
		});
		h.query.mockResolvedValueOnce(page(["s=2", "s=1"], { continuation: null }));
		const done = h.view.loadMore("bottom");
		expect(h.view.loading).toBe("bottom");
		await done;
		expect(h.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			continuation: "c1",
		});
		expect(keys(h.view)).toEqual(["s=4", "s=3", "s=2", "s=1"]);
		expect(h.view.bottom).toMatchObject({
			continuation: null,
			hasMore: false,
			lost: false,
		});
		expect(h.view.loading).toBeNull();
	});

	it("keeps the time range resolved when the query started", async () => {
		const h = harness();
		h.query.mockResolvedValue(
			page(["s=2"], { hasMore: null, continuation: "c1" }),
		);
		await h.view.start();
		await h.view.setTime("1h");
		h.advance(10 * 60_000);
		await h.view.loadMore("bottom");
		expect(h.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			boot: "all",
			since: NOW - 60 * 60_000,
			continuation: "c1",
		});
	});

	it("keeps searching from a budget stop that has a continuation", async () => {
		const h = await loaded([], {
			hasMore: null,
			termination: "budget",
			continuation: "c1",
		});
		expect(h.view.bottom?.hasMore).toBeNull();
		h.query.mockResolvedValueOnce(page(["s=1"], { hasMore: false }));
		await h.view.loadMore("bottom");
		expect(h.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			continuation: "c1",
		});
		expect(keys(h.view)).toEqual(["s=1"]);
	});

	it("repeats the first query while budget pages without a continuation keep coming", async () => {
		const h = harness();
		h.query.mockResolvedValue(
			page([], { hasMore: null, termination: "budget", continuation: null }),
		);
		await h.view.start();
		await h.view.setTime("1h");
		const first = h.query.mock.lastCall?.[0];
		expect(first).toEqual({
			...DEFAULT_INPUT,
			boot: "all",
			since: NOW - 60 * 60_000,
		});
		h.advance(10 * 60_000);
		await h.view.loadMore("bottom");
		await h.view.loadMore("bottom");
		expect(h.query.mock.calls.slice(-2)).toEqual([[first], [first]]);
		expect(h.view.bottom).toMatchObject({ continuation: null, hasMore: null });
		h.query.mockResolvedValueOnce(page(["s=1"], { hasMore: false }));
		await h.view.loadMore("bottom");
		expect(h.query).toHaveBeenLastCalledWith(first);
		expect(keys(h.view)).toEqual(["s=1"]);
		await h.view.loadMore("bottom");
		expect(h.query).toHaveBeenCalledTimes(5);
	});

	it("merges a repeated first query into followed rows by cursor, newest first", async () => {
		const at = (cursor: string, age: number) =>
			entry(cursor, { ts: NOW - age * 1000 });
		const h = await loaded([], {
			hasMore: null,
			termination: "budget",
			continuation: null,
		});
		startsAfter(h, "head");
		h.query.mockResolvedValueOnce(
			page([], { hasMore: null, termination: "budget", continuation: null }),
		);
		await h.view.startFollow();
		h.push({ entries: [at("a", 2)], checkpointCursor: "a" });
		const announced = h.view.announcement;
		h.query.mockResolvedValueOnce(
			page([], {
				entries: [at("b", 1), at("a", 2), at("old", 3)],
				hasMore: true,
				continuation: "c1",
			}),
		);
		await h.view.loadMore("bottom");
		// Follow attaches again after the replay without announcing anything.
		expect(h.view.announcement).toEqual(announced);
		expect(keys(h.view)).toEqual(["b", "a", "old"]);
		h.push({ entries: [at("b", 1)], checkpointCursor: "b" });
		h.push({ entries: [at("c", 0)], checkpointCursor: "c" });
		expect(keys(h.view)).toEqual(["c", "b", "a", "old"]);
		expect(
			displayRows(h.view.rows, h.view.newestFirst).filter(
				(row) => row.kind === "clock",
			),
		).toEqual([]);
		expect(h.view.bottom).toMatchObject({ continuation: "c1", hasMore: true });
	});

	it("keeps followed rows above a repeated first query they are newer than", async () => {
		const h = await loaded([], {
			hasMore: null,
			termination: "budget",
			continuation: null,
		});
		startsAfter(h, "head");
		h.query.mockResolvedValueOnce(
			page([], { hasMore: null, termination: "budget", continuation: null }),
		);
		await h.view.startFollow();
		h.push({ entries: [entry("a")], checkpointCursor: "a" });
		h.query.mockResolvedValueOnce(
			page([], { hasMore: null, termination: "budget", continuation: null }),
		);
		await h.view.loadMore("bottom");
		expect(keys(h.view)).toEqual(["a"]);
		expect(h.view.bottom).toMatchObject({ continuation: null, hasMore: null });
		h.push({ entries: [entry("c")], checkpointCursor: "c" });
		h.query.mockResolvedValueOnce(page(["c", "a", "old"], { hasMore: false }));
		await h.view.loadMore("bottom");
		expect(keys(h.view)).toEqual(["c", "a", "old"]);
		expect(h.view.bottom).toMatchObject({ continuation: null, hasMore: false });
	});

	it("replaces followed rows with a repeated first query that shares none, and pages them back below", async () => {
		const h = await loaded([], {
			hasMore: null,
			termination: "budget",
			continuation: null,
		});
		startsAfter(h, "head");
		h.query.mockResolvedValueOnce(
			page([], { hasMore: null, termination: "budget", continuation: null }),
		);
		await h.view.startFollow();
		h.push({ entries: [entry("a")], checkpointCursor: "a" });
		// new2 and new1 sat in the batch the replay's stop discarded, so the head page is newer than a.
		h.query.mockResolvedValueOnce(
			page(["new2", "new1"], { hasMore: true, continuation: "c1" }),
		);
		await h.view.loadMore("bottom");
		expect(keys(h.view)).toEqual(["new2", "new1"]);
		expect(h.followStart).toHaveBeenLastCalledWith(
			expect.objectContaining({ afterCursor: "new2" }),
		);
		h.query.mockResolvedValueOnce(
			page(["a", "old2", "old1"], { hasMore: false }),
		);
		await h.view.loadMore("bottom");
		expect(keys(h.view)).toEqual(["new2", "new1", "a", "old2", "old1"]);
	});

	it("does not repeat a held entry when a repeated first query also returns it", async () => {
		const h = await loaded([], {
			hasMore: null,
			termination: "budget",
			continuation: null,
		});
		startsAfter(h, "head");
		h.query.mockResolvedValueOnce(
			page([], { hasMore: null, termination: "budget", continuation: null }),
		);
		await h.view.startFollow();
		h.push({ entries: [entry("a")], checkpointCursor: "a" });
		h.view.setAtTop(false);
		h.push({ entries: [entry("b")], checkpointCursor: "b" });
		h.query.mockResolvedValueOnce(page(["b", "a", "old"], { hasMore: false }));
		await h.view.loadMore("bottom");
		expect(keys(h.view)).toEqual(["a", "old"]);
		h.view.showHeld();
		expect(keys(h.view)).toEqual(["b", "a", "old"]);
	});

	it("keeps searching with Follow detached until a page lists an entry, and stops when a page makes no progress", async () => {
		const empty = (continuation: string | null) =>
			page([], { hasMore: null, termination: "budget", continuation });
		const h = await loaded([], empty(null));
		startsAfter(h, "head");
		h.query.mockResolvedValueOnce(empty(null));
		await h.view.startFollow();
		h.query
			.mockResolvedValueOnce(empty("k1"))
			.mockResolvedValueOnce(empty("k1"));
		await h.view.loadMore("bottom");
		expect(h.query).toHaveBeenCalledTimes(4);
		expect(h.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			continuation: "k1",
		});
		// Follow attached again over an empty search, so the edge reads from the head again.
		expect(h.view.bottom).toMatchObject({ continuation: null, hasMore: null });
		expect(h.view.follow).toBe("following");
		h.query
			.mockResolvedValueOnce(empty("k2"))
			.mockResolvedValueOnce(
				page(["x"], { hasMore: true, continuation: "k3" }),
			);
		await h.view.loadMore("bottom");
		expect(h.query).toHaveBeenCalledTimes(6);
		expect(h.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			continuation: "k2",
		});
		expect(keys(h.view)).toEqual(["x"]);
		expect(h.view.bottom).toMatchObject({ continuation: "k3", hasMore: true });
		expect(h.followStart).toHaveBeenLastCalledWith(
			expect.objectContaining({ afterCursor: "x" }),
		);
	});

	it("places an idle search's empty positioned page instead of reading on", async () => {
		const h = await loaded([], {
			hasMore: null,
			termination: "budget",
			continuation: null,
		});
		h.query
			.mockResolvedValueOnce(
				page([], { hasMore: null, termination: "budget", continuation: "k1" }),
			)
			.mockResolvedValueOnce(page(["x"], { hasMore: false }));
		await h.view.loadMore("bottom");
		expect(h.query).toHaveBeenCalledTimes(2);
		expect(h.view.bottom).toMatchObject({ continuation: "k1", hasMore: null });
		expect(h.followStart).not.toHaveBeenCalled();
		expect(h.view.follow).toBe("idle");
	});

	it("keeps Follow's own position when a replay's newest entry was already listed", async () => {
		const empty = page([], {
			hasMore: null,
			termination: "budget",
			continuation: null,
		});
		const h = await loaded([], empty);
		startsAfter(h, "head");
		h.query.mockResolvedValueOnce(empty);
		await h.view.startFollow();
		// z is a record Follow examined after a without it matching.
		h.push({ entries: [entry("a")], checkpointCursor: "z" });
		h.query.mockResolvedValueOnce(page(["a", "old"], { hasMore: false }));
		await h.view.loadMore("bottom");
		expect(keys(h.view)).toEqual(["a", "old"]);
		expect(h.followStart).toHaveBeenLastCalledWith(
			expect.objectContaining({ afterCursor: "z" }),
		);
	});

	it("keeps the reading position at the next shown entry when a head page replaces a marker", async () => {
		const empty = page([], {
			hasMore: null,
			termination: "budget",
			continuation: null,
		});
		const h = await loaded([], empty);
		startsAfter(h, "head");
		h.query.mockResolvedValueOnce(empty);
		await h.view.startFollow();
		h.push({ entries: [entry("a")], checkpointCursor: "a", dropped: 2 });
		expect(h.view.rows.map((row) => row.kind)).toEqual(["marker", "entry"]);
		h.view.setAtTop(false);
		h.push({ entries: [entry("b")], checkpointCursor: "b" });
		h.query.mockResolvedValueOnce(
			page(["b", "x", "a", "old"], { hasMore: false }),
		);
		await h.view.loadMore("bottom");
		expect(h.view.held.map((row) => row.key)).toEqual(["b", "x"]);
		expect(keys(h.view)).toEqual(["a", "old"]);
	});

	it("holds nothing when a head page shares no row with the rows being read", async () => {
		const empty = page([], {
			hasMore: null,
			termination: "budget",
			continuation: null,
		});
		const h = await loaded([], empty);
		startsAfter(h, "head");
		h.query.mockResolvedValueOnce(empty);
		await h.view.startFollow();
		h.push({ entries: [entry("a")], checkpointCursor: "a" });
		h.view.setAtTop(false);
		h.push({ entries: [entry("b")], checkpointCursor: "b" });
		h.query.mockResolvedValueOnce(
			page(["n2", "n1"], { hasMore: true, continuation: "c1" }),
		);
		await h.view.loadMore("bottom");
		expect(h.view.held).toEqual([]);
		expect(keys(h.view)).toEqual(["n2", "n1"]);
	});

	it("forgets the held overflow count when a head page replaces the list", async () => {
		const budget = (continuation: string | null) =>
			page([], { hasMore: null, termination: "budget", continuation });
		const h = await loaded([], budget("k1"));
		startsAfter(h, "head");
		h.query.mockResolvedValueOnce(budget("k1"));
		await h.view.startFollow();
		expect(h.view.bottom).toMatchObject({ continuation: null, hasMore: null });
		h.push({ entries: [entry("a")], checkpointCursor: "a" });
		h.view.setAtTop(false);
		h.push({
			entries: Array.from({ length: 503 }, (_, index) => entry(`b-${index}`)),
			checkpointCursor: "b-502",
		});
		h.query.mockResolvedValueOnce(
			page(["b-502", "b-501", "a"], { hasMore: true, continuation: "c1" }),
		);
		await h.view.loadMore("bottom");
		h.view.showHeld();
		expect(keys(h.view)).toEqual(["b-502", "b-501", "a"]);
	});

	it("stops the device follow once when a reset lands during a replay", async () => {
		const empty = page([], {
			hasMore: null,
			termination: "budget",
			continuation: null,
		});
		const h = await loaded([], empty);
		startsAfter(h, "head");
		h.query.mockResolvedValueOnce(empty);
		await h.view.startFollow();
		expect(h.followStop).toHaveBeenCalledTimes(1);
		const replay = deferred<LogQueryOutput>();
		h.query
			.mockReturnValueOnce(replay.promise)
			.mockResolvedValueOnce(page(["fresh"]));
		const searching = h.view.loadMore("bottom");
		expect(h.followStop).toHaveBeenCalledTimes(2);
		await h.view.reset();
		expect(h.followStop).toHaveBeenCalledTimes(2);
		replay.resolve(page(["late"]));
		await searching;
		expect(keys(h.view)).toEqual(["fresh"]);
	});

	it("ignores a repeated first query that lands after the filter changed", async () => {
		const h = await loaded([], {
			hasMore: null,
			termination: "budget",
			continuation: null,
		});
		const stale = deferred<LogQueryOutput>();
		h.query.mockReturnValueOnce(stale.promise);
		const retry = h.view.loadMore("bottom");
		expect(h.view.loading).toBe("bottom");
		h.query.mockResolvedValueOnce(page(["e=1"], { hasMore: false }));
		await h.view.setLevel("errors");
		stale.resolve(page(["s=9"], { hasMore: false }));
		await retry;
		expect(h.query.mock.calls.map(([input]) => input)).toEqual([
			DEFAULT_INPUT,
			DEFAULT_INPUT,
			{ ...DEFAULT_INPUT, levels: ["error"] },
		]);
		expect(keys(h.view)).toEqual(["e=1"]);
		expect(h.view.loading).toBeNull();
		expect(h.view.bottom).toMatchObject({ hasMore: false });
	});

	it("does not page without a continuation, while loading or beyond the cap", async () => {
		const h = await loaded(["s=1"]);
		await h.view.loadMore("bottom");
		await h.view.loadMore("top");
		expect(h.query).toHaveBeenCalledTimes(1);

		const busy = await loaded(["s=1"], { hasMore: true, continuation: "c1" });
		const pending = deferred<LogQueryOutput>();
		busy.query.mockReturnValueOnce(pending.promise);
		const first = busy.view.loadMore("bottom");
		await busy.view.loadMore("bottom");
		expect(busy.query).toHaveBeenCalledTimes(2);
		pending.resolve(page([]));
		await first;
	});

	it("marks the lost side when the position expired and keeps the rows", async () => {
		const h = await loaded(["s=2"], { hasMore: true, continuation: "c1" });
		h.query.mockResolvedValueOnce({ ok: false, error: "CURSOR_UNAVAILABLE" });
		await h.view.loadMore("bottom");
		expect(h.view.failure).toEqual({
			code: "CURSOR_UNAVAILABLE",
			op: "bottom",
		});
		expect(h.view.bottom?.lost).toBe(true);
		expect(h.view.bottom?.continuation).toBe("c1");
		expect(keys(h.view)).toEqual(["s=2"]);
		await h.view.loadMore("bottom");
		expect(h.query).toHaveBeenCalledTimes(2);
	});

	it("treats FILTER_CHANGED as an expired position too", async () => {
		const h = await loaded(["s=2"], { hasMore: true, continuation: "c1" });
		h.query.mockResolvedValueOnce({ ok: false, error: "FILTER_CHANGED" });
		await h.view.loadMore("bottom");
		expect(h.view.bottom?.lost).toBe(true);
	});

	it("keeps paging open after a busy reply and retries the same page", async () => {
		const h = await loaded(["s=2"], { hasMore: true, continuation: "c1" });
		h.query
			.mockResolvedValueOnce({ ok: false, error: "BUSY" })
			.mockResolvedValueOnce(page(["s=1"]));
		await h.view.loadMore("bottom");
		expect(h.view.bottom?.lost).toBe(false);
		expect(h.view.failure).toEqual({ code: "BUSY", op: "bottom" });
		await h.view.retry();
		expect(h.query).toHaveBeenLastCalledWith({
			...DEFAULT_INPUT,
			continuation: "c1",
		});
		expect(keys(h.view)).toEqual(["s=2", "s=1"]);
		expect(h.view.failure).toBeNull();
	});

	it("starts from newest after an expired position", async () => {
		const h = await loaded(["s=2"], { hasMore: true, continuation: "c1" });
		h.query
			.mockResolvedValueOnce({ ok: false, error: "CURSOR_UNAVAILABLE" })
			.mockResolvedValueOnce(page(["s=9"]));
		await h.view.loadMore("bottom");
		await h.view.reset();
		expect(h.query).toHaveBeenLastCalledWith(DEFAULT_INPUT);
		expect(keys(h.view)).toEqual(["s=9"]);
		expect(h.view.failure).toBeNull();
		expect(h.view.bottom?.lost).toBe(false);
	});

	it("ignores a page that arrives after the view was reset", async () => {
		const h = await loaded(["s=2"], { hasMore: true, continuation: "c1" });
		const late = deferred<LogQueryOutput>();
		h.query
			.mockReturnValueOnce(late.promise)
			.mockResolvedValueOnce(page(["s=5"]));
		const paging = h.view.loadMore("bottom");
		await h.view.reset();
		late.resolve(page(["s=1"]));
		await paging;
		expect(keys(h.view)).toEqual(["s=5"]);
	});

	it("stops at 2000 rows and disables paging toward the far end", async () => {
		const many = Array.from({ length: 100 }, (_, index) => `s=${index}`);
		const h = await loaded(many, { hasMore: true, continuation: "c0" });
		for (let round = 1; round < 20; round += 1) {
			const cursors = Array.from(
				{ length: 100 },
				(_, index) => `r${round}-${index}`,
			);
			h.query.mockResolvedValueOnce(
				page(cursors, { hasMore: true, continuation: `c${round}` }),
			);
			await h.view.loadMore("bottom");
		}
		expect(h.view.rows).toHaveLength(2000);
		expect(h.view.capped).toBe(false);
		h.query.mockResolvedValueOnce(
			page(["extra-1", "extra-2"], { hasMore: true, continuation: "c20" }),
		);
		await h.view.loadMore("bottom");
		expect(h.view.rows).toHaveLength(2000);
		expect(h.view.rows.at(-1)?.key).toBe("r19-99");
		expect(h.view.capped).toBe(true);
		await h.view.loadMore("bottom");
		expect(h.query).toHaveBeenCalledTimes(21);
		h.query.mockResolvedValueOnce(page([]));
		await h.view.reset();
		expect(h.view.capped).toBe(false);
	});
});

describe("RawView: reset", () => {
	it("empties the rows and asks for the first page with no continuation", async () => {
		const h = await loaded(["s=2"], { hasMore: true, continuation: "c1" });
		h.query.mockResolvedValueOnce(page(["s=3"]));
		const done = resetRawView(h.view);
		expect(h.view.rows).toEqual([]);
		expect(h.view.loading).toBe("first");
		expect(h.view.bottom?.continuation).toBeNull();
		await done;
		expect(h.query).toHaveBeenLastCalledWith(DEFAULT_INPUT);
		expect(keys(h.view)).toEqual(["s=3"]);
	});

	it("drops held entries and leaves anchor mode", async () => {
		const h = harness();
		expect(h.view.start(around())).toBeInstanceOf(Promise);
		h.query.mockResolvedValueOnce(page(["s=9"]));
		await h.view.reset();
		expect(h.view.anchor).toBeNull();
		expect(h.view.top).toBeNull();
		expect(h.view.held).toEqual([]);
		expect(keys(h.view)).toEqual(["s=9"]);
	});
});

function around(patch: Partial<AroundPage> = {}): AroundPage {
	const olderQuery = {
		...DEFAULT_INPUT,
		boot: BOOT,
		limit: 50,
	} as AroundPage["olderQuery"];
	const newerQuery = {
		...DEFAULT_INPUT,
		boot: BOOT,
		direction: "newer",
		limit: 50,
	} as AroundPage["newerQuery"];
	return {
		ok: true,
		anchor: entry("s=5"),
		approximate: false,
		older: page(["s=4", "s=3"], { hasMore: true, continuation: "older-c" }),
		newer: page(["s=6", "s=7"], { hasMore: null, continuation: "newer-c" }),
		olderQuery,
		newerQuery,
		...patch,
	};
}

describe("RawView: anchor mode", () => {
	it("shows newer entries above the anchor and older below, newest first", () => {
		const h = harness();
		h.view.start(around());
		expect(h.query).not.toHaveBeenCalled();
		expect(keys(h.view)).toEqual(["s=7", "s=6", "s=5", "s=4", "s=3"]);
		expect(h.view.anchor).toEqual({
			cursor: "s=5",
			approximate: false,
			level: "info",
		});
		expect(h.view.newestFirst).toBe(true);
		expect(h.view.loading).toBeNull();
		expect(h.view.followBusy).toBe(false);
		expect(h.view.top).toEqual({
			query: around().newerQuery,
			continuation: "newer-c",
			hasMore: null,
			lost: false,
		});
		expect(h.view.bottom).toEqual({
			query: around().olderQuery,
			continuation: "older-c",
			hasMore: true,
			lost: false,
		});
	});

	it("never shows a repeated entry twice", () => {
		const h = harness();
		h.view.start(around({ older: page(["s=5", "s=4"]) }));
		expect(keys(h.view)).toEqual(["s=7", "s=6", "s=5", "s=4"]);
	});

	it("states an approximate anchor with no exact entry", () => {
		const h = harness();
		h.view.start(around({ anchor: null, approximate: true }));
		expect(h.view.anchor).toEqual({
			cursor: null,
			approximate: true,
			level: "info",
		});
		expect(keys(h.view)).toEqual(["s=7", "s=6", "s=4", "s=3"]);
	});

	it("pages each side with the around query and that page's continuation", async () => {
		const h = harness();
		const result = around();
		h.view.start(result);
		h.query.mockResolvedValueOnce(page(["s=2"]));
		await h.view.loadMore("bottom");
		expect(h.query).toHaveBeenLastCalledWith({
			...result.olderQuery,
			continuation: "older-c",
		});
		h.query.mockResolvedValueOnce(page(["s=8", "s=9"], { hasMore: false }));
		await h.view.loadMore("top");
		expect(h.query).toHaveBeenLastCalledWith({
			...result.newerQuery,
			continuation: "newer-c",
		});
		expect(keys(h.view)).toEqual([
			"s=9",
			"s=8",
			"s=7",
			"s=6",
			"s=5",
			"s=4",
			"s=3",
			"s=2",
		]);
		expect(h.view.top).toMatchObject({ continuation: null, hasMore: false });
	});

	it("repeats a side's around query when its budget page has no continuation", async () => {
		const h = harness();
		const result = around({
			anchor: null,
			approximate: true,
			newer: page([], {
				hasMore: null,
				termination: "budget",
				continuation: null,
			}),
		});
		h.view.start(result);
		expect(keys(h.view)).toEqual(["s=4", "s=3"]);
		h.query.mockResolvedValueOnce(page(["s=8", "s=9"], { hasMore: false }));
		await h.view.loadMore("top");
		expect(h.query).toHaveBeenCalledExactlyOnceWith(result.newerQuery);
		expect(keys(h.view)).toEqual(["s=9", "s=8", "s=4", "s=3"]);
		expect(h.view.top).toMatchObject({ continuation: null, hasMore: false });
	});

	it("blocks Follow in anchor mode and leaves it on a filter change", async () => {
		const h = harness();
		h.view.start(around());
		expect(h.view.followBlocked).toBe("anchor");
		h.query.mockResolvedValueOnce(page([]));
		await h.view.setLevel("errors");
		expect(h.view.anchor).toBeNull();
		expect(h.view.followBlocked).toBeNull();
	});

	it("shows the level its window reads, then the operator's level for the latest entries", async () => {
		const h = harness();
		const levels = ["error", "warning", "info", "debug"] as const;
		const result = around();
		h.view.start({
			...result,
			olderQuery: { ...result.olderQuery, levels: [...levels] },
			newerQuery: { ...result.newerQuery, levels: [...levels] },
		});
		expect(h.view.anchor?.level).toBe("everything");
		expect(h.view.filter.level).toBe("info");
		h.query.mockResolvedValueOnce(page(["s=20"]));
		await h.view.reset();
		expect(h.query).toHaveBeenLastCalledWith(DEFAULT_INPUT);
		expect(h.view.anchor).toBeNull();
	});

	it("goes back to the latest entries", async () => {
		const h = harness();
		h.view.start(around());
		h.query.mockResolvedValueOnce(page(["s=20"]));
		await h.view.reset();
		expect(h.query).toHaveBeenLastCalledWith(DEFAULT_INPUT);
		expect(h.view.anchor).toBeNull();
	});

	it("drops the far end when newer pages pass the cap", async () => {
		const h = harness();
		const older = Array.from({ length: 1999 }, (_, index) => `o${index}`);
		h.view.start(
			around({
				older: page(older, { hasMore: true, continuation: "o1" }),
				newer: page([], { hasMore: true, continuation: "n1" }),
			}),
		);
		h.query.mockResolvedValueOnce(
			page(["n-a", "n-b"], { hasMore: true, continuation: "n2" }),
		);
		await h.view.loadMore("top");
		expect(h.view.rows).toHaveLength(2000);
		expect(h.view.rows[0]?.key).toBe("n-b");
		expect(h.view.capped).toBe(true);
		await h.view.loadMore("bottom");
		expect(h.query).toHaveBeenCalledTimes(1);
		h.query.mockResolvedValueOnce(page(["n-c"]));
		await h.view.loadMore("top");
		expect(h.query).toHaveBeenLastCalledWith({
			...around().newerQuery,
			continuation: "n2",
		});
		expect(h.view.rows[0]?.key).toBe("n-c");
	});
});

describe("RawView: follow availability", () => {
	it("is blocked by Oldest first, a time window or a chosen boot", async () => {
		const h = await loaded([]);
		h.query.mockResolvedValue(page([]));
		expect(h.view.followBlocked).toBeNull();
		await h.view.setOrder("oldest");
		expect(h.view.followBlocked).toBe("filter");
		expect(h.followStop).not.toHaveBeenCalled();
		await h.view.startFollow();
		expect(h.followStart).not.toHaveBeenCalled();
	});
});

describe("RawView: follow", () => {
	it("starts after the newest row and listens for batches", async () => {
		const h = await loaded(["s=3", "s=2"]);
		const reply = deferred<LogFollowStartOutput>();
		h.followStart.mockReturnValueOnce(reply.promise);
		const done = h.view.startFollow();
		expect(h.view.follow).toBe("starting");
		expect(h.view.followBusy).toBe(true);
		expect(h.setFollowListener).toHaveBeenLastCalledWith(expect.any(Function));
		expect(h.followStart).toHaveBeenCalledExactlyOnceWith({
			sources: [],
			levels: ["error", "warning", "info"],
			afterCursor: "s=3",
		});
		reply.resolve({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: "s=3",
		});
		await done;
		expect(h.view.follow).toBe("following");
		expect(h.view.followBusy).toBe(false);
		expect(h.view.announcement).toMatchObject({ kind: "following" });
	});

	it("starts without a cursor on an empty view", async () => {
		const h = await loaded([]);
		startsAfter(h, "head");
		h.query.mockResolvedValueOnce(page([]));
		await h.view.startFollow();
		// With no position, Follow learns the device head, stops, reads the head again, then starts after it.
		expect(h.followStart.mock.calls).toEqual([
			[{ sources: [], levels: ["error", "warning", "info"] }],
			[
				{
					sources: [],
					levels: ["error", "warning", "info"],
					afterCursor: "head",
				},
			],
		]);
		expect(h.followStop).toHaveBeenCalledOnce();
		expect(h.query).toHaveBeenCalledTimes(2);
		expect(h.query).toHaveBeenLastCalledWith(DEFAULT_INPUT);
		expect(h.followStop.mock.invocationCallOrder[0]).toBeLessThan(
			h.query.mock.invocationCallOrder[1] ?? 0,
		);
		expect(h.view.follow).toBe("following");
		expect(h.view.announcement).toMatchObject({ kind: "following" });
	});

	it("keeps the cursor-less follow when the boot has no record yet", async () => {
		const h = await loaded([]);
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: null,
		});
		await h.view.startFollow();
		expect(h.followStart).toHaveBeenCalledOnce();
		expect(h.followStop).not.toHaveBeenCalled();
		expect(h.query).toHaveBeenCalledOnce();
		expect(h.view.follow).toBe("following");
		h.push({ entries: [entry("first")], checkpointCursor: "first" });
		expect(keys(h.view)).toEqual(["first"]);
	});

	it("leaves Follow idle when the read after learning the head fails, and learns it again", async () => {
		const h = await loaded([]);
		startsAfter(h, "head");
		h.query.mockResolvedValueOnce({ ok: false, error: "READ_FAILED" });
		await h.view.startFollow();
		expect(h.view.follow).toBe("idle");
		expect(h.view.failure).toEqual({ code: "READ_FAILED", op: "first" });
		h.query.mockResolvedValueOnce(page([]));
		await h.view.retry();
		h.query.mockResolvedValueOnce(page([]));
		await h.view.startFollow();
		expect(h.followStart).toHaveBeenCalledTimes(3);
		expect(h.followStart).toHaveBeenNthCalledWith(2, {
			sources: [],
			levels: ["error", "warning", "info"],
		});
		expect(h.followStart).toHaveBeenLastCalledWith({
			sources: [],
			levels: ["error", "warning", "info"],
			afterCursor: "head",
		});
		expect(h.view.follow).toBe("following");
	});

	it("prepends batches newest first and adds no duplicate", async () => {
		const h = await following();
		h.push({
			entries: [entry("s=3"), entry("s=4"), entry("s=5")],
			checkpointCursor: "s=5",
		});
		expect(keys(h.view)).toEqual(["s=5", "s=4", "s=3", "s=2"]);
		h.push({ entries: [entry("s=5")], checkpointCursor: "s=5" });
		expect(keys(h.view)).toEqual(["s=5", "s=4", "s=3", "s=2"]);
	});

	it("retains the start checkpoint across disconnect before the first batch", async () => {
		const h = await loaded([]);
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: "start-head",
		});
		h.query.mockResolvedValueOnce(page([]));
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: "start-head",
		});
		await h.view.startFollow();
		h.view.connectionChanged("disconnected");
		h.view.connectionChanged("connected");
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-2",
			checkpointCursor: "resumed-head",
		});
		await h.view.startFollow();
		expect(h.followStart).toHaveBeenLastCalledWith({
			sources: [],
			levels: ["error", "warning", "info"],
			afterCursor: "start-head",
		});
	});

	it("ignores an older start reply after a filter change starts a newer follow", async () => {
		const h = await loaded([]);
		const oldReply = deferred<LogFollowStartOutput>();
		const newReply = deferred<LogFollowStartOutput>();
		const newerStarted = deferred<void>();
		h.followStart
			.mockReturnValueOnce(oldReply.promise)
			.mockImplementationOnce(() => {
				newerStarted.resolve();
				return newReply.promise;
			})
			.mockResolvedValueOnce({
				ok: true,
				subscriptionId: "sub-new",
				checkpointCursor: "new-head",
			});
		h.followStop.mockResolvedValue({ success: true, checkpointCursor: null });
		const oldStart = h.view.startFollow();
		h.query.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([]));
		const changed = h.view.setLevel("errors");
		expect(h.followStop).toHaveBeenCalledTimes(1);
		await newerStarted.promise;
		newReply.resolve({
			ok: true,
			subscriptionId: "sub-new",
			checkpointCursor: "new-head",
		});
		await changed;
		oldReply.resolve({
			ok: true,
			subscriptionId: "sub-old",
			checkpointCursor: "old-head",
		});
		await oldStart;
		h.push({
			subscriptionId: "sub-new",
			entries: [entry("current")],
			checkpointCursor: "current",
		});
		expect(keys(h.view)).toEqual(["current"]);
		expect(h.view.follow).toBe("following");
	});

	it.each([1, 3])(
		"adds one marker row for %i entries dropped while following",
		async (dropped) => {
			const h = await following();
			h.push({ entries: [entry("s=4")], dropped, checkpointCursor: "s=9" });
			expect(h.view.rows[0]).toMatchObject({
				kind: "marker",
				marker: "dropped",
				count: dropped,
			});
			expect(h.view.rows.filter((row) => row.kind === "marker")).toHaveLength(
				1,
			);
			expect(h.view.announcement).toMatchObject({ kind: "gap", count: 0 });
		},
	);

	it("marks a gap and announces it", async () => {
		const h = await following();
		h.push({ gap: "catchup_exceeded", checkpointCursor: "s=40" });
		expect(h.view.rows[0]).toMatchObject({
			kind: "marker",
			key: "gap-1",
			marker: "catchupExceeded",
		});
		expect(h.view.announcement).toMatchObject({ kind: "gap" });
	});

	it("ignores messages for another subscription", async () => {
		const h = await following();
		h.push({ subscriptionId: "old", entries: [entry("s=9")] });
		expect(keys(h.view)).toEqual(["s=3", "s=2"]);
	});

	it("holds messages that arrive before the reply and applies only its own", async () => {
		const h = await loaded(["s=2"]);
		const reply = deferred<LogFollowStartOutput>();
		h.followStart.mockReturnValueOnce(reply.promise);
		const done = h.view.startFollow();
		h.push({
			subscriptionId: "sub-1",
			gap: "cursor_unavailable",
			checkpointCursor: null,
		});
		h.push({ subscriptionId: "other", entries: [entry("x")] });
		expect(keys(h.view)).toEqual(["s=2"]);
		reply.resolve({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: "head",
		});
		await done;
		expect(h.view.rows.map((row) => row.kind)).toEqual(["marker", "entry"]);
		expect(h.view.rows[0]).toMatchObject({ marker: "cursorUnavailable" });
	});

	it("never loses the resumable position to a message without one", async () => {
		const h = await following();
		h.push({ gap: "cursor_unavailable", checkpointCursor: null });
		h.followStop.mockResolvedValueOnce({
			success: false,
			checkpointCursor: null,
		});
		await h.view.pauseFollow();
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-2",
			checkpointCursor: "s=3",
		});
		await h.view.startFollow();
		expect(h.followStart).toHaveBeenLastCalledWith(
			expect.objectContaining({ afterCursor: "s=3" }),
		);
	});

	it("resumes from the checkpoint of the last batch", async () => {
		const h = await following();
		h.push({ entries: [entry("s=4")], checkpointCursor: "s=6" });
		h.followStop.mockResolvedValueOnce({
			success: false,
			checkpointCursor: null,
		});
		await h.view.pauseFollow();
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-2",
			checkpointCursor: "s=6",
		});
		await h.view.startFollow();
		expect(h.followStart).toHaveBeenLastCalledWith(
			expect.objectContaining({ afterCursor: "s=6" }),
		);
	});

	it("with no rows, pause before any batch then resume uses the stop checkpoint", async () => {
		const h = await loaded([]);
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: "head-1",
		});
		h.query.mockResolvedValueOnce(page([]));
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: "head-1",
		});
		await h.view.startFollow();
		h.followStop.mockResolvedValueOnce({
			success: true,
			checkpointCursor: "head-2",
		});
		const pausing = h.view.pauseFollow();
		expect(h.view.follow).toBe("paused");
		expect(h.view.followBusy).toBe(true);
		expect(h.view.announcement).toEqual({
			kind: "paused",
			count: 0,
			serial: 2,
		});
		await pausing;
		expect(h.view.followBusy).toBe(false);
		expect(h.setFollowListener).toHaveBeenLastCalledWith(undefined);
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-2",
			checkpointCursor: "head-2",
		});
		await h.view.startFollow();
		expect(h.followStart).toHaveBeenLastCalledWith({
			sources: [],
			levels: ["error", "warning", "info"],
			afterCursor: "head-2",
		});
		expect(h.view.announcement).toMatchObject({ kind: "resumed" });
	});

	it("applies batches that arrive while the pause is being confirmed", async () => {
		const h = await following();
		const stop = deferred<LogFollowStopOutput>();
		h.followStop.mockReturnValueOnce(stop.promise);
		const pausing = h.view.pauseFollow();
		h.push({ entries: [entry("s=4")], checkpointCursor: "s=4" });
		expect(keys(h.view)).toEqual(["s=4", "s=3", "s=2"]);
		stop.resolve({ success: true, checkpointCursor: "s=4" });
		await pausing;
		h.push({ entries: [entry("s=5")], checkpointCursor: "s=5" });
		expect(keys(h.view)).toEqual(["s=4", "s=3", "s=2"]);
	});

	it("ignores an already queued listener callback after Pause completes", async () => {
		const h = await following();
		const staleListener = h.listener;
		expect(staleListener).toBeTypeOf("function");
		h.followStop.mockResolvedValueOnce({
			success: true,
			checkpointCursor: "s=3",
		});
		await h.view.pauseFollow();
		staleListener?.({
			subscriptionId: "sub-1",
			entries: [entry("late")],
			checkpointCursor: "late",
			dropped: 0,
		});
		expect(keys(h.view)).toEqual(["s=3", "s=2"]);
		expect(h.view.follow).toBe("paused");
	});

	it("keeps the last checkpoint when the stop call fails", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const h = await following();
		h.push({ entries: [entry("s=4")], checkpointCursor: "s=4" });
		h.followStop.mockRejectedValueOnce(new Error("closed"));
		await h.view.pauseFollow();
		expect(error).toHaveBeenCalledWith(
			"System Logs follow stop failed:",
			expect.any(Error),
		);
		expect(h.view.followBusy).toBe(false);
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-2",
			checkpointCursor: "s=4",
		});
		await h.view.startFollow();
		expect(h.followStart).toHaveBeenLastCalledWith(
			expect.objectContaining({ afterCursor: "s=4" }),
		);
	});

	it("does not pause twice or start while busy", async () => {
		const h = await following();
		const stop = deferred<LogFollowStopOutput>();
		h.followStop.mockReturnValueOnce(stop.promise);
		const pausing = h.view.pauseFollow();
		await h.view.pauseFollow();
		await h.view.startFollow();
		expect(h.followStop).toHaveBeenCalledTimes(1);
		expect(h.followStart).toHaveBeenCalledTimes(1);
		stop.resolve({ success: true, checkpointCursor: "s=3" });
		await pausing;
	});

	it("does not start a second follow while following", async () => {
		const h = await following();
		await h.view.startFollow();
		expect(h.followStart).toHaveBeenCalledTimes(1);
		expect(h.view.announcement).toEqual({
			kind: "following",
			count: 0,
			serial: 1,
		});
	});

	it("keeps the cap flag when a later batch adds nothing", async () => {
		const many = Array.from({ length: 2000 }, (_, index) => `s=${index}`);
		const h = await loaded(many);
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: "s=0",
		});
		await h.view.startFollow();
		h.push({ entries: [entry("new")], checkpointCursor: "new" });
		expect(h.view.capped).toBe(true);
		expect(h.view.rows.at(-1)?.key).toBe("s=1998");
		h.push({ entries: [entry("new")], checkpointCursor: "new" });
		expect(h.view.capped).toBe(true);
	});

	it("does not pause unless following", async () => {
		const h = await loaded([]);
		await h.view.pauseFollow();
		expect(h.followStop).not.toHaveBeenCalled();
	});

	it("reports a refused start and stops listening", async () => {
		const h = await loaded([]);
		h.followStart.mockResolvedValueOnce({ ok: false, error: "BUSY" });
		await h.view.startFollow();
		expect(h.view.follow).toBe("idle");
		expect(h.view.followBusy).toBe(false);
		expect(h.view.failure).toEqual({ code: "BUSY", op: "follow" });
		expect(h.setFollowListener).toHaveBeenLastCalledWith(undefined);
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: null,
		});
		await h.view.retry();
		expect(h.followStart).toHaveBeenCalledTimes(2);
		expect(h.view.follow).toBe("following");
		expect(h.view.failure).toBeNull();
	});

	it("reports a rejected start as READ_FAILED", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const h = await loaded([]);
		h.followStart.mockRejectedValueOnce(new Error("closed"));
		await h.view.startFollow();
		expect(h.view.failure).toEqual({ code: "READ_FAILED", op: "follow" });
		expect(error).toHaveBeenCalledWith(
			"System Logs follow start failed:",
			expect.any(Error),
		);
	});

	it("keeps a paging failure visible when Follow starts", async () => {
		const h = await loaded(["s=2"], { hasMore: true, continuation: "c1" });
		h.query.mockResolvedValueOnce({ ok: false, error: "CURSOR_UNAVAILABLE" });
		await h.view.loadMore("bottom");
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: "s=2",
		});
		await h.view.startFollow();
		expect(h.view.failure).toEqual({
			code: "CURSOR_UNAVAILABLE",
			op: "bottom",
		});
	});

	it("stops with the reader's reason and offers Follow from the checkpoint", async () => {
		const h = await following();
		h.push({
			entries: [entry("s=4")],
			checkpointCursor: "s=8",
			ended: "follower_exit",
		});
		expect(keys(h.view)).toEqual(["s=4", "s=3", "s=2"]);
		expect(h.view.follow).toBe("stopped");
		expect(h.view.ended).toBe("follower_exit");
		expect(h.view.announcement).toMatchObject({ kind: "stopped", count: 0 });
		expect(h.setFollowListener).toHaveBeenLastCalledWith(undefined);
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-2",
			checkpointCursor: "s=8",
		});
		await h.view.startFollow();
		expect(h.followStart).toHaveBeenLastCalledWith(
			expect.objectContaining({ afterCursor: "s=8" }),
		);
		expect(h.view.ended).toBeNull();
		expect(h.view.announcement).toMatchObject({ kind: "following" });
	});

	it("resets the list when the logs were cleared", async () => {
		const h = await following();
		h.query.mockResolvedValueOnce(page(["fresh"]));
		h.push({ ended: "cleared", checkpointCursor: "s=3" });
		expect(h.view.rows).toEqual([]);
		expect(h.view.loading).toBe("first");
		expect(h.view.follow).toBe("stopped");
		expect(h.view.ended).toBe("cleared");
		await vi.waitFor(() => expect(keys(h.view)).toEqual(["fresh"]));
		expect(h.query).toHaveBeenLastCalledWith(DEFAULT_INPUT);
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-2",
			checkpointCursor: "fresh",
		});
		await h.view.startFollow();
		expect(h.followStart).toHaveBeenLastCalledWith(
			expect.objectContaining({ afterCursor: "fresh" }),
		);
	});

	it("resets on Clear logs even while a Follow start still waits for its reply", async () => {
		const h = await loaded(["s=3", "s=2"]);
		const reply = deferred<LogFollowStartOutput>();
		h.followStart.mockReturnValueOnce(reply.promise);
		const starting = h.view.startFollow();
		h.query.mockResolvedValueOnce(page(["fresh"]));
		h.push({
			subscriptionId: "sub-unnamed",
			ended: "cleared",
			checkpointCursor: "s=3",
		});
		expect(h.view.rows).toEqual([]);
		expect(h.view.follow).toBe("stopped");
		expect(h.view.ended).toBe("cleared");
		// follow.ts fails a start that Clear logs stopped first; that stale reply changes nothing.
		reply.resolve({ ok: false, error: "READ_FAILED" });
		await starting;
		await vi.waitFor(() => expect(keys(h.view)).toEqual(["fresh"]));
		expect(h.view.failure).toBeNull();
		expect(h.view.follow).toBe("stopped");
	});

	it("keeps Follow busy while its start is pending, even when an older page lands", async () => {
		const h = await loaded(["s=2"], { hasMore: true, continuation: "c1" });
		const reply = deferred<LogFollowStartOutput>();
		h.followStart.mockReturnValueOnce(reply.promise);
		const starting = h.view.startFollow();
		h.query.mockResolvedValueOnce(page(["s=1"], { hasMore: false }));
		await h.view.loadMore("bottom");
		expect(keys(h.view)).toEqual(["s=2", "s=1"]);
		expect(h.view.followBusy).toBe(true);
		reply.resolve({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: "s=2",
		});
		await starting;
		expect(h.view.followBusy).toBe(false);
	});

	it("resumes after the position its start reply named when the device moved past the requested cursor", async () => {
		const h = await loaded(["s=3"]);
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: "head-now",
		});
		await h.view.startFollow();
		expect(h.followStart).toHaveBeenLastCalledWith(
			expect.objectContaining({ afterCursor: "s=3" }),
		);
		h.view.connectionChanged("disconnected");
		h.view.connectionChanged("connected");
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-2",
			checkpointCursor: "head-now",
		});
		await h.view.startFollow();
		expect(h.followStart).toHaveBeenLastCalledWith(
			expect.objectContaining({ afterCursor: "head-now" }),
		);
	});

	it("announces Follow once when a reset lands while its start is pending", async () => {
		const h = await loaded(["s=2"]);
		const first = deferred<LogFollowStartOutput>();
		h.followStart.mockReturnValueOnce(first.promise).mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-2",
			checkpointCursor: "s=2",
		});
		const starting = h.view.startFollow();
		h.query.mockResolvedValueOnce(page(["s=2"]));
		await h.view.reset();
		expect(h.view.follow).toBe("following");
		expect(h.view.announcement).toMatchObject({ kind: "following" });
		first.resolve({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: "s=2",
		});
		await starting;
		expect(h.view.follow).toBe("following");
		expect(h.followStart).toHaveBeenCalledTimes(2);
	});

	it("learns the device head again after a filter change to an empty page", async () => {
		const h = await following();
		h.query.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([]));
		startsAfter(h, "head-now");
		await h.view.setLevel("errors");
		expect(h.followStart).toHaveBeenNthCalledWith(2, {
			sources: [],
			levels: ["error"],
		});
		expect(h.followStart).toHaveBeenLastCalledWith({
			sources: [],
			levels: ["error"],
			afterCursor: "head-now",
		});
	});

	it("stays disconnected when the read after learning the head fails because the socket dropped", async () => {
		const h = await loaded([]);
		startsAfter(h, "head");
		const read = deferred<LogQueryOutput>();
		const asked = deferred<void>();
		h.query.mockImplementationOnce(() => {
			asked.resolve();
			return read.promise;
		});
		const starting = h.view.startFollow();
		await asked.promise;
		h.view.connectionChanged("disconnected");
		read.resolve({ ok: false, error: "READ_FAILED" });
		await starting;
		expect(h.view.follow).toBe("disconnected");
	});

	it("learns the device head again after Clear logs leaves nothing", async () => {
		const h = await following();
		h.query.mockResolvedValueOnce(page([]));
		h.push({ ended: "cleared", checkpointCursor: "s=3" });
		await vi.waitFor(() => expect(h.view.loading).toBeNull());
		startsAfter(h, "head-now");
		h.query.mockResolvedValueOnce(page([]));
		await h.view.startFollow();
		expect(h.followStart).toHaveBeenNthCalledWith(2, {
			sources: [],
			levels: ["error", "warning", "info"],
		});
	});

	it("restarts the follow with a new filter after the new first page", async () => {
		const h = await following();
		h.followStop.mockResolvedValueOnce({
			success: true,
			checkpointCursor: "s=3",
		});
		h.query.mockResolvedValueOnce(page(["e=2"]));
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-2",
			checkpointCursor: "e=2",
		});
		await h.view.setLevel("errors");
		expect(h.followStop).toHaveBeenCalledTimes(1);
		expect(h.followStart).toHaveBeenLastCalledWith({
			sources: [],
			levels: ["error"],
			afterCursor: "e=2",
		});
		expect(h.view.follow).toBe("following");
		h.push({ subscriptionId: "sub-1", entries: [entry("stale")] });
		expect(keys(h.view)).toEqual(["e=2"]);
	});

	it("stops following when the new filter cannot follow", async () => {
		const h = await following();
		h.followStop.mockResolvedValueOnce({
			success: true,
			checkpointCursor: "s=3",
		});
		h.query.mockResolvedValueOnce(page([]));
		await h.view.setOrder("oldest");
		expect(h.followStart).toHaveBeenCalledTimes(1);
		expect(h.view.follow).toBe("idle");
		expect(h.setFollowListener).toHaveBeenLastCalledWith(undefined);
	});

	it("forgets a paused position when the filter changes", async () => {
		const h = await following();
		h.followStop.mockResolvedValueOnce({
			success: true,
			checkpointCursor: "old",
		});
		await h.view.pauseFollow();
		h.query.mockResolvedValueOnce(page(["n=1"]));
		await h.view.setLevel("everything");
		expect(h.view.follow).toBe("idle");
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-2",
			checkpointCursor: "n=1",
		});
		await h.view.startFollow();
		expect(h.followStart).toHaveBeenLastCalledWith(
			expect.objectContaining({ afterCursor: "n=1" }),
		);
	});

	it("keeps following across a plain reset", async () => {
		const h = await following();
		h.query.mockResolvedValueOnce(page(["s=3", "s=2"]));
		startsAfter(h, "s=3");
		await h.view.reset();
		expect(h.followStart).toHaveBeenLastCalledWith(
			expect.objectContaining({ afterCursor: "s=3" }),
		);
		h.push({ entries: [entry("s=3"), entry("s=4")], checkpointCursor: "s=4" });
		expect(keys(h.view)).toEqual(["s=4", "s=3", "s=2"]);
		expect(h.view.follow).toBe("following");
	});
});

describe("RawView: held entries", () => {
	it("keeps separate gap rows across repeated held-buffer overflows", async () => {
		const h = await following();
		for (const cycle of [0, 1]) {
			h.view.setAtTop(false);
			h.push({
				entries: Array.from({ length: 501 }, (_, index) =>
					entry(`burst-${cycle}-${index}`),
				),
				checkpointCursor: `burst-${cycle}-500`,
			});
			h.view.showHeld();
		}
		const markers = h.view.rows.filter((row) => row.kind === "marker");
		expect(markers.map((row) => row.count)).toEqual([1, 1]);
		expect(new Set(markers.map((row) => row.key)).size).toBe(2);
	});

	it("drops both held rows and their overflow count on reset", async () => {
		const h = await following();
		h.view.setAtTop(false);
		h.push({
			entries: Array.from({ length: 503 }, (_, index) => entry(`old-${index}`)),
			checkpointCursor: "old-502",
		});
		h.query.mockResolvedValueOnce(page(["fresh"]));
		startsAfter(h, "fresh");
		await h.view.reset();
		expect(h.view.held).toEqual([]);
		h.push({ entries: [entry("next")], checkpointCursor: "next" });
		h.view.showHeld();
		expect(keys(h.view)).toEqual(["next", "fresh"]);
	});

	it("forgets the held overflow count when a reset finds nothing", async () => {
		const h = await following();
		h.view.setAtTop(false);
		h.push({
			entries: Array.from({ length: 503 }, (_, index) => entry(`old-${index}`)),
			checkpointCursor: "old-502",
		});
		h.query.mockResolvedValueOnce(page([]));
		startsAfter(h, "old-502");
		await h.view.reset();
		h.view.setAtTop(false);
		h.push({ entries: [entry("next")], checkpointCursor: "next" });
		h.view.showHeld();
		expect(keys(h.view)).toEqual(["next"]);
	});

	it("keeps a gap notice the held cap cut, and counts only its entries", async () => {
		const h = await following();
		h.view.setAtTop(false);
		h.push({
			entries: [entry("g-0")],
			checkpointCursor: "g-0",
			gap: "catchup_exceeded",
		});
		h.push({
			entries: Array.from({ length: 600 }, (_, index) => entry(`h-${index}`)),
			checkpointCursor: "h-599",
		});
		h.view.showHeld();
		expect(h.view.rows.filter((row) => row.kind === "marker")).toEqual([
			expect.objectContaining({ marker: "catchupExceeded" }),
			expect.objectContaining({ marker: "dropped", count: 101 }),
		]);
	});

	it("clears the stopped reason on a filter change", async () => {
		const h = await following();
		h.push({ ended: "follower_exit" });
		h.query.mockResolvedValueOnce(page([]));
		await h.view.setLevel("errors");
		expect(h.view.ended).toBeNull();
		expect(h.view.follow).toBe("idle");
	});

	it("holds entries while scrolled away from the top and merges them on request", async () => {
		const h = await following();
		h.view.setAtTop(false);
		h.push({ entries: [entry("s=4"), entry("s=5")], checkpointCursor: "s=5" });
		expect(keys(h.view)).toEqual(["s=3", "s=2"]);
		expect(h.view.held.map((row) => row.key)).toEqual(["s=5", "s=4"]);
		h.push({ entries: [entry("s=5"), entry("s=6")], checkpointCursor: "s=6" });
		expect(h.view.held.map((row) => row.key)).toEqual(["s=6", "s=5", "s=4"]);
		h.view.showHeld();
		expect(keys(h.view)).toEqual(["s=6", "s=5", "s=4", "s=3", "s=2"]);
		expect(h.view.held).toEqual([]);
		h.push({ entries: [entry("s=7")], checkpointCursor: "s=7" });
		expect(keys(h.view)[0]).toBe("s=7");
	});

	it("keeps the newest 500 held entries and states how many were skipped", async () => {
		const h = await following();
		h.view.setAtTop(false);
		const burst = Array.from({ length: 503 }, (_, index) => entry(`b${index}`));
		h.push({ entries: burst, checkpointCursor: "b502" });
		expect(h.view.held).toHaveLength(500);
		expect(h.view.held[0]?.key).toBe("b502");
		expect(h.view.held.at(-1)?.key).toBe("b3");
		h.view.showHeld();
		expect(h.view.rows[500]).toMatchObject({
			kind: "marker",
			marker: "dropped",
			count: 3,
		});
		expect(h.view.rows[501]?.key).toBe("s=3");
		h.view.setAtTop(false);
		h.push({ entries: [entry("z")], checkpointCursor: "z" });
		h.view.showHeld();
		expect(h.view.rows.filter((row) => row.kind === "marker")).toHaveLength(1);
	});

	it("keeps holding while entries wait, even back at the top, so order holds", async () => {
		const h = await following();
		h.view.setAtTop(false);
		h.push({ entries: [entry("s=4")], checkpointCursor: "s=4" });
		h.view.setAtTop(true);
		h.push({ entries: [entry("s=5")], checkpointCursor: "s=5" });
		expect(keys(h.view)).toEqual(["s=3", "s=2"]);
		h.view.showHeld();
		expect(keys(h.view)).toEqual(["s=5", "s=4", "s=3", "s=2"]);
	});

	it("drops held entries that repeat a shown row", async () => {
		const h = await following();
		h.view.setAtTop(false);
		h.push({ entries: [entry("s=3"), entry("s=4")], checkpointCursor: "s=4" });
		expect(h.view.held.map((row) => row.key)).toEqual(["s=4"]);
	});
});

describe("RawView: connection", () => {
	it("switches a live follow to Disconnected and resumes only when asked", async () => {
		const h = await following();
		expect(h.view.stale).toBe(false);
		h.view.connectionChanged("disconnected");
		expect(h.view.connected).toBe(false);
		expect(h.view.stale).toBe(true);
		expect(h.view.follow).toBe("disconnected");
		expect(h.view.followBusy).toBe(false);
		expect(h.view.announcement).toMatchObject({
			kind: "disconnected",
			count: 0,
		});
		expect(h.setFollowListener).toHaveBeenLastCalledWith(undefined);
		await h.view.startFollow();
		expect(h.followStart).toHaveBeenCalledTimes(1);
		const serial = h.view.announcement?.serial;
		h.view.connectionChanged("disconnected");
		expect(h.view.announcement?.serial).toBe(serial);
		h.view.connectionChanged("connected");
		expect(h.view.connected).toBe(true);
		expect(h.view.follow).toBe("disconnected");
		expect(h.view.stale).toBe(true);
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-2",
			checkpointCursor: "s=3",
		});
		await h.view.startFollow();
		expect(h.view.stale).toBe(false);
		expect(h.followStart).toHaveBeenLastCalledWith(
			expect.objectContaining({ afterCursor: "s=3" }),
		);
		expect(h.view.announcement).toMatchObject({ kind: "resumed" });
	});

	it("ignores a start reply that lands after the socket dropped", async () => {
		const h = await loaded([]);
		const reply = deferred<LogFollowStartOutput>();
		h.followStart.mockReturnValueOnce(reply.promise);
		const done = h.view.startFollow();
		h.view.connectionChanged("disconnected");
		reply.resolve({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: "head",
		});
		await done;
		expect(h.view.follow).toBe("disconnected");
		expect(h.followStop).not.toHaveBeenCalled();
	});

	it("keeps a paused follow paused and drops the pending stop", async () => {
		const h = await following();
		const stop = deferred<LogFollowStopOutput>();
		h.followStop.mockReturnValueOnce(stop.promise);
		const pausing = h.view.pauseFollow();
		h.view.connectionChanged("disconnected");
		expect(h.view.follow).toBe("paused");
		expect(h.view.followBusy).toBe(false);
		stop.resolve({ success: true, checkpointCursor: "late" });
		await pausing;
		h.view.connectionChanged("connected");
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-2",
			checkpointCursor: "s=3",
		});
		await h.view.startFollow();
		expect(h.followStart).toHaveBeenLastCalledWith(
			expect.objectContaining({ afterCursor: "s=3" }),
		);
	});

	it("changes nothing for an idle view or a repeated state", async () => {
		const h = await loaded([]);
		h.view.connectionChanged("connected");
		expect(h.view.announcement).toBeNull();
		h.view.connectionChanged("disconnected");
		expect(h.view.follow).toBe("idle");
		expect(h.view.stale).toBe(true);
		expect(h.view.announcement).toBeNull();
		expect(h.setFollowListener).not.toHaveBeenCalled();
		h.view.connectionChanged("reconnecting" as never);
		expect(h.view.connected).toBe(false);
	});

	it("leaves a stopped follow stopped", async () => {
		const h = await following();
		h.push({ ended: "follower_exit" });
		h.view.connectionChanged("disconnected");
		expect(h.view.follow).toBe("stopped");
	});

	it("does not start while disconnected", async () => {
		const h = await loaded([]);
		h.view.connectionChanged("disconnected");
		await h.view.startFollow();
		expect(h.followStart).not.toHaveBeenCalled();
	});
});

describe("RawView: announcements", () => {
	it("announces Stopped when the follower ends before its start reply", async () => {
		const h = await loaded(["s=2"]);
		const reply = deferred<LogFollowStartOutput>();
		h.followStart.mockReturnValueOnce(reply.promise);
		const starting = h.view.startFollow();
		h.push({ ended: "follower_exit" });

		reply.resolve({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: "s=2",
		});
		await starting;

		expect(h.view.announcement).toMatchObject({ kind: "stopped" });
	});

	it("summarises new entries at most every 5 seconds", async () => {
		const h = await following([]);
		h.push({ entries: [entry("a")], checkpointCursor: "a" });
		expect(h.view.announcement).toMatchObject({ kind: "newEntries", count: 1 });
		const serial = h.view.announcement?.serial;
		h.advance(4999);
		h.push({ entries: [entry("b"), entry("c")], checkpointCursor: "c" });
		expect(h.view.announcement?.serial).toBe(serial);
		h.advance(1);
		h.push({ entries: [entry("d")], checkpointCursor: "d" });
		expect(h.view.announcement).toMatchObject({ kind: "newEntries", count: 3 });
		expect(h.view.announcement?.serial).toBe((serial ?? 0) + 1);
	});

	it("does not announce a batch that added nothing", async () => {
		const h = await following();
		const before = h.view.announcement;
		h.push({ entries: [entry("s=3")], checkpointCursor: "s=3" });
		expect(h.view.announcement).toBe(before);
	});
});

describe("RawView: dispose", () => {
	it("stops a live follow and clears the listener", async () => {
		const h = await following();
		h.followStop.mockResolvedValueOnce({
			success: true,
			checkpointCursor: "s=3",
		});
		h.view.dispose();
		expect(h.followStop).toHaveBeenCalledTimes(1);
		expect(h.setFollowListener).toHaveBeenLastCalledWith(undefined);
		h.push({ entries: [entry("late")] });
		expect(keys(h.view)).toEqual(["s=3", "s=2"]);
	});

	it("stops a follow whose start reply arrives after unmount", async () => {
		const h = await loaded([]);
		const reply = deferred<LogFollowStartOutput>();
		h.followStart.mockReturnValueOnce(reply.promise);
		h.followStop.mockResolvedValue({ success: false, checkpointCursor: null });
		const done = h.view.startFollow();
		h.view.dispose();
		expect(h.followStop).toHaveBeenCalledTimes(1);
		reply.resolve({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: "head",
		});
		await done;
		expect(h.followStop).toHaveBeenCalledTimes(2);
		expect(h.view.follow).toBe("starting");
	});

	it("leaves a newer view's follow alone when an old start reply lands", async () => {
		const old = await loaded([]);
		const reply = deferred<LogFollowStartOutput>();
		old.followStart.mockReturnValueOnce(reply.promise);
		old.followStop.mockResolvedValue({
			success: false,
			checkpointCursor: null,
		});
		const done = old.view.startFollow();
		old.view.dispose();
		const next = await loaded([]);
		next.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-9",
			checkpointCursor: null,
		});
		await next.view.startFollow();
		reply.resolve({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: "head",
		});
		await done;
		expect(old.followStop).toHaveBeenCalledTimes(1);
	});

	it("does not stop when nothing follows and reports a failed stop", async () => {
		const idle = await loaded([]);
		idle.view.dispose();
		expect(idle.followStop).not.toHaveBeenCalled();

		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const h = await following();
		h.followStop.mockRejectedValueOnce(new Error("closed"));
		h.view.dispose();
		await vi.waitFor(() =>
			expect(error).toHaveBeenCalledWith(
				"System Logs follow stop failed:",
				expect.any(Error),
			),
		);
	});

	it("ignores both outstanding generations after unmount", async () => {
		const h = harness();
		const oldReply = deferred<LogQueryOutput>();
		const newReply = deferred<LogQueryOutput>();
		h.query
			.mockReturnValueOnce(oldReply.promise)
			.mockReturnValueOnce(newReply.promise);
		const old = h.view.start();
		const next = h.view.setLevel("errors");
		h.view.dispose();
		oldReply.resolve(page(["old"]));
		await old;
		expect(h.view.rows).toEqual([]);
		newReply.resolve(page(["new"]));
		await next;
		expect(h.view.rows).toEqual([]);
	});

	it("ignores a first page that arrives after unmount", async () => {
		const h = harness();
		const late = deferred<LogQueryOutput>();
		h.query.mockReturnValueOnce(late.promise);
		const done = h.view.start();
		h.view.dispose();
		late.resolve(page(["s=1"]));
		await done;
		expect(h.view.rows).toEqual([]);
	});

	it("never takes the follow or the listener after dispose", async () => {
		const h = await loaded(["s=1"]);
		h.view.dispose();
		await h.view.startFollow();
		expect(h.followStart).not.toHaveBeenCalled();
		expect(h.setFollowListener).not.toHaveBeenCalled();
	});

	it("does nothing when disposed again", async () => {
		const h = await following();
		h.followStop.mockResolvedValue({ success: true, checkpointCursor: "s=3" });
		h.view.dispose();
		const listened = h.setFollowListener.mock.calls.length;
		h.view.dispose();
		expect(h.followStop).toHaveBeenCalledTimes(1);
		expect(h.setFollowListener).toHaveBeenCalledTimes(listened);
	});

	it("sends no second stop when disposed twice while its start is pending", async () => {
		const h = await loaded([]);
		const reply = deferred<LogFollowStartOutput>();
		h.followStart.mockReturnValueOnce(reply.promise);
		h.followStop.mockResolvedValue({ success: false, checkpointCursor: null });
		const done = h.view.startFollow();
		h.view.dispose();
		h.view.dispose();
		expect(h.followStop).toHaveBeenCalledTimes(1);
		reply.resolve({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: "head",
		});
		await done;
		// The late reply's own stop, exactly as after one dispose.
		expect(h.followStop).toHaveBeenCalledTimes(2);
	});

	/** A view mounted after `h`'s on the same socket and listener slot, as when the tab is reopened. */
	async function replacement(h: ReturnType<typeof harness>) {
		const view = new RawView({
			logs: {
				query: h.query,
				followStart: h.followStart,
				followStop: h.followStop,
			},
			setFollowListener: h.setFollowListener,
			now: () => NOW,
		});
		views.push(view);
		h.query.mockResolvedValueOnce(page(["s=2", "s=1"]));
		await view.start();
		h.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-2",
			checkpointCursor: "s=2",
		});
		await view.startFollow();
		return view;
	}

	it.each(["following", "starting"] as const)(
		"leaves a newer view's listener and follow when an old %s view is disposed again",
		async (state) => {
			const old = await loaded(["s=1"]);
			const reply = deferred<LogFollowStartOutput>();
			if (state === "starting")
				old.followStart.mockReturnValueOnce(reply.promise);
			else
				old.followStart.mockResolvedValueOnce({
					ok: true,
					subscriptionId: "sub-1",
					checkpointCursor: "s=1",
				});
			const started = old.view.startFollow();
			if (state === "following") await started;
			old.followStop.mockResolvedValue({
				success: true,
				checkpointCursor: "s=1",
			});
			old.view.dispose();
			const next = await replacement(old);
			const stops = old.followStop.mock.calls.length;
			old.view.dispose();
			expect(old.followStop).toHaveBeenCalledTimes(stops);
			old.push({
				subscriptionId: "sub-2",
				entries: [entry("s=3")],
				checkpointCursor: "s=3",
			});
			expect(keys(next)).toEqual(["s=3", "s=2", "s=1"]);
			reply.resolve({
				ok: true,
				subscriptionId: "sub-1",
				checkpointCursor: "s=1",
			});
			await started;
			expect(old.followStop).toHaveBeenCalledTimes(stops);
			expect(next.follow).toBe("following");
		},
	);

	it("stops nothing when a view is disposed after a newer view started Follow", async () => {
		const old = await loaded(["s=1"]);
		old.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: "s=1",
		});
		await old.view.startFollow();
		const next = await replacement(old);
		old.view.dispose();
		expect(old.followStop).not.toHaveBeenCalled();
		old.push({
			subscriptionId: "sub-2",
			entries: [entry("s=3")],
			checkpointCursor: "s=3",
		});
		expect(keys(next)).toEqual(["s=3", "s=2", "s=1"]);
	});

	it("pauses without stopping the device when a newer view has taken Follow over", async () => {
		const old = await loaded(["s=1"]);
		old.followStart.mockResolvedValueOnce({
			ok: true,
			subscriptionId: "sub-1",
			checkpointCursor: "s=1",
		});
		await old.view.startFollow();
		const next = await replacement(old);
		await old.view.pauseFollow();
		expect(old.followStop).not.toHaveBeenCalled();
		expect(old.view.follow).toBe("paused");
		old.push({
			subscriptionId: "sub-2",
			entries: [entry("s=3")],
			checkpointCursor: "s=3",
		});
		expect(keys(next)).toEqual(["s=3", "s=2", "s=1"]);
	});
});
