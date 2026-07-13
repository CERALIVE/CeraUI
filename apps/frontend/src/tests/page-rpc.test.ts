import { describe, expect, it } from "vitest";

import {
	PageRpc,
	type RpcServerRoute,
} from "../../tests/e2e/fixtures/page-rpc";

class FakeRpcRoute implements RpcServerRoute {
	readonly sent: string[] = [];
	private closeHandler: (() => void) | undefined;

	send(message: string | Buffer): void {
		this.sent.push(String(message));
	}

	close(): void {}

	onClose(handler: () => void): void {
		this.closeHandler = handler;
	}

	triggerClose(): void {
		this.closeHandler?.();
	}
}

describe("PageRpc connection lifecycle", () => {
	it("rejects stale calls on disconnect and sends later calls on the replacement route", async () => {
		const rpc = new PageRpc();
		const first = new FakeRpcRoute();
		const browser = new FakeRpcRoute();
		rpc.bindConnectionLifecycle(browser, first);
		const staleCall = rpc.call(["dev", "emit"], { type: "first" });
		await Promise.resolve();
		expect(first.sent).toHaveLength(1);

		first.triggerClose();
		await expect(staleCall).rejects.toThrow("page RPC connection closed");

		const second = new FakeRpcRoute();
		const replacementCall = rpc.call<{ accepted: boolean }>(["dev", "emit"], {
			type: "second",
		});
		expect(second.sent).toHaveLength(0);
		rpc.bindConnectionLifecycle(new FakeRpcRoute(), second);
		await Promise.resolve();
		expect(second.sent).toHaveLength(1);
		const request = JSON.parse(second.sent[0] ?? "") as { id: string };
		rpc.acceptServerMessage(
			JSON.stringify({ id: request.id, result: { accepted: true } }),
		);

		await expect(replacementCall).resolves.toEqual({ accepted: true });
		rpc.close();
	});
});
