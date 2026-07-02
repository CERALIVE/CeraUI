/*
 * Todo 21 — dev preview WebSocket server contract.
 *
 * Proves the mock preview server (`mocks/providers/preview.ts`) emits the EXACT
 * wire shape `apps/frontend/src/lib/components/preview/PreviewCanvas.svelte`
 * parses: a `codec-config` JSON text frame FIRST, then keyframe-first binary
 * access units behind a 9-byte `[flags:u8][pts_us:i64 BE]` header, plus
 * `audio-level` JSON at <=10 Hz. Also proves it is fully inert (no port bind)
 * when `shouldUseMocks()` is false, cleans up timers on disconnect, and ignores
 * an unknown action without crashing.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	initMockService,
	shouldUseMocks,
	stopMockService,
} from "../mocks/mock-service.ts";
import {
	getActivePreviewConnCount,
	getMockPreviewServer,
	startMockPreviewServer,
	stopMockPreviewServer,
} from "../mocks/providers/preview.ts";

const ORIGINAL_MOCK_MODE = process.env.MOCK_MODE;

interface Collected {
	texts: Record<string, unknown>[];
	binaries: ArrayBuffer[];
}

function connect(port: number): {
	ws: WebSocket;
	collected: Collected;
} {
	const ws = new WebSocket(`ws://localhost:${port}`);
	ws.binaryType = "arraybuffer";
	const collected: Collected = { texts: [], binaries: [] };
	ws.onmessage = (event) => {
		if (typeof event.data === "string") {
			try {
				collected.texts.push(JSON.parse(event.data));
			} catch {
				/* ignore non-JSON */
			}
		} else if (event.data instanceof ArrayBuffer) {
			collected.binaries.push(event.data);
		}
	};
	return { ws, collected };
}

function waitOpen(ws: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error("ws error"));
	});
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 3000,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
}

describe("mock preview server — inert when mocks are OFF", () => {
	it("binds no listener and returns null when shouldUseMocks() is false", () => {
		delete process.env.MOCK_MODE;
		expect(shouldUseMocks()).toBe(false);
		const server = startMockPreviewServer(0);
		expect(server).toBeNull();
		expect(getMockPreviewServer()).toBeNull();
	});
});

describe("mock preview server — wire contract under mocks", () => {
	let port = 0;

	beforeAll(() => {
		process.env.MOCK_MODE = "true";
		initMockService("multi-modem-wifi");
		expect(shouldUseMocks()).toBe(true);
		const server = startMockPreviewServer(0);
		expect(server).not.toBeNull();
		port = server?.port ?? 0;
		expect(port).toBeGreaterThan(0);
	});

	afterAll(() => {
		stopMockPreviewServer();
		stopMockService();
		if (ORIGINAL_MOCK_MODE === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = ORIGINAL_MOCK_MODE;
	});

	it("sends codec-config first, then a keyframe AU, then audio-level", async () => {
		const { ws, collected } = connect(port);
		await waitOpen(ws);
		ws.send(JSON.stringify({ action: "start", tier: "webcodecs" }));

		await waitFor(
			() =>
				collected.texts.some((m) => m.type === "codec-config") &&
				collected.binaries.length >= 1 &&
				collected.texts.some((m) => m.type === "audio-level"),
		);

		// codec-config MUST be the first text frame (parser gates decode on it).
		expect(collected.texts[0]?.type).toBe("codec-config");
		const config = collected.texts.find((m) => m.type === "codec-config")!;
		expect(typeof config.codec).toBe("string");
		expect(config.codec).toMatch(/^avc1\./);
		expect(typeof config.description).toBe("string");
		expect(config.coded_width).toBeGreaterThan(0);
		expect(config.coded_height).toBeGreaterThan(0);

		// First binary AU: valid 9-byte header, keyframe-flagged, decodable pts.
		const first = collected.binaries[0]!;
		expect(first.byteLength).toBeGreaterThan(9);
		const view = new DataView(first);
		const flags = view.getUint8(0);
		expect(flags & 0x1).toBe(1); // keyframe-first
		const ptsUs = view.getBigInt64(1, false); // big-endian i64 microseconds
		expect(ptsUs).toBeGreaterThanOrEqual(0n);

		// audio-level shape.
		const audio = collected.texts.find((m) => m.type === "audio-level")!;
		expect(Array.isArray(audio.rms_db)).toBe(true);
		expect(Array.isArray(audio.peak_db)).toBe(true);
		expect((audio.rms_db as number[]).length).toBe(
			(audio.peak_db as number[]).length,
		);

		ws.close();
	});

	it("emits audio-level at <=10 Hz (>=100 ms spacing)", async () => {
		const { ws, collected } = connect(port);
		await waitOpen(ws);
		const t0 = Date.now();
		ws.send(JSON.stringify({ action: "start", tier: "webcodecs" }));
		await waitFor(
			() => collected.texts.filter((m) => m.type === "audio-level").length >= 2,
			4000,
		);
		const elapsed = Date.now() - t0;
		const audioCount = collected.texts.filter(
			(m) => m.type === "audio-level",
		).length;
		// N frames arrived over `elapsed` ms -> average spacing must be >=100 ms.
		expect(elapsed / audioCount).toBeGreaterThanOrEqual(100);
		ws.close();
	});

	it("clears all timers on client disconnect (no leak)", async () => {
		const { ws, collected } = connect(port);
		await waitOpen(ws);
		ws.send(JSON.stringify({ action: "start", tier: "webcodecs" }));
		await waitFor(() => collected.binaries.length >= 1);
		expect(getActivePreviewConnCount()).toBeGreaterThanOrEqual(1);
		ws.close();
		await waitFor(() => getActivePreviewConnCount() === 0);
		expect(getActivePreviewConnCount()).toBe(0);
	});

	it("ignores an unknown action without streaming or crashing", async () => {
		const { ws, collected } = connect(port);
		await waitOpen(ws);
		ws.send(JSON.stringify({ action: "definitely-not-start" }));
		await new Promise((r) => setTimeout(r, 250));
		expect(collected.texts.length).toBe(0);
		expect(collected.binaries.length).toBe(0);

		// The connection is still healthy: a real start now works.
		ws.send(JSON.stringify({ action: "start", tier: "webcodecs" }));
		await waitFor(() => collected.texts.some((m) => m.type === "codec-config"));
		expect(collected.texts[0]?.type).toBe("codec-config");
		ws.close();
	});
});
