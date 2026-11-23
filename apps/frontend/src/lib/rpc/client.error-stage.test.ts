// @vitest-environment node
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SharingFlow } from "$lib/device-logs/sharing-flow.svelte";

import { rpc, rpcClient } from "./client";
import { RpcError } from "./rpc-error";

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState: number = FakeWebSocket.CONNECTING;
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;

	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	send(frame: string): void {
		this.sent.push(frame);
	}

	close(): void {
		if (this.readyState === FakeWebSocket.CLOSED) return;
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.();
	}

	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}
}

const realWebSocket = globalThis.WebSocket;
// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
const realGetUrl = rpcClient["getUrl"];
let socket: FakeWebSocket;

beforeEach(() => {
	FakeWebSocket.instances = [];
	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
	// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
	rpcClient["getUrl"] = () => "ws://test.local/ws";
	rpcClient.connect();
	const created = FakeWebSocket.instances[0];
	if (!created) throw new Error("missing socket");
	socket = created;
	socket.open();
});

afterEach(() => {
	rpcClient.disconnect();
	// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
	rpcClient["getUrl"] = realGetUrl;
	globalThis.WebSocket = realWebSocket;
	vi.restoreAllMocks();
});

/** Answers the newest previewBundle request with a raw device error frame. */
function refuse(stage: unknown): void {
	const request = socket.sent
		.map((frame) => JSON.parse(frame) as { id?: string; path?: string[] })
		.findLast((frame) => frame.path?.join(".") === "logs.previewBundle");
	if (!request?.id) throw new Error("missing previewBundle request");
	socket.onmessage?.({
		data: JSON.stringify({
			id: request.id,
			error: { message: "READ_FAILED", code: "INTERNAL_ERROR", stage },
		}),
	});
}

const HOSTILE: ReadonlyArray<readonly [string, unknown, string]> = [
	["an unknown word", "future_stage", "future_stage"],
	["an over-long value", "collision".repeat(512), "collisioncollision"],
	["a secret-shaped value", "v4.public.PLANTED-STAGE", "PLANTED-STAGE"],
	["a number", 4_190_154_203, "4190154203"],
	["an object", { leak: "PLANTED-OBJECT" }, "PLANTED-OBJECT"],
];

describe("an RPC error's stage crosses the client only as a closed bundle stage", () => {
	it("keeps a closed stage from the wire", async () => {
		const pending = rpc.logs.previewBundle();
		refuse("collision");
		const error = await pending.catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(RpcError);
		expect((error as RpcError).stage).toBe("collision");
	});

	it.each(HOSTILE)(
		"drops %s, so neither the error nor the console carries it",
		async (_name, stage, planted) => {
			const logged = [
				vi.spyOn(console, "error").mockImplementation(() => {}),
				vi.spyOn(console, "warn").mockImplementation(() => {}),
				vi.spyOn(console, "log").mockImplementation(() => {}),
			];
			const flow = new SharingFlow({
				current: () => true,
				logs: {
					createExport: () => Promise.reject(new Error("unused")),
					previewBundle: () => rpc.logs.previewBundle(),
					createBundle: () => Promise.reject(new Error("unused")),
				},
				download: () => {},
			});
			try {
				const opened = flow.openBundle();
				refuse(stage);
				await opened;
				expect(flow.bundleFailure).toBe("internal");
				expect(flow.bundleRefused).toBe(true);
				const calls = logged.flatMap((spy) => spy.mock.calls);
				expect(calls.length).toBeGreaterThan(0);
				const [, error] = calls[0] ?? [];
				expect(error).toBeInstanceOf(RpcError);
				expect((error as RpcError).stage).toBeUndefined();
				expect(inspect(calls, { depth: 10 })).not.toContain(planted);
			} finally {
				flow.dispose();
			}
		},
	);
});
