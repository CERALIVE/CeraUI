import { describe, expect, test } from "bun:test";

import type { BondEntry } from "../modules/streaming/bind-map.ts";
import type { BindMapPublication } from "../modules/streaming/bind-map-writer.ts";
import { prepareSrtlaIpAddresses } from "../modules/streaming/streamloop/session.ts";

const PUBLISHED: BindMapPublication = {
	ok: true,
	generation: 1,
	changed: true,
	sidecarPath: "/tmp/ips.bindmap.json",
};

const entry = (ip: string, iface: string): BondEntry => ({
	ip,
	iface,
	linkId: `lnk_${iface}`,
});

function deferred(): {
	readonly promise: Promise<BindMapPublication>;
	readonly resolve: () => void;
} {
	let resolvePromise: ((value: BindMapPublication) => void) | undefined;
	const promise = new Promise<BindMapPublication>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: () => resolvePromise?.(PUBLISHED) };
}

describe("SRTLA IP-list launch preparation", () => {
	test("does not resolve until the IP list has been written", async () => {
		const writeBarrier = deferred();
		let settled = false;
		const preparation = prepareSrtlaIpAddresses("relay.example", {
			isLocal: () => false,
			localList: () => [],
			bondedList: () => [entry("10.0.0.2", "eth0")],
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
					return PUBLISHED;
				},
			}),
		).rejects.toThrow("no_available_network_connections");
		expect(writes).toBe(0);
	});

	test("the local-subnet variant is interface-aware too", async () => {
		let published: readonly BondEntry[] = [];
		await prepareSrtlaIpAddresses("192.168.8.5", {
			isLocal: () => true,
			localList: () => [
				entry("192.168.8.100", "enx0c5b8f279a64"),
				entry("192.168.8.100", "eth1"),
			],
			bondedList: () => [],
			writeList: async (entries) => {
				published = entries;
				return PUBLISHED;
			},
		});

		expect(published.map((e) => e.iface)).toEqual(["enx0c5b8f279a64", "eth1"]);
		expect(published.map((e) => e.ip)).toEqual([
			"192.168.8.100",
			"192.168.8.100",
		]);
	});
});
