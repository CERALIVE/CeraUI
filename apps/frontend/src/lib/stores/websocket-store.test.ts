import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("svelte-sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("$lib/helpers/SystemHelper", () => ({
	downloadLog: vi.fn(),
}));

describe("websocket-store module import side effects", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("does NOT open a socket (rpcClient.connect) at import time", async () => {
		const { rpcClient } = await import("$lib/rpc/client");
		const connectSpy = vi
			.spyOn(rpcClient, "connect")
			.mockImplementation(() => {});

		await import("$lib/stores/websocket-store.svelte");

		expect(connectSpy).not.toHaveBeenCalled();
	});

	it("still registers the legacy message handler (feeds getStatus/getAuth)", async () => {
		const { rpcClient } = await import("$lib/rpc/client");
		const onMessageSpy = vi.spyOn(rpcClient, "onMessage");

		await import("$lib/stores/websocket-store.svelte");

		expect(onMessageSpy).toHaveBeenCalledTimes(1);
	});
});
