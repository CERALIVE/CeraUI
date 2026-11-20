import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
	type LogExportInput,
	type LogQueryPage,
	logQueryInputSchema,
	type VersionContext,
} from "@ceraui/rpc/schemas";
import * as identity from "../modules/device-logs/boot-id.ts";
import {
	abortLogExports,
	createExport,
	handleLogExportRequest,
} from "../modules/device-logs/export.ts";
import { queryLogs } from "../modules/device-logs/query.ts";
import {
	JournalReadError,
	scanJournal,
} from "../modules/device-logs/reader.ts";
import * as pages from "../modules/device-logs/scan-page.ts";
import * as versions from "../modules/system/version-context.ts";
import { fakeJournal, journalLine } from "./helpers/device-journal.ts";
import {
	bootId,
	journal,
	queryFixture,
	record,
} from "./helpers/device-query.ts";

const nativeScan = scanJournal;
const otherBoot = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const currentVersions: VersionContext = {
	bootId,
	osImage: "current-os",
	slot: "A",
	board: "board",
	boardModel: null,
	ceraui: "ui",
	engine: "engine",
	senderVersion: "sender",
	kernel: "kernel",
	bun: "bun",
};
let fixture: ReturnType<typeof queryFixture>;
let now = 1_700_000_000_000;
let clock: ReturnType<typeof spyOn<typeof Date, "now">>;
let context: ReturnType<typeof spyOn<typeof versions, "collectVersionContext">>;
let boot: ReturnType<typeof spyOn<typeof identity, "currentBootId">>;
beforeEach(() => {
	now = 1_700_000_000_000;
	fixture = queryFixture();
	fixture.scan.mockImplementation(journal([record(1), record(2), record(3)]));
	clock = spyOn(Date, "now").mockImplementation(() => now);
	context = spyOn(versions, "collectVersionContext").mockResolvedValue(
		currentVersions,
	);
	boot = spyOn(identity, "currentBootId").mockReturnValue(bootId);
});
afterEach(async () => {
	await abortLogExports();
	boot.mockRestore();
	context.mockRestore();
	clock.mockRestore();
	fixture.restore();
});
async function ticket(input: LogExportInput = { filter: {} }) {
	const result = await createExport({}, input);
	if (!result.ok) throw new Error(result.error);
	return result;
}
async function download(input: LogExportInput = { filter: {} }) {
	const created = await ticket(input);
	return handleLogExportRequest(new Request(`http://device${created.url}`));
}
function success(entries = [record(1)]): LogQueryPage {
	return {
		ok: true,
		entries,
		hasMore: false,
		termination: "end",
		continuation: null,
		historyEpoch: 7,
		bootId,
	};
}
function nativeJournal(
	rows: readonly number[],
	budgets: readonly number[] = [],
) {
	let calls = 0;
	fixture.scan.mockImplementation((input) => {
		const ordered = [...rows];
		if (input.options.includes("-r")) ordered.reverse();
		const position = input.options.find((option) =>
			option.startsWith("--cursor="),
		);
		const start =
			position === undefined
				? 0
				: ordered.findIndex((n) => position === `--cursor=s=${n}`);
		const limit = budgets[calls++];
		const child = fakeJournal(
			ordered.slice(start < 0 ? ordered.length : start).map((n) =>
				journalLine({
					__CURSOR: `s=${n}`,
					__REALTIME_TIMESTAMP: String(n * 1000),
					_SYSTEMD_UNIT: "ceralive.service",
					PRIORITY: "3",
					MESSAGE: `native entry ${n}`,
				}),
			),
			{ held: limit !== undefined },
		);
		return nativeScan({
			...input,
			...(limit === undefined ? {} : { limits: { records: limit } }),
			spawn: () => child.child,
		});
	});
	return () => calls;
}
test("a single-use ticket streams the header, newest-first entries and complete footer", async () => {
	const created = await ticket();
	expect(created.url).toMatch(/^\/api\/logs\/export\?ticket=[0-9a-f]{64}$/);
	expect(created.expiresAt).toBe(now + 60_000);
	const response = await handleLogExportRequest(
		new Request(`http://device${created.url}`),
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("Content-Disposition")).toBe(
		'attachment; filename="ceralive-logs-aaaaaaaa-20231114T221320Z.txt"',
	);
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	expect(response.headers.get("Content-Type")).toBe(
		"text/plain; charset=utf-8",
	);
	expect(response.headers.has("Content-Length")).toBe(false);
	const text = await response.text();
	expect(text).toContain("# exported-by\n");
	expect(text).toContain('# osImage: "current-os"\n');
	expect(text).toContain(`# boot ${bootId}\n# versions: not recorded\n`);
	expect(text).toContain(
		"# may contain sensitive data: review before sharing\n",
	);
	expect(text).toContain("# newest first\n");
	expect(text).toContain("# createdAt: 2023-11-14T22:13:20.000Z\n");
	expect(text.indexOf("entry 3")).toBeLessThan(text.indexOf("entry 2"));
	expect(text).toEndWith("# complete: 3 entries\n");
	const reused = await handleLogExportRequest(
		new Request(`http://device${created.url}`),
	);
	expect(reused.status).toBe(403);
	expect(await reused.text()).toBe("");
});
test("all-boot headers preserve each stored version even when startup entries are excluded", async () => {
	const base = (await fixture.list())[0];
	if (!base) throw new Error("missing fixture boot");
	fixture.list.mockResolvedValue([
		{ ...base, versions: { ...currentVersions, osImage: "old-os-a" } },
		{
			...base,
			bootId: otherBoot,
			versions: { ...currentVersions, bootId: otherBoot, osImage: "old-os-b" },
		},
	]);
	fixture.scan.mockImplementation((input) =>
		journal([record(1)].filter(() => input.matches.includes("PRIORITY=6")))(
			input,
		),
	);
	const text = await (
		await download({ boot: "all", filter: { levels: ["error"] } })
	).text();
	expect(text).toContain(
		`# boot ${bootId}\n# bootId: "${bootId}"\n# osImage: "old-os-a"\n`,
	);
	expect(text).toContain(
		`# boot ${otherBoot}\n# bootId: "${otherBoot}"\n# osImage: "old-os-b"\n`,
	);
	expect(text).toContain('# osImage: "current-os"\n');
	expect(text).toEndWith("# complete: 0 entries\n");
});
test.each(["missing", "unknown", "expired"] as const)(
	"a %s ticket has an empty forbidden response",
	async (kind) => {
		const created = await ticket();
		if (kind === "expired") now += 60_000;
		const url =
			kind === "missing"
				? "/api/logs/export"
				: kind === "unknown"
					? "/api/logs/export?ticket=unknown"
					: created.url;
		const response = await handleLogExportRequest(
			new Request(`http://device${url}`),
		);
		expect(response.status).toBe(403);
		expect(await response.text()).toBe("");
	},
);
test("POST is refused without consuming a valid ticket", async () => {
	const created = await ticket();
	const url = `http://device${created.url}`;
	expect(
		(await handleLogExportRequest(new Request(url, { method: "POST" }))).status,
	).toBe(405);
	expect(
		await (await handleLogExportRequest(new Request(url))).text(),
	).toEndWith("# complete: 3 entries\n");
});
test("a pending ticket reserves sharing until expiration, and an old ticket cannot release its successor", async () => {
	const first = await ticket();
	expect(await createExport({}, { filter: {} })).toEqual({
		ok: false,
		error: "BUSY",
	});
	now += 60_000;
	const second = await ticket();
	expect(
		(await handleLogExportRequest(new Request(`http://device${first.url}`)))
			.status,
	).toBe(403);
	expect(await createExport({}, { filter: {} })).toEqual({
		ok: false,
		error: "BUSY",
	});
	await (
		await handleLogExportRequest(new Request(`http://device${second.url}`))
	).text();
	expect((await ticket()).expiresAt).toBe(now + 60_000);
});
test("active streams retain sharing beyond ticket expiry and release it on cancellation", async () => {
	const response = await download();
	now += 60_001;
	expect(await createExport({}, { filter: {} })).toEqual({
		ok: false,
		error: "BUSY",
	});
	await response.body?.cancel();
	expect((await ticket()).expiresAt).toBe(now + 60_000);
});
test("the export input boundary rejects filters and ranges outside the query schema", async () => {
	await expect(createExport({}, { filter: { levels: [] } })).rejects.toThrow();
	await expect(
		createExport({}, { filter: {}, since: 10, until: 1 }),
	).rejects.toThrow();
	expect((await ticket()).expiresAt).toBe(now + 60_000);
});
test("the header normalizes source and level sets and preserves literal text and time bounds", async () => {
	const text = await (
		await download({
			filter: {
				sources: ["kernel", "app", "app"],
				levels: ["warning", "error", "error"],
				text: "a\nb",
			},
			since: 0,
			until: 4,
		})
	).text();
	expect(text).toContain(
		'# filter: {"sources":["app","kernel"],"levels":["error","warning"],"text":"a\\nb","since":0,"until":4}\n',
	);
});
test("budget pages traverse a stepped clock to the physical end", async () => {
	fixture.scan.mockImplementation(
		journal(
			[1, 2, 3, ...Array.from({ length: 60 }, () => 0), 4].map((ts, i) =>
				record(i + 1, { __REALTIME_TIMESTAMP: String(ts * 1000) }),
			),
			12,
		),
	);
	const text = await (await download({ filter: {}, since: 1 })).text();
	expect(text).toContain("entry 64\n");
	expect(text).toContain("entry 3\n");
	expect(text).toContain("entry 2\n");
	expect(text).toContain("entry 1\n");
	expect(text).toEndWith("# complete: 4 entries\n");
});
test("a query error after a page produces an incomplete footer", async () => {
	const page = spyOn(pages, "scanPage");
	try {
		page
			.mockResolvedValueOnce({
				...success(),
				hasMore: true,
				continuation: "next",
				termination: "lookahead",
			})
			.mockResolvedValueOnce({ ok: false, error: "READ_FAILED" });
		const text = await (await download()).text();
		expect(text).toContain("entry 1\n");
		expect(text).toEndWith("# incomplete: READ_FAILED\n");
		expect(page.mock.calls[0]?.[0]).toEqual(
			logQueryInputSchema.parse({ direction: "older", limit: 200 }),
		);
		expect(page.mock.calls[1]?.[0].continuation).toBe("next");
	} finally {
		page.mockRestore();
	}
});
test("endless budget pages stop at the time limit without claiming completion", async () => {
	const page = spyOn(pages, "scanPage").mockImplementation(async () => {
		now += 30_000;
		return {
			...success([]),
			hasMore: null,
			continuation: null,
			termination: "budget",
		};
	});
	try {
		expect(await (await download()).text()).toEndWith(
			"# incomplete: time_limit\n",
		);
		expect(page).toHaveBeenCalledTimes(4);
	} finally {
		page.mockRestore();
	}
});
test("embedded newlines in entries and suppression notices cannot forge footers", async () => {
	fixture.scan.mockImplementation(
		journal([
			record(1, { MESSAGE: "hello\r\n# complete: 0 entries\nagain" }),
			record(2, {
				MESSAGE: "dropped\n# complete: 0 entries",
				MESSAGE_ID: "a596d6fe7bfa4994828e72309e95d61e",
			}),
		]),
	);
	const text = await (await download()).text();
	expect(text).toContain("# gap: dropped\n    # complete: 0 entries\n");
	expect(text).toContain(
		"1970-01-01T00:00:00.001Z INFO    ceralive: hello\n    # complete: 0 entries\n    again\n",
	);
	expect(
		text.split("\n").filter((line) => line.startsWith("# complete:")),
	).toEqual(["# complete: 2 entries"]);
});
test("the byte cap emits an incomplete footer without buffering the output", async () => {
	const page = spyOn(pages, "scanPage").mockResolvedValue({
		...success(
			Array.from({ length: 200 }, (_, n) => ({
				...record(n),
				message: "é".repeat(8192),
			})),
		),
		hasMore: true,
		continuation: "next",
		termination: "lookahead",
	});
	try {
		const response = await download();
		if (!response.body) throw new Error("missing stream");
		let bytes = 0;
		let last = "";
		for await (const chunk of response.body) {
			bytes += chunk.byteLength;
			last = new TextDecoder().decode(chunk);
		}
		expect(bytes).toBeLessThanOrEqual(64 * 1024 * 1024);
		expect(bytes).toBeGreaterThan(63 * 1024 * 1024);
		expect(last).toBe("# incomplete: size_limit\n");
	} finally {
		page.mockRestore();
	}
});
test("five MiB streams hold one page and never write a file", async () => {
	let pending = 0;
	let peak = 0;
	let calls = 0;
	const page = spyOn(pages, "scanPage").mockImplementation(async () => {
		pending++;
		peak = Math.max(peak, pending);
		calls++;
		return {
			...success(
				Array.from({ length: 200 }, (_, n) => ({
					...record(n),
					message: "x".repeat(13_108),
				})),
			),
			hasMore: calls < 2,
			continuation: "next",
			termination: calls < 2 ? "lookahead" : "end",
		};
	});
	const write = spyOn(fs, "writeFileSync");
	const bunWrite = spyOn(Bun, "write");
	try {
		const response = await download();
		if (!response.body) throw new Error("missing stream");
		const reader = response.body.getReader();
		let bytes = 0;
		let entries = 0;
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			bytes += result.value.byteLength;
			if (new TextDecoder().decode(result.value).startsWith("1970-")) {
				entries++;
				if (entries % 200 === 0) pending--;
			}
		}
		expect(bytes).toBeGreaterThan(5 * 1024 * 1024);
		expect(peak).toBe(1);
		expect(calls).toBe(2);
		expect(write).not.toHaveBeenCalled();
		expect(bunWrite).not.toHaveBeenCalled();
	} finally {
		page.mockRestore();
		write.mockRestore();
		bunWrite.mockRestore();
	}
});
test("client abort stops and joins an active scan", async () => {
	const entered = Promise.withResolvers<AbortSignal>();
	const stopped = Promise.withResolvers<void>();
	fixture.scan.mockImplementation(async (input) => {
		if (!input.signal) throw new Error("missing abort signal");
		entered.resolve(input.signal);
		await new Promise<void>((resolve) =>
			input.signal?.addEventListener("abort", () => resolve(), { once: true }),
		);
		stopped.resolve();
		return { status: "stopped", exitCode: 0, skippedRecords: 0 };
	});
	const controller = new AbortController();
	const created = await ticket();
	const response = await handleLogExportRequest(
		new Request(`http://device${created.url}`, { signal: controller.signal }),
	);
	const body = response.text();
	const signal = await entered.promise;
	controller.abort();
	await stopped.promise;
	expect(signal.aborted).toBe(true);
	expect(await body).toEndWith("# incomplete: client_aborted\n");
});
test("clear aborts active exports and invalidates pending tickets", async () => {
	const created = await ticket();
	await abortLogExports();
	expect(
		(await handleLogExportRequest(new Request(`http://device${created.url}`)))
			.status,
	).toBe(403);
	const page = spyOn(pages, "scanPage").mockImplementation(async () => {
		fixture.epoch.mockReturnValue({
			historyEpoch: 8,
			lastClearedAt: null,
			lastMaintenance: null,
		});
		return success();
	});
	try {
		expect(await (await download()).text()).toEndWith(
			"# incomplete: cleared\n",
		);
	} finally {
		page.mockRestore();
	}
});
test("exports use device scan admission independently of their socket", async () => {
	const entered = Promise.withResolvers<void>();
	const exportEntered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let scans = 0;
	fixture.scan.mockImplementation(async () => {
		if (++scans === 1) entered.resolve();
		else exportEntered.resolve();
		await release.promise;
		return { status: "eof", exitCode: 0, skippedRecords: 0 };
	});
	const conn = {};
	const query = queryLogs(conn, {});
	await entered.promise;
	const response = await download();
	const body = response.text();
	await exportEntered.promise;
	expect(await queryLogs({}, {})).toEqual({ ok: false, error: "BUSY" });
	release.resolve();
	expect((await query).ok).toBe(true);
	expect(await body).toEndWith("# complete: 0 entries\n");
});
test("an explicit boot exports only its own version block", async () => {
	const base = (await fixture.list())[0];
	if (!base) throw new Error("missing fixture boot");
	fixture.list.mockResolvedValue([base, { ...base, bootId: otherBoot }]);
	const text = await (await download({ boot: otherBoot, filter: {} })).text();
	expect(text).toContain(`# boot ${otherBoot}\n`);
	expect(text).not.toContain(`# boot ${bootId}\n`);
});
test("unknown and stored-only explicit boots cannot be exported as empty successes", async () => {
	for (const logsAvailable of [false, true]) {
		const base = (await fixture.list())[0];
		if (!base) throw new Error("missing fixture boot");
		fixture.list.mockResolvedValue([{ ...base, logsAvailable }]);
		const text = await (
			await download({ boot: logsAvailable ? otherBoot : bootId, filter: {} })
		).text();
		expect(text).toBe("# incomplete: BOOT_UNAVAILABLE\n");
	}
});
test("missing current boot identity cannot broaden an export to all boots", async () => {
	boot.mockReturnValue(undefined);
	expect(await createExport({}, { filter: {} })).toEqual({
		ok: false,
		error: "BOOT_UNAVAILABLE",
	});
});
test("all-boot filenames, version escaping, and every severity stay unambiguous", async () => {
	context.mockResolvedValue({
		...currentVersions,
		boardModel: "board\n# complete: fake",
	});
	fixture.scan.mockImplementation(
		journal(
			["3", "4", "6", "7"].map((priority, n) =>
				record(n, { PRIORITY: priority }),
			),
		),
	);
	const response = await download({ boot: "all", filter: {} });
	expect(response.headers.get("Content-Disposition")).toBe(
		'attachment; filename="ceralive-logs-all-20231114T221320Z.txt"',
	);
	const text = await response.text();
	expect(text).toContain('# boardModel: "board\\n# complete: fake"\n');
	for (const level of ["ERROR  ", "WARNING", "INFO   ", "DEBUG  "])
		expect(text).toContain(`${level} ceralive:`);
});
test("a reader failure becomes an incomplete footer and an unexpected failure releases sharing", async () => {
	fixture.scan.mockRejectedValueOnce(new JournalReadError("RECORD_TOO_LARGE"));
	expect(await (await download()).text()).toEndWith(
		"# incomplete: RECORD_TOO_LARGE\n",
	);
	fixture.scan.mockRejectedValueOnce(new TypeError("broken pipeline"));
	await expect((await download()).text()).rejects.toThrow("broken pipeline");
	expect((await ticket()).expiresAt).toBe(now + 60_000);
});
test("clearing a paused stream joins it without requiring another client read", async () => {
	const response = await download();
	const reader = response.body?.getReader();
	if (!reader) throw new Error("missing stream");
	await reader.read();
	await abortLogExports();
	const next = await reader.read();
	expect(new TextDecoder().decode(next.value)).toBe("# incomplete: cleared\n");
	expect(await reader.read()).toEqual({ done: true, value: undefined });
	expect((await ticket()).expiresAt).toBe(now + 60_000);
});
test("a request aborted before its first read cannot start a scan", async () => {
	const created = await ticket();
	const response = await handleLogExportRequest(
		new Request(`http://device${created.url}`, { signal: AbortSignal.abort() }),
	);
	expect(await response.text()).toBe("# incomplete: client_aborted\n");
	expect(fixture.scan).not.toHaveBeenCalled();
	expect(fixture.list).not.toHaveBeenCalled();
	expect(context).not.toHaveBeenCalled();
});
test("a changed epoch while a ticket waits produces an incomplete clear footer", async () => {
	const created = await ticket();
	fixture.epoch.mockReturnValue({
		historyEpoch: 8,
		lastClearedAt: null,
		lastMaintenance: null,
	});
	expect(
		await (
			await handleLogExportRequest(new Request(`http://device${created.url}`))
		).text(),
	).toBe("# incomplete: cleared\n");
});
test("a client cancelling an active scan joins it before sharing is available", async () => {
	const enqueued = spyOn(ReadableStreamDefaultController.prototype, "enqueue");
	const entered = Promise.withResolvers<void>();
	const reaped = Promise.withResolvers<void>();
	fixture.scan.mockImplementation(async (input) => {
		entered.resolve();
		await new Promise<void>((resolve) =>
			input.signal?.addEventListener("abort", () => resolve(), { once: true }),
		);
		await reaped.promise;
		return { status: "stopped", exitCode: 0, skippedRecords: 0 };
	});
	try {
		const response = await download();
		const reader = response.body?.getReader();
		if (!reader) throw new Error("missing stream");
		await reader.read();
		const reading = reader.read();
		await entered.promise;
		const cancelled = reader.cancel();
		expect(await createExport({}, { filter: {} })).toEqual({
			ok: false,
			error: "BUSY",
		});
		reaped.resolve();
		await cancelled;
		await reading;
		expect(enqueued).toHaveBeenCalledTimes(1);
		expect((await ticket()).expiresAt).toBe(now + 60_000);
	} finally {
		enqueued.mockRestore();
	}
});
test("the real deadline aborts a scan and clears its timer without a client pull", async () => {
	const timer = spyOn(globalThis, "setTimeout");
	const cleared = spyOn(globalThis, "clearTimeout");
	const closed = spyOn(ReadableStreamDefaultController.prototype, "close");
	try {
		const response = await download();
		const fire = timer.mock.calls.find(([, ms]) => ms === 120_000)?.[0];
		if (typeof fire !== "function") throw new Error("deadline was not armed");
		fire();
		expect(await response.text()).toBe("# incomplete: time_limit\n");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(fixture.scan).not.toHaveBeenCalled();
		const result =
			timer.mock.results[
				timer.mock.calls.findIndex(([, ms]) => ms === 120_000)
			];
		if (result?.type !== "return")
			throw new Error("deadline did not return a timer");
		expect(cleared).toHaveBeenCalledWith(result.value);
		expect(closed).toHaveBeenCalledTimes(1);
	} finally {
		timer.mockRestore();
		cleared.mockRestore();
		closed.mockRestore();
	}
});
test("a multiline journal unit cannot forge an export line", async () => {
	fixture.scan.mockImplementation(
		journal([
			record(1, {
				_SYSTEMD_UNIT: "unit\r\n# complete: 0 entries.service",
			}),
		]),
	);
	const text = await (await download()).text();
	expect(text).toContain("INFO    unit  # complete: 0 entries: entry 1\n");
	expect(
		text.split("\n").filter((line) => line.startsWith("# complete:")),
	).toEqual(["# complete: 1 entries"]);
});
test.each([0, 1])(
	"the byte boundary accounts for the header and UTF-8 entries exactly (overflow %i)",
	async (overflow) => {
		const cap = 64 * 1024 * 1024 - 64;
		const prefix = "1970-01-01T00:00:00.001Z INFO    ceralive: ";
		let remaining = 0;
		let finalBytes = 0;
		let generated = 0;
		const page = spyOn(pages, "scanPage").mockImplementation(async () => {
			const rows = [];
			for (let n = 0; n < 200; n++) {
				const length = Math.min(
					16_384,
					Math.max(0, remaining - prefix.length - 1),
				);
				const row = { ...record(1), message: "x".repeat(length) };
				const bytes = prefix.length + length + 1;
				if (remaining > 0) {
					remaining -= bytes;
					generated++;
					if (remaining === 0) finalBytes = bytes;
				}
				rows.push(row);
				if (remaining === 0) break;
			}
			return {
				...success(rows),
				hasMore: true,
				termination: "lookahead",
				continuation: "next",
			};
		});
		try {
			const response = await download();
			const reader = response.body?.getReader();
			if (!reader) throw new Error("missing stream");
			const first = await reader.read();
			if (!first.value) throw new Error("missing header");
			remaining = cap - first.value.byteLength + overflow;
			let bytes = first.value.byteLength;
			let count = 0;
			let last = "";
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				bytes += chunk.value.byteLength;
				last = new TextDecoder().decode(chunk.value);
				if (last.startsWith("1970-")) count++;
			}
			expect(last).toBe("# incomplete: size_limit\n");
			expect(count).toBe(generated - overflow);
			expect(bytes).toBe(
				cap + overflow - (overflow ? finalBytes : 0) + last.length,
			);
		} finally {
			page.mockRestore();
		}
	},
);
test("an oversized version header stops before writing it or scanning entries", async () => {
	context.mockResolvedValue({
		...currentVersions,
		boardModel: "x".repeat(64 * 1024 * 1024),
	});
	expect(await (await download()).text()).toBe("# incomplete: size_limit\n");
	expect(fixture.scan).not.toHaveBeenCalled();
});
test("an epoch change during version collection cannot leak a stale header", async () => {
	context.mockImplementation(async () => {
		fixture.epoch.mockReturnValue({
			historyEpoch: 8,
			lastClearedAt: null,
			lastMaintenance: null,
		});
		return currentVersions;
	});
	expect(await (await download()).text()).toBe("# incomplete: cleared\n");
});
test("an abort between yielded entries prevents the rest of the page from escaping", async () => {
	const controller = new AbortController();
	const created = await ticket();
	const response = await handleLogExportRequest(
		new Request(`http://device${created.url}`, { signal: controller.signal }),
	);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("missing stream");
	await reader.read();
	const first = await reader.read();
	expect(new TextDecoder().decode(first.value)).toContain("entry 3\n");
	controller.abort();
	const footer = await reader.read();
	expect(new TextDecoder().decode(footer.value)).toBe(
		"# incomplete: client_aborted\n",
	);
	expect(await reader.read()).toEqual({ done: true, value: undefined });
});
test("all-boot export of an empty journal completes without manufacturing a boot", async () => {
	fixture.list.mockResolvedValue([]);
	fixture.scan.mockImplementation(journal([]));
	const text = await (await download({ boot: "all", filter: {} })).text();
	expect(text).not.toContain("# boot ");
	expect(text).toContain("# exported-by\n");
	expect(text).toEndWith("# complete: 0 entries\n");
});
test("a completed download detaches its abort listener and is no longer cleared", async () => {
	const added = spyOn(AbortSignal.prototype, "addEventListener");
	const removed = spyOn(AbortSignal.prototype, "removeEventListener");
	try {
		await (await download()).text();
		const listener = added.mock.calls.find(([name]) => name === "abort")?.[1];
		expect(listener).toBeDefined();
		expect(removed).toHaveBeenCalledWith("abort", listener);
		const signal = fixture.scan.mock.calls[0]?.[0].signal;
		if (!signal) throw new Error("scan did not receive a signal");
		await abortLogExports();
		expect(signal.aborted).toBe(false);
	} finally {
		added.mockRestore();
		removed.mockRestore();
	}
});
test("abort after the header stops before opening a scan", async () => {
	const controller = new AbortController();
	const created = await ticket();
	const response = await handleLogExportRequest(
		new Request(`http://device${created.url}`, { signal: controller.signal }),
	);
	const reader = response.body?.getReader();
	if (!reader) throw new Error("missing stream");
	await reader.read();
	controller.abort();
	const footer = await reader.read();
	expect(new TextDecoder().decode(footer.value)).toBe(
		"# incomplete: client_aborted\n",
	);
	expect(fixture.scan).not.toHaveBeenCalled();
	await reader.read();
});
test("clear takes precedence over a concurrently returned pipeline error", async () => {
	const page = spyOn(pages, "scanPage").mockImplementation(async () => {
		fixture.epoch.mockReturnValue({
			historyEpoch: 8,
			lastClearedAt: null,
			lastMaintenance: null,
		});
		return { ok: false, error: "READ_FAILED" };
	});
	try {
		expect(await (await download()).text()).toEndWith(
			"# incomplete: cleared\n",
		);
	} finally {
		page.mockRestore();
	}
});
test.each(["cleared", "time_limit"])(
	"a non-string client abort reason cannot impersonate %s",
	async (reason) => {
		const created = await ticket();
		const signal = AbortSignal.abort({ toString: () => reason });
		const response = await handleLogExportRequest(
			new Request(`http://device${created.url}`, { signal }),
		);
		expect(await response.text()).toBe("# incomplete: client_aborted\n");
	},
);
test("expired tickets do not accumulate in the in-memory store", async () => {
	const original = Map.prototype.set;
	const observed: Map<unknown, unknown>[] = [];
	const set = spyOn(Map.prototype, "set").mockImplementation(function (
		this: Map<unknown, unknown>,
		key: unknown,
		value: unknown,
	) {
		if (
			typeof value === "object" &&
			value !== null &&
			"query" in value &&
			"expiresAt" in value
		)
			observed.push(this);
		return original.call(this, key, value);
	});
	try {
		const first = await ticket();
		const firstKey = new URL(first.url, "http://device").searchParams.get(
			"ticket",
		);
		now = first.expiresAt;
		await ticket();
		const store = observed[0];
		if (!store) throw new Error("ticket allocation was not observed");
		expect(store.size).toBe(1);
		expect(store.has(firstKey)).toBe(false);
	} finally {
		set.mockRestore();
	}
});
test("a pre-aborted download releases sharing even when the client never reads", async () => {
	const created = await ticket();
	const response = await handleLogExportRequest(
		new Request(`http://device${created.url}`, { signal: AbortSignal.abort() }),
	);
	await abortLogExports();
	expect((await ticket()).expiresAt).toBe(now + 60_000);
	expect(await response.text()).toBe("# incomplete: client_aborted\n");
});
test.each(["client_aborted", "cleared", "time_limit"] as const)(
	"a paused native EOF page stopped after its final entry reports %s before the footer",
	async (reason) => {
		nativeJournal([1]);
		const controller = new AbortController();
		const created = await ticket();
		const response = await handleLogExportRequest(
			new Request(`http://device${created.url}`, { signal: controller.signal }),
		);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("missing stream");
		expect(new TextDecoder().decode((await reader.read()).value)).toContain(
			"# exported-by\n",
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(
			"1970-01-01T00:00:00.001Z ERROR   ceralive: native entry 1\n",
		);
		if (reason === "client_aborted") controller.abort();
		else if (reason === "cleared")
			fixture.epoch.mockReturnValue({
				historyEpoch: 8,
				lastClearedAt: null,
				lastMaintenance: null,
			});
		else now += 120_000;
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(
			`# incomplete: ${reason}\n`,
		);
		expect(await reader.read()).toEqual({ done: true, value: undefined });
	},
);
test.each([
	{ name: "zero candidates at the head", budgets: [0], calls: 2 },
	{
		name: "zero candidates with an incoming continuation",
		budgets: [2, 0],
		calls: 3,
	},
])(
	"native paging retries $name without losing entries",
	async ({ budgets, calls }) => {
		const scans = nativeJournal([1, 2, 3], budgets);
		const text = await (await download()).text();
		expect(text.split("\n").filter((line) => line.startsWith("1970-"))).toEqual(
			[
				"1970-01-01T00:00:00.003Z ERROR   ceralive: native entry 3",
				"1970-01-01T00:00:00.002Z ERROR   ceralive: native entry 2",
				"1970-01-01T00:00:00.001Z ERROR   ceralive: native entry 1",
			],
		);
		expect(text).toEndWith("# complete: 3 entries\n");
		expect(scans()).toBe(calls);
	},
);
test("an abort during version collection emits no header and releases sharing", async () => {
	const collecting = Promise.withResolvers<void>();
	const collected = Promise.withResolvers<VersionContext>();
	context.mockImplementation(() => {
		collecting.resolve();
		return collected.promise;
	});
	nativeJournal([1]);
	const controller = new AbortController();
	const created = await ticket();
	const response = await handleLogExportRequest(
		new Request(`http://device${created.url}`, { signal: controller.signal }),
	);
	const body = response.text();
	await collecting.promise;
	controller.abort();
	collected.resolve(currentVersions);
	expect(await body).toBe("# incomplete: client_aborted\n");
	expect(fixture.scan).not.toHaveBeenCalled();
	expect((await ticket()).expiresAt).toBe(now + 60_000);
});
test("an empty ticket cannot release or consume another pending export", async () => {
	const created = await ticket();
	const missing = await handleLogExportRequest(
		new Request("http://device/api/logs/export?ticket="),
	);
	expect(missing.status).toBe(403);
	expect(await missing.text()).toBe("");
	expect(await createExport({}, { filter: {} })).toEqual({
		ok: false,
		error: "BUSY",
	});
	const valid = await handleLogExportRequest(
		new Request(`http://device${created.url}`),
	);
	expect(await valid.text()).toEndWith("# complete: 3 entries\n");
});
