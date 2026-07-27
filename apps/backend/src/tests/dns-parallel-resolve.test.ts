import { afterEach, describe, expect, it } from "bun:test";

import {
	type DnsResolverLike,
	dnsCacheResolve,
	setDnsResolverFactoryForTest,
} from "../modules/network/dns.ts";

const WELLKNOWN_NAME = "wellknown.belabox.net";
const WELLKNOWN_ADDR = "127.1.33.7";
// Never present in the on-disk dns_cache.json, so the cache fallback is a
// deterministic throw rather than a stale hit.
const TARGET = "relay.test.invalid";
const TARGET_ADDR = "203.0.113.9";

type Query = {
	readonly resolverId: number;
	readonly method: "resolve4" | "resolve6";
	readonly hostname: string;
	readonly settle: (
		err: NodeJS.ErrnoException | null,
		addresses: Array<string>,
	) => void;
};

type Hub = {
	readonly queries: Array<Query>;
	resolverCount: number;
	cancels: Array<number>;
};

function installFakeResolvers(): Hub {
	const hub: Hub = { queries: [], resolverCount: 0, cancels: [] };
	setDnsResolverFactoryForTest((): DnsResolverLike => {
		const resolverId = ++hub.resolverCount;
		const record =
			(method: "resolve4" | "resolve6") =>
			(
				hostname: string,
				callback: (
					err: NodeJS.ErrnoException | null,
					addresses: Array<string>,
				) => void,
			) => {
				hub.queries.push({
					resolverId,
					method,
					hostname,
					settle: callback,
				});
			};
		return {
			resolve4: record("resolve4"),
			resolve6: record("resolve6"),
			cancel: () => hub.cancels.push(resolverId),
		};
	});
	return hub;
}

function queriesFor(hub: Hub, hostname: string): Array<Query> {
	return hub.queries.filter((query) => query.hostname === hostname);
}

function settleAll(
	queries: Array<Query>,
	err: NodeJS.ErrnoException | null,
	addresses: Array<string>,
): void {
	for (const query of queries) query.settle(err, addresses);
}

const notFound = (): NodeJS.ErrnoException =>
	Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });

describe("dnsCacheResolve — concurrent health check + caller query", () => {
	afterEach(() => {
		setDnsResolverFactoryForTest(null);
	});

	it("issues the caller's query WITHOUT waiting for the well-known health check", async () => {
		const hub = installFakeResolvers();

		const pending = dnsCacheResolve(TARGET, "a");

		// Both legs are dispatched in the same synchronous turn — nothing has been
		// settled yet. Serialising them again would leave the target unqueried here.
		expect(queriesFor(hub, WELLKNOWN_NAME)).toHaveLength(1);
		expect(queriesFor(hub, TARGET)).toHaveLength(1);

		settleAll(queriesFor(hub, WELLKNOWN_NAME), null, [WELLKNOWN_ADDR]);
		settleAll(queriesFor(hub, TARGET), null, [TARGET_ADDR]);

		await expect(pending).resolves.toEqual({
			addrs: [TARGET_ADDR],
			fromCache: false,
		});
	});

	it("gives each leg its own resolver, so a cancel() can never reach the sibling", async () => {
		const hub = installFakeResolvers();

		const pending = dnsCacheResolve(TARGET, "a");

		const wellknownId = queriesFor(hub, WELLKNOWN_NAME)[0]?.resolverId;
		const targetId = queriesFor(hub, TARGET)[0]?.resolverId;
		expect(hub.resolverCount).toBe(2);
		expect(wellknownId).toBeDefined();
		expect(targetId).toBeDefined();
		expect(wellknownId).not.toBe(targetId);

		settleAll(queriesFor(hub, WELLKNOWN_NAME), null, [WELLKNOWN_ADDR]);
		settleAll(queriesFor(hub, TARGET), null, [TARGET_ADDR]);
		await pending;
	});

	it("discards the speculative answer when the well-known name resolves wrong", async () => {
		const hub = installFakeResolvers();

		const pending = dnsCacheResolve(TARGET, "a");
		settleAll(queriesFor(hub, WELLKNOWN_NAME), null, ["10.0.0.1"]);
		settleAll(queriesFor(hub, TARGET), null, [TARGET_ADDR]);

		await expect(pending).rejects.toBe(
			"DNS query failed and no cached value is available",
		);
	});

	it("discards the speculative answer when the well-known lookup itself fails", async () => {
		const hub = installFakeResolvers();

		const pending = dnsCacheResolve(TARGET, "a");
		settleAll(queriesFor(hub, WELLKNOWN_NAME), notFound(), []);
		settleAll(queriesFor(hub, TARGET), null, [TARGET_ADDR]);

		await expect(pending).rejects.toBe(
			"DNS query failed and no cached value is available",
		);
	});

	it("falls back when the health check passes but the caller's query fails", async () => {
		const hub = installFakeResolvers();

		const pending = dnsCacheResolve(TARGET, "a");
		settleAll(queriesFor(hub, WELLKNOWN_NAME), null, [WELLKNOWN_ADDR]);
		settleAll(queriesFor(hub, TARGET), notFound(), []);

		await expect(pending).rejects.toBe(
			"DNS query failed and no cached value is available",
		);
	});

	it("still short-circuits a literal IPv4 address with zero queries", async () => {
		const hub = installFakeResolvers();

		await expect(dnsCacheResolve("192.0.2.10", "a")).resolves.toEqual({
			addrs: ["192.0.2.10"],
			fromCache: false,
		});
		expect(hub.queries).toHaveLength(0);
		expect(hub.resolverCount).toBe(0);
	});

	it("queries A and AAAA for an unspecified rrtype, alongside the health check", async () => {
		const hub = installFakeResolvers();

		const pending = dnsCacheResolve(TARGET);

		expect(
			queriesFor(hub, TARGET)
				.map((query) => query.method)
				.sort(),
		).toEqual(["resolve4", "resolve6"]);
		expect(queriesFor(hub, WELLKNOWN_NAME)).toHaveLength(1);

		settleAll(queriesFor(hub, WELLKNOWN_NAME), null, [WELLKNOWN_ADDR]);
		settleAll(queriesFor(hub, TARGET), null, [TARGET_ADDR]);

		await expect(pending).resolves.toEqual({
			addrs: [TARGET_ADDR],
			fromCache: false,
		});
	});
});
