import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { logBundleManifestSchema, logEntrySchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import * as logging from "../helpers/logger.ts";
import * as bundle from "../modules/device-logs/bundle.ts";
import { abortLogBundles } from "../modules/device-logs/bundle.ts";
import * as data from "../modules/device-logs/bundle-data.ts";
import { appRouter } from "../rpc/router.ts";
import {
	bootId,
	journal,
	queryFixture,
	record,
} from "./helpers/device-query.ts";
import { logsSockets } from "./helpers/logs-rpc.ts";

const previousPort = process.env.PORT;
const previousEnv = process.env.NODE_ENV;
process.env.PORT = "0";
process.env.NODE_ENV = "development";
const { initServer, getServer, stopServer } = await import("../rpc/server.ts");
const current = {
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
let sockets: Awaited<ReturnType<typeof logsSockets>>;
beforeEach(async () => {
	fixture = queryFixture();
	fixture.scan.mockImplementation(
		journal([record(1, { MESSAGE: "planted-stream-key" })]),
	);
	collect = spyOn(data, "collectBundleData").mockResolvedValue({
		exportedBy: current,
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
		secrets: [{ kind: "stream", value: "planted-stream-key" }],
	});
	sockets = await logsSockets();
});
afterEach(async () => {
	stopServer();
	await abortLogBundles();
	sockets.close();
	collect.mockRestore();
	fixture.restore();
});
afterAll(() => {
	if (previousPort === undefined) delete process.env.PORT;
	else process.env.PORT = previousPort;
	if (previousEnv === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = previousEnv;
});

test.each(["previewBundle", "createBundle"] as const)(
	"%s refuses unauthenticated callers without collecting any data",
	async (name) => {
		const result =
			name === "previewBundle"
				? call(appRouter.logs.previewBundle, undefined, {
						context: sockets.guestContext,
					})
				: call(appRouter.logs.createBundle, undefined, {
						context: sockets.guestContext,
					});
		await expect(result).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(collect).not.toHaveBeenCalled();
	},
);
test.each(
	[
		{},
		[],
		null,
		"",
		"hostile\nPRIVATE",
		-1,
		1.5,
		Number.MAX_SAFE_INTEGER,
		1e100,
	].map((input) => ({ input })),
)("bundle RPC refuses extra input at admission: %j", async ({ input }) => {
	for (const name of ["previewBundle", "createBundle"] as const) {
		let reply: unknown;
		const send = spyOn(sockets.ws, "send").mockImplementation((frame) => {
			reply = JSON.parse(String(frame));
			return 1;
		});
		try {
			const { handleORPCMessage } = await import("../rpc/adapter.ts");
			await handleORPCMessage(sockets.ws, {
				id: "invalid-bundle",
				path: ["logs", name],
				input,
			});
			expect(reply).toMatchObject({
				error: { code: "VALIDATION_ERROR", message: "Input validation failed" },
			});
		} finally {
			send.mockRestore();
		}
	}
	expect(collect).not.toHaveBeenCalled();
});
test("authenticated preview and creation drive a real single-use gzip HTTP download", async () => {
	const preview = await call(appRouter.logs.previewBundle, undefined, {
		context: sockets.context,
	});
	expect(logBundleManifestSchema.safeParse(preview).success).toBe(true);
	expect(preview.sections.find((section) => section.id === "journal")).toEqual({
		id: "journal",
		entries: 1,
		redactions: 1,
		bootsCovered: 1,
		complete: true,
	});
	const created = await call(appRouter.logs.createBundle, undefined, {
		context: sockets.context,
	});
	if (!created.ok) throw new Error(created.error);
	initServer();
	const server = getServer();
	if (!server) throw new Error("missing server");
	const url = new URL(created.url, server.url);
	expect((await fetch(url, { method: "POST" })).status).toBe(405);
	const response = await fetch(url);
	expect(response.status).toBe(200);
	expect(response.headers.get("Content-Type")).toBe("application/gzip");
	expect(response.headers.has("Content-Length")).toBe(false);
	if (!response.body) throw new Error("missing HTTP body");
	const text = await new Response(
		response.body.pipeThrough(new DecompressionStream("gzip")),
	).text();
	expect(text).not.toContain("planted-stream-key");
	expect(text).toContain("[REDACTED:stream]");
	expect(text).toEndWith('{"section":"end","complete":true}\n');
	const reused = await fetch(url);
	expect(reused.status).toBe(403);
	expect(await reused.text()).toBe("");
	const status = await fetch(new URL("/status", server.url));
	expect(status.status).toBe(200);
	expect(await status.json()).toEqual({ is_streaming: false });
});
test("gzip downloads mask public IPv4 embeddings and retain local diagnostics", async () => {
	const addresses = [
		"::ffff:8.8.8.8",
		"[64:ff9b::1.1.1.1]:9000",
		"0:0:0:0:0:FFFF:0808:0808",
		"0064:ff9b:0:0:0:0:0101:0101",
		"4000::8.8.4.4",
	];
	const local = [
		"::ffff:10.0.0.1",
		"::ffff:172.31.0.1",
		"64:ff9b::192.168.0.1",
		"64:ff9b::127.0.0.1",
		"64:ff9b::169.254.0.1",
		"::ffff:6440:1",
		"fd00::8.8.8.8",
		"fe80::1%eth0",
		"2026-11-19T08:12:34.567Z",
	].join(" ");
	const cursor = `s=abcd;i=1;b=${bootId};m=1500;t=abcd;x=4321`;
	fixture.scan.mockImplementation(
		journal([
			record(1, {
				__CURSOR: cursor,
				MESSAGE: [...addresses, local, "aa:bb:cc:dd:ee:ff"].join(" "),
			}),
		]),
	);
	const preview = await call(appRouter.logs.previewBundle, undefined, {
		context: sockets.context,
	});
	const created = await call(appRouter.logs.createBundle, undefined, {
		context: sockets.context,
	});
	if (!created.ok) throw new Error(created.error);
	initServer();
	const server = getServer();
	if (!server) throw new Error("missing server");
	const response = await fetch(new URL(created.url, server.url));
	expect(response.status).toBe(200);
	if (!response.body) throw new Error("missing HTTP body");
	const text = await new Response(
		response.body.pipeThrough(new DecompressionStream("gzip")),
	).text();
	const entries = text
		.trimEnd()
		.split("\n")
		.map((row): { section: string; entry?: unknown } => JSON.parse(row))
		.filter((row) => row.section === "journal")
		.map((row) => logEntrySchema.parse(row.entry));
	expect(entries.map(({ cursor, message }) => ({ cursor, message }))).toEqual([
		{
			cursor,
			message: `[IP] [IP]:9000 [IP] [IP] 4000::[IP] ${local} aa:bb:cc:**:**:**`,
		},
	]);
	expect(preview.sections.find(({ id }) => id === "journal")).toEqual({
		id: "journal",
		entries: 1,
		redactions: 6,
		bootsCovered: 1,
		complete: true,
	});
});

test("a frozen-schema collision gives only READ_FAILED over RPC and no download bytes", async () => {
	const original = await collect();
	collect.mockResolvedValue({
		...original,
		secrets: [{ kind: "key", value: bootId }],
	});
	await expect(
		call(appRouter.logs.previewBundle, undefined, { context: sockets.context }),
	).rejects.toMatchObject({
		code: "READ_FAILED",
		message: "READ_FAILED",
		data: { stage: "collision" },
	});
	expect(
		await call(appRouter.logs.createBundle, undefined, {
			context: sockets.context,
		}),
	).toEqual({ ok: false, error: "READ_FAILED" });
	initServer();
	const server = getServer();
	if (!server) throw new Error("missing server");
	const response = await fetch(
		new URL("/api/logs/bundle?ticket=invalid", server.url),
	);
	expect(response.status).toBe(403);
	expect((await response.arrayBuffer()).byteLength).toBe(0);
	collect.mockResolvedValue(original);
	expect(
		(
			await call(appRouter.logs.createBundle, undefined, {
				context: sockets.context,
			})
		).ok,
	).toBe(true);
});
test("preview admission preserves the existing BUSY error vocabulary", async () => {
	const result = await call(appRouter.logs.createBundle, undefined, {
		context: sockets.context,
	});
	expect(result.ok).toBe(true);
	await expect(
		call(appRouter.logs.previewBundle, undefined, { context: sockets.context }),
	).rejects.toMatchObject({ code: "BUSY", message: "BUSY" });
});

test.each(["collection", "procedure"] as const)(
	"opaque %s errors reach the existing WS envelope without secret-derived messages or logs",
	async (failure) => {
		const secret = "PLANTED-BUNDLE-SECRET";
		const unexpected =
			failure === "procedure"
				? spyOn(bundle, "previewBundle").mockRejectedValue(new Error(secret))
				: undefined;
		if (failure === "collection") collect.mockRejectedValue(new Error(secret));
		const errorLog = spyOn(logging.logger, "error").mockImplementation(
			() => logging.logger,
		);
		let reply: unknown;
		const send = spyOn(sockets.ws, "send").mockImplementation((frame) => {
			reply = JSON.parse(String(frame));
			return 1;
		});
		try {
			const { handleORPCMessage } = await import("../rpc/adapter.ts");
			await handleORPCMessage(sockets.ws, {
				id: "bundle-failure",
				path: ["logs", "previewBundle"],
				input: undefined,
			});
			expect(reply).toEqual({
				id: "bundle-failure",
				error: { code: "INTERNAL_ERROR", message: "READ_FAILED" },
			});
			expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secret);
			expect(errorLog).toHaveBeenCalledTimes(1);
		} finally {
			unexpected?.mockRestore();
			errorLog.mockRestore();
			send.mockRestore();
		}
	},
);

test("the WS envelope keeps the legacy BUSY message and adds no stage", async () => {
	expect(
		(
			await call(appRouter.logs.createBundle, undefined, {
				context: sockets.context,
			})
		).ok,
	).toBe(true);
	let reply: unknown;
	const send = spyOn(sockets.ws, "send").mockImplementation((frame) => {
		reply = JSON.parse(String(frame));
		return 1;
	});
	try {
		const { handleORPCMessage } = await import("../rpc/adapter.ts");
		await handleORPCMessage(sockets.ws, {
			id: "bundle-busy",
			path: ["logs", "previewBundle"],
			input: undefined,
		});
		expect(reply).toEqual({
			id: "bundle-busy",
			error: { code: "INTERNAL_ERROR", message: "BUSY" },
		});
	} finally {
		send.mockRestore();
	}
});

test("the WS envelope keeps the legacy READ_FAILED message and adds the sanitized stage, never its cause", async () => {
	const original = await collect();
	collect.mockResolvedValue({
		...original,
		secrets: [{ kind: "stream", value: "live" }],
	});
	const errorLog = spyOn(logging.logger, "error").mockImplementation(
		() => logging.logger,
	);
	const warnLog = spyOn(logging.logger, "warn").mockImplementation(
		() => logging.logger,
	);
	let reply: unknown;
	const send = spyOn(sockets.ws, "send").mockImplementation((frame) => {
		reply = JSON.parse(String(frame));
		return 1;
	});
	try {
		const { handleORPCMessage } = await import("../rpc/adapter.ts");
		await handleORPCMessage(sockets.ws, {
			id: "bundle-collision",
			path: ["logs", "previewBundle"],
			input: undefined,
		});
		expect(reply).toEqual({
			id: "bundle-collision",
			error: {
				code: "INTERNAL_ERROR",
				message: "READ_FAILED",
				stage: "collision",
			},
		});
		expect(errorLog).toHaveBeenCalledTimes(1);
		expect(
			warnLog.mock.calls
				.map((call): unknown[] => [...call])
				.filter(
					([message]) => message === "Support bundle preparation refused",
				),
		).toEqual([
			[
				"Support bundle preparation refused",
				{ module: "device-logs", operation: "preview", stage: "collision" },
			],
		]);
	} finally {
		errorLog.mockRestore();
		warnLog.mockRestore();
		send.mockRestore();
	}
});

test.each(["previewBundle", "createBundle"] as const)(
	"%s retains the frozen output schema at the RPC boundary",
	async (name) => {
		const malformed = JSON.parse("null");
		const producer =
			name === "previewBundle"
				? spyOn(bundle, "previewBundle").mockResolvedValue(malformed)
				: spyOn(bundle, "createBundle").mockResolvedValue(malformed);
		try {
			const result =
				name === "previewBundle"
					? call(appRouter.logs.previewBundle, undefined, {
							context: sockets.context,
						})
					: call(appRouter.logs.createBundle, undefined, {
							context: sockets.context,
						});
			await expect(result).rejects.toMatchObject({
				code: "INTERNAL_SERVER_ERROR",
				message: "Output validation failed",
			});
		} finally {
			producer.mockRestore();
		}
	},
);
