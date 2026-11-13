import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures/index.js";
import { startWorkerBackend, type WorkerBackend } from "./fixtures/backend.js";
import { BackendRpc } from "./fixtures/backend-rpc.js";

test("streaming sentinels belong to each backend acquisition", async ({}, testInfo) => {
	// An inherited marker represents a host or another runner, never this device.
	const root = testInfo.outputPath("sentinel");
	mkdirSync(root, { recursive: true });
	const inheritedMarker = join(root, "streaming");
	const previousMarker = process.env.CERALIVE_STREAMING_MARKER;
	process.env.CERALIVE_STREAMING_MARKER = inheritedMarker;
	const backends: WorkerBackend[] = [];
	const clients: BackendRpc[] = [];
	try {
		for (let index = 0; index < 2; index++) {
			const backend = await startWorkerBackend({ port: 0 });
			backends.push(backend);
			clients.push(
				await BackendRpc.connect(backend.port, {
					proxySecret: backend.proxySecret,
				}),
			);
		}
		writeFileSync(inheritedMarker, "foreign owner");
		const [firstBackend, secondBackend] = backends;
		if (!firstBackend || !secondBackend)
			throw new Error("Expected two backends");
		const [first, second] = clients;
		if (!first || !second) throw new Error("Expected two RPC clients");
		for (const client of clients) {
			await client.call(["streaming", "setConfig"], {
				source: "usb",
				srtla_addr: "127.0.0.1",
				srtla_port: 5000,
				srt_streamid: "e2e",
			});
		}
		// Hold the first stream live while starting the second: no scheduler luck.
		expect(
			await first.call(["streaming", "start"], { source: "usb" }),
		).toMatchObject({ success: true, is_streaming: true });
		try {
			expect(
				await second.call(["streaming", "start"], { source: "usb" }),
			).toMatchObject({ success: true, is_streaming: true });
			await second.call(["streaming", "stop"], {});
			expect(existsSync(firstBackend.streamingMarkerPath)).toBe(true);
			expect(existsSync(secondBackend.streamingMarkerPath)).toBe(false);
			// Stopping the second device cannot retire the first device's guard.
			expect(
				await first.call(["streaming", "start"], { source: "usb" }),
			).toMatchObject({ success: false, error: "START_IN_PROGRESS" });
		} finally {
			await first.call(["streaming", "stop"], {});
		}
		expect(readFileSync(inheritedMarker, "utf8")).toBe("foreign owner");
	} finally {
		for (const client of clients) client.close();
		await Promise.all(backends.map((backend) => backend.stop()));
		if (previousMarker === undefined)
			delete process.env.CERALIVE_STREAMING_MARKER;
		else process.env.CERALIVE_STREAMING_MARKER = previousMarker;
		rmSync(root, { recursive: true, force: true });
	}
});
