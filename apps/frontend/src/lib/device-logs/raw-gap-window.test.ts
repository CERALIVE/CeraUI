import type {
	LogEntry,
	LogFollowMessage,
	LogQueryInput,
	LogQueryOutput,
} from "@ceraui/rpc/schemas";
import { afterEach, expect, it, vi } from "vitest";
import { RawView } from "./raw-view.svelte";

const BOOT = "66d8d1808694489b8c3a3fb4795cab24";

function entries(prefix: string, start: number, count: number): LogEntry[] {
	return Array.from({ length: count }, (_, offset) => ({
		cursor: `${prefix}${start + offset}`,
		bootId: BOOT,
		ts: 0,
		level: "info",
		source: "app",
		unit: "ceralive.service",
		message: "fixture",
		truncated: false,
		marker: null,
	}));
}

function page(
	entries: LogEntry[],
	continuation: string | null = null,
): LogQueryOutput {
	return {
		ok: true,
		entries,
		continuation,
		hasMore: continuation !== null,
		termination: continuation === null ? "end" : "lookahead",
		historyEpoch: 0,
		bootId: BOOT,
	};
}

let mounted: RawView | undefined;
afterEach(() => mounted?.dispose());

async function following() {
	const query = vi
		.fn<(input: LogQueryInput) => Promise<LogQueryOutput>>()
		.mockResolvedValueOnce(page(entries("old", 1, 1)));
	let listener: ((message: LogFollowMessage) => void) | undefined;
	const view = new RawView({
		logs: {
			query,
			followStart: async () => ({
				ok: true,
				subscriptionId: "live",
				checkpointCursor: "old1",
			}),
			followStop: async () => ({ success: true, checkpointCursor: null }),
		},
		setFollowListener(next) {
			listener = next;
		},
		now: () => 0,
	});
	mounted = view;
	await view.start();
	await view.startFollow();
	const push = (incoming: LogEntry[], gapFrom?: string) => {
		listener?.({
			subscriptionId: "live",
			entries: incoming,
			checkpointCursor: incoming.at(-1)?.cursor ?? null,
			dropped: 0,
			...(gapFrom === undefined ? {} : { gap: "catchup_exceeded", gapFrom }),
		});
	};
	const gap = () =>
		view.rows.flatMap((row) =>
			row.kind === "marker" && row.gapFrom !== undefined
				? [{ key: row.key, from: row.gapFrom }]
				: [],
		)[0];
	return {
		view,
		query,
		push,
		gap,
		shown: () =>
			view.rows.flatMap((row) => (row.kind === "entry" ? [row.key] : [])),
	};
}

it.each([1999, 2000])(
	"keeps the full skipped page and an adjacent focus target under %i newer entries",
	async (newer) => {
		const h = await following();
		h.push([], "gap1");
		h.push(entries("new", 1, newer));
		const gap = h.gap();
		expect(gap?.from).toBe("gap1");
		if (!gap) throw new Error("missing skipped entries action");
		h.query.mockResolvedValueOnce(page(entries("skipped", 1, 3)));

		expect(await h.view.loadGap(gap.key, gap.from)).toBe("skipped3");
		expect(h.shown()).toHaveLength(2000);
		expect(h.shown().filter((key) => key.startsWith("skipped"))).toEqual([
			"skipped3",
			"skipped2",
			"skipped1",
		]);
		expect(h.gap()).toBeUndefined();
	},
);

it("continues paging a skipped range after more than one display window has been recovered", async () => {
	const h = await following();
	h.push([], "page0");
	h.push(entries("new", 1, 1999));
	const loaded: string[] = [];
	for (let n = 0; n < 22; n++) {
		const gap = h.gap();
		expect(gap?.from).toBe(`page${n}`);
		if (!gap) throw new Error("missing skipped entries action");
		const rows = entries("skipped", n * 100 + 1, 100);
		h.query.mockResolvedValueOnce(page(rows, n === 21 ? null : `page${n + 1}`));
		await h.view.loadGap(gap.key, gap.from);
		loaded.unshift(...rows.map(({ cursor }) => cursor).reverse());
		expect(h.shown().filter((key) => key.startsWith("skipped"))).toEqual(
			loaded.slice(0, 2000),
		);
		expect(h.shown()).toHaveLength(2000);
	}
	expect(h.view.capped).toBe(true);
	expect(h.gap()).toBeUndefined();
});

it("continues a held gap read when live entries fill and pass the display cap", async () => {
	const h = await following();
	h.push([], "gap1");
	h.push(entries("new", 1, 1999));
	const gap = h.gap();
	if (!gap) throw new Error("missing skipped entries action");
	const reply = Promise.withResolvers<LogQueryOutput>();
	h.query.mockReturnValueOnce(reply.promise);
	const reading = h.view.loadGap(gap.key, gap.from);
	h.push(entries("new", 2000, 8));
	reply.resolve(page(entries("skipped", 1, 3), "gap2"));

	await reading;
	expect(h.gap()).toEqual({ key: gap.key, from: "gap2" });
	expect(h.shown().filter((key) => key.startsWith("skipped"))).toEqual([
		"skipped3",
		"skipped2",
		"skipped1",
	]);
});

it("reports the recovery limit without dropping an existing gap position", async () => {
	const h = await following();
	for (let i = 0; i < 33; i++) h.push([], `gap${i}`);
	h.push(entries("new", 1, 2000));

	expect(
		h.view.rows.flatMap((row) =>
			row.kind === "marker" && row.gapFrom !== undefined ? [row.gapFrom] : [],
		),
	).toEqual(Array.from({ length: 32 }, (_, i) => `gap${31 - i}`));
	expect(h.view.gapLimitReached).toBe(true);
});
