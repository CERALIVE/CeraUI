import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { logEntrySchema } from "@ceraui/rpc/schemas";
import {
	abortLogBundles,
	createBundle,
	handleLogBundleRequest,
} from "../modules/device-logs/bundle.ts";
import * as data from "../modules/device-logs/bundle-data.ts";
import * as pages from "../modules/device-logs/scan-page.ts";
import {
	bootId,
	journal,
	queryFixture,
	record,
} from "./helpers/device-query.ts";

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
		const created = await createBundle({});
		if (!created.ok) throw new Error(created.error);
		const response = await handleLogBundleRequest(
			new Request(`http://device${created.url}`),
		);
		if (!response.body) throw new Error("missing bundle body");
		const text = await new Response(
			response.body.pipeThrough(new DecompressionStream("gzip")),
		).text();
		const lines = text
			.trimEnd()
			.split("\n")
			.map((line): Record<string, unknown> => JSON.parse(line));
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
