import { describe, expect, test } from "bun:test";

import { prepareSrtlaIpAddresses } from "../modules/streaming/streamloop/session.ts";

function deferred(): {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
} {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: () => resolvePromise?.() };
}

describe("SRTLA IP-list launch preparation", () => {
	test("does not resolve until the IP list has been written", async () => {
		const writeBarrier = deferred();
		let settled = false;
		const preparation = prepareSrtlaIpAddresses("relay.example", {
			isLocal: () => false,
			localList: () => [],
			bondedList: () => ["10.0.0.2"],
			writeList: () => writeBarrier.promise,
		}).then(() => {
			settled = true;
		});

		await Promise.resolve();
		expect(settled).toBe(false);
		writeBarrier.resolve();
		await preparation;
		expect(settled).toBe(true);
	});

	test("rejects launch preparation when no network address is available", async () => {
		let writes = 0;
		await expect(
			prepareSrtlaIpAddresses("relay.example", {
				isLocal: () => false,
				localList: () => [],
				bondedList: () => [],
				writeList: async () => {
					writes += 1;
				},
			}),
		).rejects.toThrow("no_available_network_connections");
		expect(writes).toBe(0);
	});
});
