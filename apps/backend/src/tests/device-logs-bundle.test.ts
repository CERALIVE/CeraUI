import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
	type LogEntry,
	type LogQueryPage,
	logBundleManifestSchema,
	type VersionContext,
} from "@ceraui/rpc/schemas";
import {
	abortLogBundles,
	createBundle,
	handleLogBundleRequest,
	previewBundle,
} from "../modules/device-logs/bundle.ts";
import * as builder from "../modules/device-logs/bundle-body.ts";
import * as data from "../modules/device-logs/bundle-data.ts";
import {
	abortLogExports,
	createExport,
} from "../modules/device-logs/export.ts";
import { queryLogs } from "../modules/device-logs/query.ts";
import * as pages from "../modules/device-logs/scan-page.ts";
import {
	bootId,
	journal,
	queryFixture,
	record,
} from "./helpers/device-query.ts";

const previousBoot = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const context: VersionContext = {
	bootId,
	osImage: "current-os",
	slot: "A",
	board: "rk3588",
	boardModel: null,
	ceraui: "2026.11.3",
	engine: "engine-revision",
	senderVersion: "sender-revision",
	kernel: "6.1",
	bun: "1.4.4",
};
function snapshot() {
	return {
		exportedBy: context,
		boots: [
			{ bootId, versions: { ...context, osImage: "old-os-a" } },
			{
				bootId: previousBoot,
				versions: { ...context, bootId: previousBoot, osImage: "old-os-b" },
			},
		],
		journalBoots: [bootId, previousBoot],
		settings: {
			logs: { maxAgeDays: null, maxSizeMb: null, detail: "debug" as const },
			state: { historyEpoch: 7, lastClearedAt: null, lastMaintenance: null },
			updateChannel: "stable" as const,
			autostart: true,
			hardwareKind: "rk3588" as const,
			data: { used: 4, total: 10 },
		},
		events: [
			{
				id: "event-one",
				seq: 1,
				bootId,
				at: 1,
				code: "link_down",
				family: "network" as const,
				severity: "warning" as const,
				params: { iface: "eth0" },
			},
		],
		bootRecords: [{ bootId, startedAt: 0, versions: context }],
		secrets: [
			{ kind: "stream", value: "stream-secret" },
			{ kind: "ssh", value: "ssh-password" },
		],
	};
}
let fixture: ReturnType<typeof queryFixture>;
let source: ReturnType<typeof snapshot>;
let collect: ReturnType<typeof spyOn<typeof data, "collectBundleData">>;
let clock: ReturnType<typeof spyOn<typeof Date, "now">>;
let now = 1_700_000_000_000;
beforeEach(() => {
	fixture = queryFixture();
	source = snapshot();
	collect = spyOn(data, "collectBundleData").mockImplementation(
		async () => source,
	);
	now = 1_700_000_000_000;
	clock = spyOn(Date, "now").mockImplementation(() => now);
	fixture.scan.mockImplementation(journal([]));
});
afterEach(async () => {
	await abortLogBundles();
	await abortLogExports();
	collect.mockRestore();
	clock.mockRestore();
	fixture.restore();
});
function page(
	entries: LogEntry[] = [],
	hasMore: boolean | null = false,
): LogQueryPage {
	return {
		ok: true,
		entries,
		hasMore,
		termination: hasMore === false ? "end" : "budget",
		continuation: hasMore === false ? null : "next",
		bootId,
		historyEpoch: 7,
	};
}
async function ticket(signal?: AbortSignal) {
	const result = await createBundle({}, signal);
	if (!result.ok) throw new Error(result.error);
	return result;
}
async function unpack(response: Response) {
	expect(response.status).toBe(200);
	if (!response.body) throw new Error("missing bundle body");
	const text = await new Response(
		response.body.pipeThrough(new DecompressionStream("gzip")),
	).text();
	return {
		text,
		lines: text
			.trimEnd()
			.split("\n")
			.map((line): Record<string, unknown> => JSON.parse(line)),
	};
}
async function download() {
	const created = await ticket();
	return handleLogBundleRequest(new Request(`http://device${created.url}`));
}

test("bundle masks covered boot IDs in journal messages but preserves boot metadata", async () => {
	const dashedPrevious = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";
	const unrelated = "cccccccccccccccccccccccccccccccc";
	const cursor = `s=${"d".repeat(32)};i=1;b=${bootId};m=2;t=3;x=4`;
	const scan = spyOn(pages, "scanPage").mockImplementation(
		async (_query, scope) =>
			page(
				scope.bootId === bootId
					? [
							{
								...record(1),
								cursor,
								message: `current=${bootId} previous=${dashedPrevious} unrelated=${unrelated}`,
							},
						]
					: [],
			),
	);
	try {
		const { lines } = await unpack(await download());
		expect(lines.find((line) => line.section === "journal")).toMatchObject({
			entry: {
				bootId,
				cursor,
				message: `current=[BOOT_ID] previous=[BOOT_ID] unrelated=${unrelated}`,
			},
		});
	} finally {
		scan.mockRestore();
	}
});

test("preview and download use the same redacted pipeline, stored boot versions and counts", async () => {
	const scan = spyOn(pages, "scanPage").mockImplementation(
		async (_query, scope) =>
			page(
				scope.bootId === bootId
					? [
							{
								...record(1),
								message:
									"stream-secret ssh-password 490154203237518 8934071100276980483 aa:bb:cc:dd:ee:ff 8.8.8.8 192.168.1.10",
							},
						]
					: [],
			),
	);
	const write = spyOn(fs, "writeFileSync");
	const bunWrite = spyOn(Bun, "write");
	try {
		const manifest = await previewBundle();
		expect(logBundleManifestSchema.safeParse(manifest).success).toBe(true);
		expect(manifest.sections).toEqual([
			{ id: "versions", entries: 3, redactions: 0 },
			{ id: "settings", entries: 1, redactions: 0 },
			{ id: "events", entries: 2, redactions: 0 },
			{
				id: "journal",
				entries: 1,
				redactions: 6,
				bootsCovered: 1,
				complete: true,
			},
		]);
		expect(manifest.exportedBy.osImage).toBe("current-os");
		expect(manifest.boots.map((boot) => boot.versions?.osImage)).toEqual([
			"old-os-a",
			"old-os-b",
		]);
		const response = await download();
		expect(response.headers.get("Content-Disposition")).toBe(
			'attachment; filename="ceralive-support-aaaaaaaa-20231114T221320Z.ndjson.gz"',
		);
		expect(response.headers.get("Content-Type")).toBe("application/gzip");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.has("Content-Length")).toBe(false);
		const { text, lines } = await unpack(response);
		expect(lines.map((line) => line.section)).toEqual([
			"versions",
			"versions",
			"versions",
			"settings",
			"events",
			"events",
			"journal",
			"end",
		]);
		expect(lines.at(-1)).toEqual({ section: "end", complete: true });
		expect(text).toContain("192.168.1.10");
		for (const secret of [
			"stream-secret",
			"ssh-password",
			"490154203237518",
			"8934071100276980483",
			"aa:bb:cc:dd:ee:ff",
			"8.8.8.8",
		])
			expect(text).not.toContain(secret);
		expect(lines[1]).toMatchObject({
			bootId,
			versions: { osImage: "old-os-a" },
		});
		expect(lines[2]).toMatchObject({
			bootId: previousBoot,
			versions: { osImage: "old-os-b" },
		});
		expect(write).not.toHaveBeenCalled();
		expect(bunWrite).not.toHaveBeenCalled();
	} finally {
		scan.mockRestore();
		write.mockRestore();
		bunWrite.mockRestore();
	}
});

test.each(["preview", "create"] as const)(
	"%s fails closed for the exact frozen-schema boot collision before emitting anything",
	async (operation) => {
		source.secrets = [{ kind: "remote_key", value: bootId }];
		const enqueue = spyOn(ReadableStreamDefaultController.prototype, "enqueue");
		try {
			if (operation === "preview")
				await expect(previewBundle()).rejects.toMatchObject({
					message: "READ_FAILED",
					code: "READ_FAILED",
				});
			else
				expect(await createBundle({})).toEqual({
					ok: false,
					error: "READ_FAILED",
				});
			expect(enqueue).not.toHaveBeenCalled();
			source.secrets = [];
			expect((await createExport({}, { filter: {} })).ok).toBe(true);
		} finally {
			enqueue.mockRestore();
		}
	},
);

test.each([
	["boot substring", "aaaa"],
	["version", "2026.11.3"],
	["timestamp", "1700000000000"],
	["unit", "ceralive"],
	["cursor", "s=1700"],
	["event id", "event-one"],
	["event parameter", "eth0"],
	["numeric parameter", "12345"],
	["boolean", "true"],
	["settings field name", "data"],
	["event field name", "params"],
	["journal wrapper field", "entry"],
])(
	"fails closed when a known secret collides with a structured %s",
	async (_name, value) => {
		source.secrets = [{ kind: "key", value }];
		source.events[0]?.params &&
			Object.assign(source.events[0].params, { count: 12345 });
		const scan = spyOn(pages, "scanPage").mockResolvedValue(
			page([record(1700)]),
		);
		const enqueue = spyOn(ReadableStreamDefaultController.prototype, "enqueue");
		try {
			expect(await createBundle({})).toEqual({
				ok: false,
				error: "READ_FAILED",
			});
			expect(enqueue).not.toHaveBeenCalled();
		} finally {
			scan.mockRestore();
			enqueue.mockRestore();
		}
	},
);

test("a superstring secret is redacted in a message without rejecting its shorter identifier", async () => {
	const secret = `prefix-${bootId}-suffix`;
	source.secrets = [{ kind: "key", value: secret }];
	const scan = spyOn(pages, "scanPage")
		.mockResolvedValueOnce(page([{ ...record(1), message: secret }]))
		.mockResolvedValue(page());
	try {
		const { text } = await unpack(await download());
		expect(text).toContain("[REDACTED:key]");
		expect(text).not.toContain(secret);
	} finally {
		scan.mockRestore();
	}
});

test("a late structured collision discards already compressed sections and joins its lease", async () => {
	source.secrets = [{ kind: "key", value: "s=1700" }];
	const scan = spyOn(pages, "scanPage")
		.mockResolvedValueOnce({
			...page([{ ...record(1), message: "safe text" }], true),
			continuation: "next",
		})
		.mockResolvedValue(page([record(1700)]));
	const enqueue = spyOn(ReadableStreamDefaultController.prototype, "enqueue");
	try {
		expect(await createBundle({})).toEqual({ ok: false, error: "READ_FAILED" });
		expect(enqueue).not.toHaveBeenCalled();
		source.secrets = [];
		scan.mockResolvedValue(page());
		expect((await createBundle({})).ok).toBe(true);
	} finally {
		scan.mockRestore();
		enqueue.mockRestore();
	}
});

test("multi-line and encoded secrets cannot escape any text field", async () => {
	const secret = 'secret/"\nline';
	source.secrets = [{ kind: "key", value: secret }];
	const scan = spyOn(pages, "scanPage")
		.mockResolvedValueOnce(
			page([
				{
					...record(1),
					message: [
						secret,
						JSON.stringify(secret).slice(1, -1),
						encodeURIComponent(secret),
						Buffer.from(secret).toString("base64"),
					].join(" "),
				},
			]),
		)
		.mockResolvedValue(page());
	try {
		const { text } = await unpack(await download());
		expect(text).not.toContain("secret");
		expect(text.match(/\[REDACTED:key\]/g)).toHaveLength(4);
	} finally {
		scan.mockRestore();
	}
});

test.each(["REDACTED", '"section":"journal"'])(
	"serialized framing and replacement markers cannot reintroduce a known secret %j",
	async (secret) => {
		source.secrets = [{ kind: "key", value: secret }];
		const scan = spyOn(pages, "scanPage")
			.mockResolvedValueOnce(
				page([
					{
						...record(1),
						message: secret,
					},
				]),
			)
			.mockResolvedValue(page());
		try {
			expect(await createBundle({})).toEqual({
				ok: false,
				error: "READ_FAILED",
			});
		} finally {
			scan.mockRestore();
		}
	},
);

test("a deadline cannot bypass pattern redaction of the frozen preview versions", async () => {
	collect.mockImplementation(async () => {
		now += 60_000;
		return {
			...source,
			exportedBy: { ...context, ceraui: "Bearer planted-token" },
		};
	});
	expect(await createBundle({})).toEqual({ ok: false, error: "READ_FAILED" });
	await expect(previewBundle()).rejects.toThrow("READ_FAILED");
});

test("a read failure is a sanitized incomplete journal and false end marker", async () => {
	fixture.scan.mockRejectedValue(new Error("planted-secret\nPRIVATE"));
	const { text, lines } = await unpack(await download());
	expect(text).not.toContain("planted-secret");
	expect(text).not.toContain("PRIVATE");
	expect(lines.slice(-2)).toEqual([
		{ section: "journal", incomplete: "READ_FAILED" },
		{ section: "end", complete: false },
	]);
});

test("null historical versions stay unknown rather than borrowing current versions", async () => {
	collect.mockResolvedValue({ ...source, boots: [{ bootId, versions: null }] });
	const manifest = await previewBundle();
	expect(manifest.boots).toEqual([{ bootId, versions: null }]);
	const { lines } = await unpack(await download());
	expect(lines[1]).toEqual({ section: "versions", bootId, versions: null });
});

test("retained future-event string arrays and empty arrays keep their JSON shape", async () => {
	const event = source.events[0];
	if (!event) throw new Error("missing event");
	event.code = "future_event";
	Object.assign(event.params, { packages: ["engine", "sender"], empty: [] });
	const { lines } = await unpack(await download());
	expect(
		lines.find((line) => line.section === "events" && "event" in line),
	).toMatchObject({
		event: {
			code: "future_event",
			params: { iface: "eth0", packages: ["engine", "sender"], empty: [] },
		},
	});
});

test("tickets are single-use, expire exactly at sixty seconds and reject other methods", async () => {
	const created = await ticket();
	const url = `http://device${created.url}`;
	expect(created.url).toMatch(/^\/api\/logs\/bundle\?ticket=[0-9a-f]{64}$/);
	expect(created.expiresAt).toBe(now + 60_000);
	expect(
		(await handleLogBundleRequest(new Request(url, { method: "POST" }))).status,
	).toBe(405);
	await unpack(await handleLogBundleRequest(new Request(url)));
	for (const target of [
		url,
		"http://device/api/logs/bundle",
		"http://device/api/logs/bundle?ticket=bad",
		"http://device/api/logs/bundle?ticket=",
	]) {
		const refused = await handleLogBundleRequest(new Request(target));
		expect(refused.status).toBe(403);
		expect(await refused.text()).toBe("");
	}
	const expired = await ticket();
	now = expired.expiresAt;
	const refused = await handleLogBundleRequest(
		new Request(`http://device${expired.url}`),
	);
	expect(refused.status).toBe(403);
	expect(await refused.text()).toBe("");
	expect((await ticket()).ok).toBe(true);
});

test("preview, preparing bundles, pending tickets and active downloads share export admission", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<ReturnType<typeof snapshot>>();
	collect.mockImplementation(() => {
		entered.resolve();
		return release.promise;
	});
	const building = createBundle({});
	await entered.promise;
	expect(await createBundle({})).toEqual({ ok: false, error: "BUSY" });
	await expect(previewBundle()).rejects.toMatchObject({
		code: "BUSY",
		message: "BUSY",
	});
	expect(await createExport({}, { filter: {} })).toEqual({
		ok: false,
		error: "BUSY",
	});
	release.resolve(source);
	const created = await building;
	if (!created.ok) throw new Error(created.error);
	expect(await createBundle({})).toEqual({ ok: false, error: "BUSY" });
	const response = await handleLogBundleRequest(
		new Request(`http://device${created.url}`),
	);
	now += 60_001;
	expect(await createExport({}, { filter: {} })).toEqual({
		ok: false,
		error: "BUSY",
	});
	await response.body?.cancel("consumer stopped");
	expect((await createExport({}, { filter: {} })).ok).toBe(true);
});

test("an expired pending bundle releases admission to exports without a bundle call", async () => {
	const first = await ticket();
	now = first.expiresAt;
	expect((await createExport({}, { filter: {} })).ok).toBe(true);
	expect(
		(await handleLogBundleRequest(new Request(`http://device${first.url}`)))
			.status,
	).toBe(403);
	expect(await createBundle({})).toEqual({ ok: false, error: "BUSY" });
});

test("an abort before collection emits nothing and releases its lease", async () => {
	const enqueue = spyOn(ReadableStreamDefaultController.prototype, "enqueue");
	try {
		expect(await createBundle({}, AbortSignal.abort("PRIVATE"))).toEqual({
			ok: false,
			error: "READ_FAILED",
		});
		expect(collect).not.toHaveBeenCalled();
		expect(enqueue).not.toHaveBeenCalled();
		expect((await createExport({}, { filter: {} })).ok).toBe(true);
	} finally {
		enqueue.mockRestore();
	}
});

test("a throwing epoch reader fails closed during creation and releases admission", async () => {
	fixture.epoch.mockImplementationOnce(() => {
		throw new Error("planted-secret");
	});
	expect(await createBundle({})).toEqual({ ok: false, error: "READ_FAILED" });
	expect((await createExport({}, { filter: {} })).ok).toBe(true);
});

test("a throwing epoch reader at download has an empty failure and releases admission", async () => {
	const created = await ticket();
	fixture.epoch.mockImplementationOnce(() => {
		throw new Error("planted-secret");
	});
	const response = await handleLogBundleRequest(
		new Request(`http://device${created.url}`),
	);
	expect(response.status).toBe(500);
	expect(await response.text()).toBe("");
	expect((await createExport({}, { filter: {} })).ok).toBe(true);
});

test("abort during a collision-prone collection joins work without disclosing its rejection", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<ReturnType<typeof snapshot>>();
	collect.mockImplementation(() => {
		entered.resolve();
		return release.promise;
	});
	const controller = new AbortController();
	const operation = createBundle({}, controller.signal);
	await entered.promise;
	controller.abort("planted-secret");
	source.secrets = [{ kind: "key", value: bootId }];
	release.resolve(source);
	expect(await operation).toEqual({ ok: false, error: "READ_FAILED" });
	expect((await createExport({}, { filter: {} })).ok).toBe(true);
});

test("abort while scanning reaches the native signal and releases sharing after the scan joins", async () => {
	const entered = Promise.withResolvers<AbortSignal>();
	const joined = Promise.withResolvers<void>();
	fixture.scan.mockImplementation(async (input) => {
		if (!input.signal) throw new Error("signal missing");
		entered.resolve(input.signal);
		await new Promise<void>((resolve) =>
			input.signal?.addEventListener("abort", () => resolve(), { once: true }),
		);
		await joined.promise;
		return { status: "stopped", exitCode: 0, skippedRecords: 0 };
	});
	const controller = new AbortController();
	const operation = createBundle({}, controller.signal);
	const signal = await entered.promise;
	controller.abort();
	expect(signal.aborted).toBe(true);
	expect(await createExport({}, { filter: {} })).toEqual({
		ok: false,
		error: "BUSY",
	});
	joined.resolve();
	expect(await operation).toEqual({ ok: false, error: "READ_FAILED" });
	expect((await createExport({}, { filter: {} })).ok).toBe(true);
});

test("clear aborts bundle preparation and invalidates its pending tickets through the existing clear hook", async () => {
	const pending = await ticket();
	await abortLogExports();
	expect(
		(await handleLogBundleRequest(new Request(`http://device${pending.url}`)))
			.status,
	).toBe(403);
	expect((await ticket()).ok).toBe(true);
});

test("an epoch change during preparation or before download cannot expose stale bytes", async () => {
	const created = await ticket();
	fixture.epoch.mockReturnValue({
		historyEpoch: 8,
		lastClearedAt: null,
		lastMaintenance: null,
	});
	const response = await handleLogBundleRequest(
		new Request(`http://device${created.url}`),
	);
	expect(response.status).toBe(409);
	expect(await response.text()).toBe("");
	const scan = spyOn(pages, "scanPage").mockImplementation(async () => {
		fixture.epoch.mockReturnValue({
			historyEpoch: 9,
			lastClearedAt: null,
			lastMaintenance: null,
		});
		return page();
	});
	try {
		expect(await createBundle({})).toEqual({ ok: false, error: "READ_FAILED" });
	} finally {
		scan.mockRestore();
	}
});

test("throwing stream consumers are contained, sanitized and release the lease", async () => {
	const created = await ticket();
	const response = await handleLogBundleRequest(
		new Request(`http://device${created.url}`),
	);
	const enqueue = spyOn(
		ReadableStreamDefaultController.prototype,
		"enqueue",
	).mockImplementation(() => {
		throw new Error("planted-secret");
	});
	try {
		await expect(response.arrayBuffer()).rejects.toThrow("READ_FAILED");
		expect((await createExport({}, { filter: {} })).ok).toBe(true);
	} finally {
		enqueue.mockRestore();
	}
});

test("request abort closes a paused download without another pull, even with a throwing close consumer", async () => {
	const created = await ticket();
	const controller = new AbortController();
	const response = await handleLogBundleRequest(
		new Request(`http://device${created.url}`, { signal: controller.signal }),
	);
	const close = spyOn(
		ReadableStreamDefaultController.prototype,
		"close",
	).mockImplementation(() => {
		throw new Error("planted-secret");
	});
	try {
		controller.abort("PRIVATE");
		expect((await createExport({}, { filter: {} })).ok).toBe(true);
		await expect(response.arrayBuffer()).rejects.toThrow("READ_FAILED");
	} finally {
		close.mockRestore();
	}
});

test("a paused download cannot keep the sharing lease after its deadline", async () => {
	const timer = spyOn(globalThis, "setTimeout");
	const cleared = spyOn(globalThis, "clearTimeout");
	try {
		const response = await download();
		expect(timer.mock.calls.at(-1)?.[1]).toBe(60_000);
		const fire = timer.mock.calls.at(-1)?.[0];
		if (typeof fire !== "function")
			throw new Error("missing download deadline");
		fire();
		await expect(response.arrayBuffer()).rejects.toThrow("READ_FAILED");
		expect((await createExport({}, { filter: {} })).ok).toBe(true);
		expect(cleared).toHaveBeenCalled();
	} finally {
		timer.mockRestore();
		cleared.mockRestore();
	}
});

test("a normal abort closes a paused download and a pre-aborted GET releases its ticket", async () => {
	const created = await ticket();
	const controller = new AbortController();
	const response = await handleLogBundleRequest(
		new Request(`http://device${created.url}`, { signal: controller.signal }),
	);
	controller.abort("PRIVATE");
	expect((await response.arrayBuffer()).byteLength).toBe(0);
	const next = await ticket();
	const refused = await handleLogBundleRequest(
		new Request(`http://device${next.url}`, { signal: AbortSignal.abort() }),
	);
	expect(refused.status).toBe(409);
	expect(await refused.text()).toBe("");
	expect((await createExport({}, { filter: {} })).ok).toBe(true);
});

test("completed preparations and downloads detach listeners and are absent from cancellation", async () => {
	const added = spyOn(AbortSignal.prototype, "addEventListener");
	const removed = spyOn(AbortSignal.prototype, "removeEventListener");
	const aborted = spyOn(AbortController.prototype, "abort");
	try {
		const response = await download();
		expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
		const listener = added.mock.calls.find(([name]) => name === "abort")?.[1];
		expect(listener).toBeDefined();
		expect(removed).toHaveBeenCalledWith("abort", listener);
		await abortLogBundles();
		expect(aborted).not.toHaveBeenCalled();
	} finally {
		added.mockRestore();
		removed.mockRestore();
		aborted.mockRestore();
	}
});

test("clear joins an active preparation before releasing sharing", async () => {
	const entered = Promise.withResolvers<void>();
	const stopped = Promise.withResolvers<void>();
	const joined = Promise.withResolvers<void>();
	fixture.scan.mockImplementation(async (input) => {
		entered.resolve();
		await new Promise<void>((resolve) =>
			input.signal?.addEventListener(
				"abort",
				() => {
					stopped.resolve();
					resolve();
				},
				{ once: true },
			),
		);
		await joined.promise;
		return { status: "stopped", exitCode: 0, skippedRecords: 0 };
	});
	const operation = createBundle({});
	await entered.promise;
	let cleared = false;
	const clearing = abortLogExports().then(() => {
		cleared = true;
	});
	await stopped.promise;
	expect(cleared).toBe(false);
	expect(await createExport({}, { filter: {} })).toEqual({
		ok: false,
		error: "BUSY",
	});
	joined.resolve();
	await clearing;
	expect(await operation).toEqual({ ok: false, error: "READ_FAILED" });
	expect((await createExport({}, { filter: {} })).ok).toBe(true);
});

test.each(["abort", "clear", "epoch", "time", "throw"] as const)(
	"final-member compression cannot bypass %s handling",
	async (mode) => {
		const Native = CompressionStream;
		const controller = new AbortController();
		const endMember =
			3 +
			source.boots.length +
			source.events.length +
			source.bootRecords.length;
		let member = 0;
		let clearing: Promise<void> | undefined;
		globalThis.CompressionStream = class extends Native {
			constructor(format: ConstructorParameters<typeof Native>[0]) {
				super(format);
				if (++member !== endMember) return;
				Object.defineProperty(this, "readable", {
					value: this.readable.pipeThrough(
						new TransformStream<Uint8Array, Uint8Array>({
							transform(chunk, sink) {
								sink.enqueue(chunk);
							},
							flush() {
								if (mode === "abort") controller.abort("PLANTED-SECRET");
								else if (mode === "clear") clearing = abortLogExports();
								else if (mode === "epoch")
									fixture.epoch.mockReturnValue({
										historyEpoch: 8,
										lastClearedAt: null,
										lastMaintenance: null,
									});
								else if (mode === "time") now += 60_000;
								else throw new Error("PLANTED-SECRET");
							},
						}),
					),
				});
			}
		};
		try {
			const result = await createBundle({}, controller.signal);
			if (mode === "time") {
				if (!result.ok) throw new Error(result.error);
				const { lines } = await unpack(
					await handleLogBundleRequest(
						new Request(`http://device${result.url}`),
					),
				);
				expect(lines.slice(-2)).toEqual([
					{ section: "journal", incomplete: "time_limit" },
					{ section: "end", complete: false },
				]);
				expect(lines.filter((line) => line.section === "end")).toHaveLength(1);
			} else expect(result).toEqual({ ok: false, error: "READ_FAILED" });
			await clearing;
			expect((await createExport({}, { filter: {} })).ok).toBe(true);
		} finally {
			globalThis.CompressionStream = Native;
			await clearing;
		}
	},
);

test("cancellation at preparation release cannot leave a newly minted ticket or sharing lease behind", async () => {
	const original = Map.prototype.delete;
	let queued = false;
	let clearing: Promise<void> | undefined;
	const deleted = spyOn(Map.prototype, "delete").mockImplementation(function (
		this: Map<unknown, unknown>,
		key: unknown,
	) {
		const result = original.call(this, key);
		if (!queued && key instanceof AbortController) {
			queued = true;
			queueMicrotask(() => {
				clearing = abortLogExports();
			});
		}
		return result;
	});
	try {
		const result = await createBundle({});
		await clearing;
		if (result.ok) {
			const refused = await handleLogBundleRequest(
				new Request(`http://device${result.url}`),
			);
			expect(refused.status).toBe(403);
			expect(await refused.text()).toBe("");
		} else expect(result).toEqual({ ok: false, error: "READ_FAILED" });
		expect((await createExport({}, { filter: {} })).ok).toBe(true);
	} finally {
		deleted.mockRestore();
		await clearing;
	}
});

test.each(["abort", "epoch"] as const)(
	"a completed body is fenced against %s before ticket publication",
	async (mode) => {
		const native = builder.buildBundle;
		const controller = new AbortController();
		const built = spyOn(builder, "buildBundle").mockImplementation(
			async (...args) => {
				const result = await native(...args);
				queueMicrotask(() => {
					if (mode === "abort") controller.abort("PRIVATE");
					else
						fixture.epoch.mockReturnValue({
							historyEpoch: 8,
							lastClearedAt: null,
							lastMaintenance: null,
						});
				});
				return result;
			},
		);
		try {
			expect(await createBundle({}, controller.signal)).toEqual({
				ok: false,
				error: "READ_FAILED",
			});
			expect((await createExport({}, { filter: {} })).ok).toBe(true);
		} finally {
			built.mockRestore();
		}
	},
);

test("a throwing ticket entropy source cannot expose an error or retain sharing", async () => {
	const random = spyOn(crypto, "getRandomValues").mockImplementation(() => {
		throw new Error("PLANTED-SECRET");
	});
	try {
		expect(await createBundle({})).toEqual({ ok: false, error: "READ_FAILED" });
	} finally {
		random.mockRestore();
	}
	expect((await createExport({}, { filter: {} })).ok).toBe(true);
});

test("the sixty-second deadline stops endless budget pages and emits an incomplete bundle", async () => {
	const scan = spyOn(pages, "scanPage").mockImplementation(async () => {
		now += 30_000;
		return page([], null);
	});
	try {
		const { lines } = await unpack(await download());
		expect(lines.slice(-2)).toEqual([
			{ section: "journal", incomplete: "time_limit" },
			{ section: "end", complete: false },
		]);
		expect(scan).toHaveBeenCalledTimes(2);
	} finally {
		scan.mockRestore();
	}
});

test("the timer aborts a held scan, joins it and leaves no pending ticket", async () => {
	const entered = Promise.withResolvers<void>();
	const timer = spyOn(globalThis, "setTimeout");
	const cleared = spyOn(globalThis, "clearTimeout");
	fixture.scan.mockImplementation(async (input) => {
		entered.resolve();
		await new Promise<void>((resolve) =>
			input.signal?.addEventListener("abort", () => resolve(), { once: true }),
		);
		return { status: "stopped", exitCode: 0, skippedRecords: 0 };
	});
	try {
		const operation = createBundle({});
		await entered.promise;
		const fire = timer.mock.calls.find(([, ms]) => ms === 60_000)?.[0];
		if (typeof fire !== "function") throw new Error("missing timer");
		fire();
		const created = await operation;
		if (!created.ok) throw new Error(created.error);
		const { lines } = await unpack(
			await handleLogBundleRequest(new Request(`http://device${created.url}`)),
		);
		expect(lines.slice(-2)).toEqual([
			{ section: "journal", incomplete: "time_limit" },
			{ section: "end", complete: false },
		]);
		expect(cleared).toHaveBeenCalled();
	} finally {
		timer.mockRestore();
		cleared.mockRestore();
	}
});

test("bundles count against the two-scan device limit without replacing the socket's query", async () => {
	const first = Promise.withResolvers<void>();
	const second = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let scans = 0;
	fixture.scan.mockImplementation(async () => {
		if (++scans === 1) first.resolve();
		else second.resolve();
		await release.promise;
		return { status: "eof", exitCode: 0, skippedRecords: 0 };
	});
	const query = queryLogs({}, {});
	await first.promise;
	const building = createBundle({});
	await second.promise;
	expect(await queryLogs({}, {})).toEqual({ ok: false, error: "BUSY" });
	release.resolve();
	expect((await query).ok).toBe(true);
	expect((await building).ok).toBe(true);
});

test("uncompressed output is bounded at 32 MiB and compressed output at 8 MiB", async () => {
	for (const random of [false, true]) {
		let n = 0;
		const messages = Array.from({ length: 200 }, () =>
			random
				? Buffer.from(crypto.getRandomValues(new Uint8Array(12_288))).toString(
						"base64",
					)
				: "x".repeat(16_384),
		);
		const scan = spyOn(pages, "scanPage").mockImplementation(
			async (_, scope) => ({
				...page(
					Array.from({ length: 200 }, (_, index) => ({
						...record(++n, { _BOOT_ID: scope.bootId }),
						message: messages[index] ?? "",
					})),
					true,
				),
				continuation: String(n),
			}),
		);
		try {
			const response = await download();
			const compressed = await response.arrayBuffer();
			expect(compressed.byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
			const text = await new Response(
				new Blob([compressed])
					.stream()
					.pipeThrough(new DecompressionStream("gzip")),
			).text();
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32 * 1024 * 1024);
			expect(text).toEndWith('{"section":"end","complete":false}\n');
			expect(text).toContain(
				`"incomplete":"${random ? "compressed_size_limit" : "size_limit"}"`,
			);
			expect(
				random ? compressed.byteLength : Buffer.byteLength(text),
			).toBeGreaterThan((random ? 7 : 31) * 1024 * 1024);
		} finally {
			scan.mockRestore();
		}
	}
}, 30_000);
