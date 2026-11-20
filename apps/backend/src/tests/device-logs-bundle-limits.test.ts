import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { LogEntry, LogQueryPage } from "@ceraui/rpc/schemas";
import {
	abortLogBundles,
	createBundle,
	handleLogBundleRequest,
} from "../modules/device-logs/bundle.ts";
import { buildBundle } from "../modules/device-logs/bundle-body.ts";
import * as data from "../modules/device-logs/bundle-data.ts";
import { toLogEntry } from "../modules/device-logs/parse.ts";
import * as pages from "../modules/device-logs/scan-page.ts";
import { bootId, queryFixture, record } from "./helpers/device-query.ts";

const NativeCompression = CompressionStream;
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
const snapshot: Awaited<ReturnType<typeof data.collectBundleData>> = {
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
const prelude = [
	{ section: "versions", exportedBy: context },
	{ section: "versions", bootId, versions: null },
	{ section: "settings", ...snapshot.settings },
];
const base = { ...toLogEntry(record(1)), message: "" };
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const entryLine = (entry: LogEntry) => line({ section: "journal", entry });
let fixture: ReturnType<typeof queryFixture>;
let collect: ReturnType<typeof spyOn<typeof data, "collectBundleData">>;
let clock: ReturnType<typeof spyOn<typeof Date, "now">>;
beforeEach(() => {
	fixture = queryFixture();
	collect = spyOn(data, "collectBundleData").mockResolvedValue(snapshot);
	clock = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
});
afterEach(async () => {
	globalThis.CompressionStream = NativeCompression;
	await abortLogBundles();
	collect.mockRestore();
	clock.mockRestore();
	fixture.restore();
});
async function gzip(text: string) {
	return new Uint8Array(
		await new Response(
			new Blob([text]).stream().pipeThrough(new NativeCompression("gzip")),
		).arrayBuffer(),
	);
}
async function bytes() {
	const created = await createBundle({});
	if (!created.ok) throw new Error(created.error);
	return new Uint8Array(
		await (
			await handleLogBundleRequest(new Request(`http://device${created.url}`))
		).arrayBuffer(),
	);
}

test("the previous boot gets its newest tail first without using the current boot's share", async () => {
	const previous = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
	const older = { ...base, bootId: previous, message: "x".repeat(16_384) };
	const latest = { ...older, message: "latest previous boot entry" };
	const current = { ...base, message: "current boot entry" };
	const olderVersion = { bootId: previous, versions: null };
	collect.mockResolvedValue({
		...snapshot,
		boots: [...snapshot.boots, olderVersion],
		journalBoots: [bootId, previous],
	});
	const headerBytes = Buffer.byteLength(
		[...prelude, { section: "versions", ...olderVersion }].map(line).join(""),
	);
	const admitted = Math.floor(
		(Math.floor((32 * 1024 * 1024 - 512 - headerBytes) / 2) -
			Buffer.byteLength(entryLine(latest))) /
			Buffer.byteLength(entryLine(older)),
	);
	const history = [
		latest,
		...Array.from({ length: admitted + 1 }, () => older),
	];
	const scan = spyOn(pages, "scanPage").mockImplementation(async (query) => {
		const from = Number(query.continuation ?? "0");
		const oldBoot = query.boot === previous;
		const entries = oldBoot ? history.slice(from, from + 200) : [current];
		const hasMore = oldBoot && from + entries.length < history.length;
		return {
			ok: true,
			entries,
			hasMore,
			continuation: hasMore ? String(from + entries.length) : null,
			termination: hasMore ? "lookahead" : "end",
			bootId: oldBoot ? previous : bootId,
			historyEpoch: 7,
		};
	});
	try {
		const { manifest, chunks } = await buildBundle(
			{
				createdAt: Date.now(),
				epoch: 7,
				signal: new AbortController().signal,
			},
			true,
		);
		const text = await new Response(
			new Blob(chunks.map((chunk) => new Uint8Array(chunk)))
				.stream()
				.pipeThrough(new DecompressionStream("gzip")),
		).text();
		expect(text.indexOf(entryLine(latest))).toBe(headerBytes);
		expect(text).toEndWith(
			entryLine(current) +
				line({ section: "journal", incomplete: "size_limit" }) +
				line({ section: "end", complete: false }),
		);
		expect(manifest.sections.find(({ id }) => id === "journal")).toEqual({
			id: "journal",
			entries: admitted + 2,
			redactions: 0,
			bootsCovered: 2,
			complete: false,
		});
	} finally {
		scan.mockRestore();
	}
}, 30_000);

function feed(rows: readonly LogEntry[]) {
	let position = 0;
	return spyOn(pages, "scanPage").mockImplementation(
		async (): Promise<LogQueryPage> => {
			const entries =
				position < rows.length ? rows.slice(position, position + 200) : [base];
			position += 200;
			return {
				ok: true,
				entries,
				hasMore: true,
				continuation: "next",
				termination: "lookahead",
				bootId,
				historyEpoch: 7,
			};
		},
	);
}
test.each([0, 1])(
	"the exact UTF-8 budget admits the boundary and refuses one byte more (%i)",
	async (overflow) => {
		const budget = 32 * 1024 * 1024 - 512;
		const header = prelude.map(line).join("");
		const entryBytes = Buffer.byteLength(entryLine(base));
		const maxEntry = entryBytes + 16_384;
		const remaining = budget - Buffer.byteLength(header) + overflow;
		const full = Math.floor((remaining - entryBytes) / maxEntry);
		const tail = remaining - full * maxEntry - entryBytes;
		const rows = [
			...Array.from({ length: full }, () => ({
				...base,
				message: "\u00e9".repeat(8192),
			})),
			{
				...base,
				message: "\u00e9".repeat(Math.floor(tail / 2)) + (tail % 2 ? "x" : ""),
			},
		];
		const scan = feed(rows);
		try {
			const compressed = await bytes();
			const text = await new Response(
				new Blob([compressed])
					.stream()
					.pipeThrough(new DecompressionStream("gzip")),
			).text();
			const footer =
				line({ section: "journal", incomplete: "size_limit" }) +
				line({ section: "end", complete: false });
			expect(text).toEndWith(footer);
			expect(Buffer.byteLength(text)).toBe(
				budget +
					overflow -
					(overflow ? entryBytes + tail : 0) +
					Buffer.byteLength(footer),
			);
			expect(
				text
					.split("\n")
					.filter((row) => row.startsWith('{"section":"journal","entry":')),
			).toHaveLength(rows.length - overflow);
		} finally {
			scan.mockRestore();
		}
	},
	30_000,
);

test.each([0, 1])(
	"the exact compressed budget admits the boundary and refuses one byte more (%i)",
	async (overflow) => {
		const budget = 8 * 1024 * 1024 - 512;
		const header = await Promise.all(
			prelude.map((record) => gzip(line(record))),
		);
		const headerBytes = header.reduce(
			(sum, chunk) => sum + chunk.byteLength,
			0,
		);
		const entryBytes = (await gzip(entryLine(base))).byteLength;
		// Real gzip FEXTRA/FNAME headers make every compressed-byte boundary
		// reachable without depending on a compressor's entropy heuristics.
		const count = Math.ceil(
			(budget - headerBytes + overflow) / (entryBytes + 65_537),
		);
		let padding = budget - headerBytes + overflow - count * entryBytes;
		const extra = Array.from({ length: count }, () => {
			const amount = Math.min(65_537, padding);
			padding -= amount;
			return amount;
		});
		let member = 0;
		globalThis.CompressionStream = class extends NativeCompression {
			constructor(format: ConstructorParameters<typeof NativeCompression>[0]) {
				super(format);
				const amount = extra[member++ - prelude.length] ?? 0;
				if (amount === 0) return;
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
								expect(chunk.byteLength).toBeGreaterThanOrEqual(10);
								expect(chunk[3]).toBe(0);
								const output = new Uint8Array(chunk.byteLength + amount);
								output.set(chunk.subarray(0, 10));
								output[3] = amount === 1 ? 8 : 4;
								if (amount > 1) {
									output[10] = (amount - 2) & 255;
									output[11] = (amount - 2) >>> 8;
								}
								output.set(chunk.subarray(10), 10 + amount);
								sink.enqueue(output);
							},
						}),
					),
				});
			}
		};
		const scan = feed(Array.from({ length: count }, () => base));
		try {
			const compressed = await bytes();
			globalThis.CompressionStream = NativeCompression;
			const footerLines = [
				{ section: "journal", incomplete: "compressed_size_limit" },
				{ section: "end", complete: false },
			];
			const footer = await Promise.all(
				footerLines.map((record) => gzip(line(record))),
			);
			const footerBytes = footer.reduce(
				(sum, chunk) => sum + chunk.byteLength,
				0,
			);
			expect(compressed.byteLength).toBe(
				budget +
					overflow -
					(overflow ? entryBytes + (extra.at(-1) ?? 0) : 0) +
					footerBytes,
			);
			const text = await new Response(
				new Blob([compressed])
					.stream()
					.pipeThrough(new DecompressionStream("gzip")),
			).text();
			expect(text).toEndWith(footerLines.map(line).join(""));
			expect(
				text
					.split("\n")
					.filter((row) => row.startsWith('{"section":"journal","entry":')),
			).toHaveLength(count - overflow);
		} finally {
			globalThis.CompressionStream = NativeCompression;
			scan.mockRestore();
		}
	},
	30_000,
);
