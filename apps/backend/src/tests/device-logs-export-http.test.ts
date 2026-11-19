import { afterAll, expect, spyOn, test } from "bun:test";
import {
	abortLogExports,
	createExport,
} from "../modules/device-logs/export.ts";
import * as versions from "../modules/system/version-context.ts";
import {
	bootId,
	journal,
	queryFixture,
	record,
} from "./helpers/device-query.ts";

const previousPort = process.env.PORT;
const previousNodeEnv = process.env.NODE_ENV;
process.env.PORT = "0";
process.env.NODE_ENV = "development";
const { initServer, getServer, stopServer } = await import("../rpc/server.ts");
afterAll(async () => {
	stopServer();
	await abortLogExports();
	if (previousPort === undefined) delete process.env.PORT;
	else process.env.PORT = previousPort;
	if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = previousNodeEnv;
});

test("the real server routes ticketed GET and rejects POST before the frontend proxy", async () => {
	const fixture = queryFixture();
	const context = spyOn(versions, "collectVersionContext").mockResolvedValue({
		bootId,
		osImage: null,
		slot: null,
		board: null,
		boardModel: null,
		ceraui: "test",
		engine: null,
		senderVersion: null,
		kernel: null,
		bun: null,
	});
	fixture.scan.mockImplementation(journal([record(1)]));
	try {
		initServer();
		const server = getServer();
		if (!server) throw new Error("server failed to start");
		const created = await createExport({}, { boot: bootId, filter: {} });
		if (!created.ok) throw new Error(created.error);
		const url = new URL(created.url, server.url);
		const response = await fetch(url);
		expect(response.status).toBe(200);
		expect(response.headers.has("Content-Length")).toBe(false);
		expect(await response.text()).toEndWith("# complete: 1 entries\n");
		const reused = await fetch(url);
		expect(reused.status).toBe(403);
		expect(await reused.text()).toBe("");
		expect((await fetch(url, { method: "POST" })).status).toBe(405);
		const status = await fetch(new URL("/status", server.url));
		expect(status.status).toBe(200);
		expect(await status.json()).toEqual({ is_streaming: false });
	} finally {
		stopServer();
		fixture.restore();
		context.mockRestore();
	}
});
