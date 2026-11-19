import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { logEntrySchema } from "@ceraui/rpc/schemas";
import {
	abortLogBundles,
	createBundle,
	handleLogBundleRequest,
} from "../modules/device-logs/bundle.ts";
import * as data from "../modules/device-logs/bundle-data.ts";
import { queryLogs } from "../modules/device-logs/query.ts";
import {
	abortLogQueries,
	withQuerySlot,
} from "../modules/device-logs/query-admission.ts";
import { scanJournal } from "../modules/device-logs/reader.ts";
import * as pages from "../modules/device-logs/scan-page.ts";
import {
	fakeJournal,
	journalLine,
	manualClock,
} from "./helpers/device-journal.ts";
import {
	bootId,
	journal,
	queryFixture,
	record,
} from "./helpers/device-query.ts";
import { bounded, latch } from "./helpers/history-clear.ts";

const realScan = scanJournal;
let fixture: ReturnType<typeof queryFixture>;
let collect: ReturnType<typeof spyOn<typeof data, "collectBundleData">>;
let queries: ReturnType<typeof spyOn<typeof pages, "scanPage">>;
beforeEach(() => {
	fixture = queryFixture();
	queries = spyOn(pages, "scanPage");
	collect = spyOn(data, "collectBundleData").mockResolvedValue({
		exportedBy: {
			bootId,
			ceraui: "ui",
			osImage: null,
			slot: null,
			board: null,
			boardModel: null,
			engine: null,
			senderVersion: null,
			kernel: null,
			bun: null,
		},
		boots: [{ bootId, versions: null }],
		journalBoots: [bootId],
		settings: {
			logs: { maxAgeDays: null, maxSizeMb: null, detail: "debug" },
			state: { historyEpoch: 7, lastClearedAt: null, lastMaintenance: null },
			updateChannel: "stable",
			autostart: null,
			hardwareKind: "generic",
			data: null,
		},
		events: [],
		bootRecords: [],
		secrets: [],
	});
});
afterEach(async () => {
	await abortLogBundles();
	queries.mockRestore();
	collect.mockRestore();
	fixture.restore();
});

async function downloadBundleLines() {
	const created = await createBundle({});
	if (!created.ok) throw new Error(created.error);
	const response = await handleLogBundleRequest(
		new Request(`http://device${created.url}`),
	);
	if (!response.body) throw new Error("missing bundle body");
	const text = await new Response(
		response.body.pipeThrough(new DecompressionStream("gzip")),
	).text();
	return text
		.trimEnd()
		.split("\n")
		.map((line): Record<string, unknown> => JSON.parse(line));
}

test.each([
	{ count: 199, sizes: [199], limits: [200] },
	{ count: 200, sizes: [200], limits: [200] },
	{ count: 201, sizes: [200, 1], limits: [200, 200] },
])(
	"bundle pages preserve the exact 200-entry boundary: %j",
	async ({ count, sizes, limits }) => {
		const records = Array.from({ length: count }, (_, index) =>
			record(index + 1),
		);
		const scan = journal(records);
		let calls = 0;
		fixture.scan.mockImplementation((input) => {
			if (++calls > 3) throw new Error("bundle page did not advance");
			return scan(input);
		});
		const lines = await downloadBundleLines();
		expect(
			lines
				.filter((line) => line.section === "journal")
				.map((line) => logEntrySchema.parse(line.entry).cursor),
		).toEqual(records.map((entry) => entry.cursor).reverse());
		expect(lines.at(-1)).toEqual({ section: "end", complete: true });
		const actualLimits: readonly number[] = queries.mock.calls.map(
			([query]) => query.limit,
		);
		expect(actualLimits).toEqual(limits);
		const actualSizes: readonly number[] = await Promise.all(
			queries.mock.results.map(async (result) => {
				if (result.type !== "return") throw new Error("page did not return");
				const page = await result.value;
				if (!page.ok) throw new Error(page.error);
				return page.entries.length;
			}),
		);
		expect(actualSizes).toEqual(sizes);
	},
);

test("the download covers the running boot while previous boot reap is held past the deadline", async () => {
	const previous = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
	const startedAt = 1_700_000_000_000;
	const clock = spyOn(Date, "now").mockReturnValue(startedAt);
	const snapshot = await collect();
	collect.mockImplementation(async () => {
		clock.mockReturnValue(startedAt + 59_600);
		return { ...snapshot, journalBoots: [bootId, previous] };
	});
	const current = journal([record(100), record(101), record(102)], 2);
	const child = fakeJournal(
		[
			journalLine({
				_BOOT_ID: previous,
				_SYSTEMD_UNIT: "ceralive.service",
			}),
		],
		{ held: true, ignoreTerm: true },
	);
	const terminated = Promise.withResolvers<void>();
	fixture.scan.mockImplementation((input) => {
		if (!input.matches.includes(`_BOOT_ID=${previous}`)) return current(input);
		return realScan({
			...input,
			clock: manualClock().clock,
			spawn: () => ({
				...child.child,
				get signalCode() {
					return child.child.signalCode;
				},
				kill(signal) {
					child.child.kill(signal);
					if (signal === "SIGTERM") terminated.resolve();
				},
			}),
		});
	});
	const pending = downloadBundleLines();
	const spare = latch();
	try {
		await bounded(terminated.promise);
		const lines = await bounded(pending);
		expect(
			lines
				.filter((line) => line.section === "journal" && "entry" in line)
				.map((line) => logEntrySchema.parse(line.entry).cursor),
		).toEqual(["s=102", "s=101", "s=100"]);
		expect(lines.slice(-2)).toEqual([
			{ section: "journal", incomplete: "time_limit" },
			{ section: "end", complete: false },
		]);

		clock.mockReturnValue(startedAt + 60_001);
		const occupied = withQuerySlot({}, spare.hold);
		try {
			await bounded(spare.entered);
			expect(await queryLogs({}, { boot: "all" })).toEqual({
				ok: false,
				error: "BUSY",
			});
			child.finish(143, "SIGTERM");
			expect(
				await bounded(
					withQuerySlot({}, async () => "admitted", AbortSignal.timeout(1000)),
				),
			).toBe("admitted");
		} finally {
			spare.release();
			await occupied;
		}
	} finally {
		child.finish(143, "SIGTERM");
		clock.mockRestore();
		await Promise.allSettled([pending, abortLogQueries()]);
	}
});
