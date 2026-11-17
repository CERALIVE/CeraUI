import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { logEntrySchema } from "@ceraui/rpc/schemas";
import {
	abortLogBundles,
	createBundle,
	handleLogBundleRequest,
} from "../modules/device-logs/bundle.ts";
import * as data from "../modules/device-logs/bundle-data.ts";
import {
	abortLogExports,
	createExport,
} from "../modules/device-logs/export.ts";
import { toLogEntry } from "../modules/device-logs/parse.ts";
import { queryLogs } from "../modules/device-logs/query.ts";
import * as pages from "../modules/device-logs/scan-page.ts";
import {
	bootId,
	journal,
	queryFixture,
	record,
} from "./helpers/device-query.ts";

const context = {
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
};
let fixture: ReturnType<typeof queryFixture>;
let collect: ReturnType<typeof spyOn<typeof data, "collectBundleData">>;
let clock: ReturnType<typeof spyOn<typeof Date, "now">>;
let now = 1_700_000_000_000;
let source: Awaited<ReturnType<typeof data.collectBundleData>>;
beforeEach(() => {
	fixture = queryFixture();
	now = 1_700_000_000_000;
	clock = spyOn(Date, "now").mockImplementation(() => now);
	source = {
		exportedBy: context,
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
	};
	collect = spyOn(data, "collectBundleData").mockImplementation(
		async () => source,
	);
	fixture.scan.mockImplementation(journal([]));
});
afterEach(async () => {
	await abortLogBundles();
	await abortLogExports();
	collect.mockRestore();
	clock.mockRestore();
	fixture.restore();
});
async function bundleLines() {
	const result = await createBundle({});
	if (!result.ok) throw new Error(result.error);
	const response = await handleLogBundleRequest(
		new Request(`http://device${result.url}`),
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

test("a bundle walks every journal page once without repeating or losing an entry", async () => {
	const records = Array.from({ length: 203 }, (_, index) => record(index + 1));
	const scan = journal(records);
	let calls = 0;
	fixture.scan.mockImplementation((input) => {
		// Refuse a broken endless walk so its output fails rather than hanging.
		if (++calls > 3) throw new Error("journal page did not advance");
		return scan(input);
	});
	const lines = await bundleLines();
	expect(
		lines
			.filter(
				(line) => line.section === "journal" && Object.hasOwn(line, "entry"),
			)
			.map((line) => logEntrySchema.parse(line.entry).cursor),
	).toEqual(records.map((entry) => entry.cursor).reverse());
	expect(lines.at(-1)).toEqual({ section: "end", complete: true });
});

test("a known secret in the attachment filename refuses creation and releases sharing", async () => {
	source = { ...source, secrets: [{ kind: "key", value: "ceralive-support" }] };
	expect(await createBundle({})).toEqual({ ok: false, error: "READ_FAILED" });
	expect((await createExport({}, { filter: {} })).ok).toBe(true);
});

test.each([
	{ elapsed: 59_999, complete: true },
	{ elapsed: 60_000, complete: false },
])(
	"the preparation deadline includes its exact boundary: %j",
	async ({ elapsed, complete }) => {
		collect.mockImplementation(async () => {
			now += elapsed;
			return source;
		});
		const lines = await bundleLines();
		expect(lines.at(-1)).toEqual({ section: "end", complete });
		expect(lines.filter((line) => line.section === "journal")).toEqual(
			complete ? [] : [{ section: "journal", incomplete: "time_limit" }],
		);
	},
);

test("scan admission reports BUSY in the bundle without replacing either existing query", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let started = 0;
	fixture.scan.mockImplementation(async () => {
		if (++started === 2) entered.resolve();
		await release.promise;
		return { status: "eof", exitCode: 0, skippedRecords: 0 };
	});
	const first = queryLogs({}, { boot: bootId });
	const second = queryLogs({}, { boot: bootId });
	await entered.promise;
	let checks = 0;
	fixture.epoch.mockImplementation(() => {
		if (++checks > 64) throw new Error("bundle did not stop after BUSY");
		return { historyEpoch: 7, lastClearedAt: null, lastMaintenance: null };
	});
	try {
		const lines = await bundleLines();
		expect(lines.slice(-2)).toEqual([
			{ section: "journal", incomplete: "BUSY" },
			{ section: "end", complete: false },
		]);
	} finally {
		release.resolve();
		expect((await first).ok).toBe(true);
		expect((await second).ok).toBe(true);
	}
});

test("a failed native scan ends the bundle without retrying or changing its reason", async () => {
	let attempts = 0;
	fixture.scan.mockImplementation(async () => {
		if (++attempts > 1) now += 60_000;
		throw new Error("PLANTED-SECRET");
	});
	const lines = await bundleLines();
	expect(lines.slice(-2)).toEqual([
		{ section: "journal", incomplete: "READ_FAILED" },
		{ section: "end", complete: false },
	]);
	expect(attempts).toBe(1);
});

test.each([
	{ compressed: false, reason: "size_limit" },
	{ compressed: true, reason: "compressed_size_limit" },
])(
	"a byte cut stops the walk before another page can replace its reason: %j",
	async ({ compressed, reason }) => {
		const Native = CompressionStream;
		let member = 0;
		if (compressed)
			globalThis.CompressionStream = class extends Native {
				constructor(format: ConstructorParameters<typeof Native>[0]) {
					super(format);
					if (++member !== 4) return;
					let first = true;
					Object.defineProperty(this, "readable", {
						value: this.readable.pipeThrough(
							new TransformStream<Uint8Array, Uint8Array>({
								transform(chunk, sink) {
									if (!first) {
										sink.enqueue(chunk);
										return;
									}
									first = false;
									const padding = 8 * 1024 * 1024;
									const output = new Uint8Array(chunk.byteLength + padding);
									output.set(chunk.subarray(0, 10));
									output[3] = 8;
									output.fill(120, 10, 10 + padding - 1);
									output.set(chunk.subarray(10), 10 + padding);
									sink.enqueue(output);
								},
							}),
						),
					});
				}
			};
		let calls = 0;
		const scan = spyOn(pages, "scanPage").mockImplementation(async () => {
			if (++calls === 12) now += 60_000;
			return {
				ok: true,
				entries: Array.from({ length: 200 }, (_, index) =>
					toLogEntry(record(index + 1, { MESSAGE: "x".repeat(16_384) })),
				),
				hasMore: true,
				termination: "lookahead",
				continuation: "next",
				bootId,
				historyEpoch: 7,
			};
		});
		try {
			const lines = await bundleLines();
			expect(lines.slice(-2)).toEqual([
				{ section: "journal", incomplete: reason },
				{ section: "end", complete: false },
			]);
		} finally {
			scan.mockRestore();
			globalThis.CompressionStream = Native;
		}
	},
	30_000,
);
