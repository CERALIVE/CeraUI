// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { rpc, rpcClient } from "./client";

// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
const realGetUrl = rpcClient["getUrl"];

afterEach(() => {
	rpcClient.disconnect();
	// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
	rpcClient["getUrl"] = realGetUrl;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it.each([
	["logs.getStorage", () => rpc.logs.getStorage(), 60_000],
	[
		"logs.setRetention",
		() =>
			rpc.logs.setRetention({ maxAgeDays: 7, maxSizeMb: 64, detail: "info" }),
		135_000,
	],
	["logs.deleteLegacyDebug", () => rpc.logs.deleteLegacyDebug(), 75_000],
	["logs.clearAll", () => rpc.logs.clearAll(), 210_000],
	["events.clear", () => rpc.events.clear(), undefined],
] as const)(
	"%s uses its expected client deadline",
	async (path, call, timeout) => {
		const invoke = vi
			.spyOn(rpcClient, "call")
			.mockRejectedValue(new Error("test transport"));
		await expect(call()).rejects.toThrow("test transport");
		expect(
			invoke.mock.calls.map(([path, , timeout]) => [path, timeout]),
		).toEqual([[path.split("."), timeout]]);
	},
);

it("delivers a Clear all reply one second before its client deadline", async () => {
	vi.useFakeTimers();
	const sent = vi.fn<(frame: string) => void>();
	let transport: FakeSocket | undefined;
	class FakeSocket {
		static readonly CONNECTING = 0;
		static readonly OPEN = 1;
		readonly readyState = FakeSocket.OPEN;
		onmessage?: (event: { data: string }) => void;
		constructor() {
			transport = this;
		}
		send = sent;
		close() {}
	}
	vi.stubGlobal("WebSocket", FakeSocket);
	// biome-ignore lint/complexity/useLiteralKeys: test-only private transport seam
	rpcClient["getUrl"] = () => "ws://test.local/ws";
	rpcClient.connect();
	const result = { ok: false, error: "READ_FAILED" } as const;
	const pending = rpc.logs.clearAll().then(
		(reply) => ({ reply }),
		(error: unknown) => ({ error }),
	);
	const frame = sent.mock.calls[0]?.[0];
	if (!frame || !transport?.onmessage) throw new Error("missing request");
	await vi.advanceTimersByTimeAsync(209_000);
	transport.onmessage({
		data: JSON.stringify({ id: JSON.parse(frame).id, result }),
	});
	expect(await pending).toEqual({ reply: result });
});
