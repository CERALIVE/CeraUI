import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { buildDeviceBoundProbeArgv } from "../modules/network/device-bound-probe.ts";
import {
	dnsCacheResolve,
	dnsCacheValidate,
	setDnsCacheEntryForTest,
	setDnsResolverFactoryForTest,
} from "../modules/network/dns.ts";
import { checkConnectivity } from "../modules/network/internet.ts";
import { createConnectivityTargetResolver } from "../modules/network/uplink-health/connectivity-target.ts";
import { buildRemoteWsUrl } from "../modules/remote/remote-url.ts";
import {
	installFakeResolvers,
	dnsNotFound as notFound,
	queriesFor,
	settleAll,
} from "./helpers/dns-resolver-fixture.ts";

const WELLKNOWN_NAME = "wellknown.belabox.net";
const WELLKNOWN_ADDR = "127.1.33.7";
// Never present in the on-disk dns_cache.json, so the cache fallback is a
// deterministic throw rather than a stale hit.
const TARGET = "relay.test.invalid";
const CACHE_TARGET = "cache-relay.test.invalid";
const TARGET_ADDR = "203.0.113.9";
const TARGET_IPV6_ADDR = "2606:4700:4700::1111";

describe("dnsCacheResolve — concurrent health check + caller query", () => {
	afterEach(() => {
		setDnsResolverFactoryForTest(null);
		setDnsCacheEntryForTest(CACHE_TARGET, null);
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

	it("keeps the explicit AAAA path single-family", async () => {
		const hub = installFakeResolvers();
		const pending = dnsCacheResolve(TARGET, "aaaa");
		settleAll(queriesFor(hub, WELLKNOWN_NAME), null, [WELLKNOWN_ADDR]);
		settleAll(queriesFor(hub, TARGET), null, [TARGET_IPV6_ADDR]);

		expect(queriesFor(hub, TARGET).map((query) => query.method)).toEqual([
			"resolve6",
		]);
		await expect(pending).resolves.toEqual({
			addrs: [TARGET_IPV6_ADDR],
			fromCache: false,
		});
	});

	it("queries A and AAAA for an unspecified rrtype, alongside the health check", async () => {
		const hub = installFakeResolvers();

		const pending = dnsCacheResolve(TARGET);

		expect(
			queriesFor(hub, TARGET)
				.map((query) => query.method)
				.sort(),
		).toEqual(["resolve4", "resolve6"]);
		expect(
			new Set(queriesFor(hub, TARGET).map((query) => query.resolverId)).size,
		).toBe(2);
		expect(hub.resolverCount).toBe(3);
		expect(queriesFor(hub, WELLKNOWN_NAME)).toHaveLength(1);

		settleAll(queriesFor(hub, WELLKNOWN_NAME), null, [WELLKNOWN_ADDR]);
		for (const query of queriesFor(hub, TARGET)) {
			query.settle(null, [
				query.method === "resolve4" ? TARGET_ADDR : TARGET_IPV6_ADDR,
			]);
		}

		await expect(pending).resolves.toEqual({
			addrs: [TARGET_ADDR, TARGET_IPV6_ADDR],
			fromCache: false,
		});
	});

	it("waits for A when AAAA answers first and returns both families with A first", async () => {
		const hub = installFakeResolvers();
		const pending = dnsCacheResolve(TARGET);
		const targetQueries = queriesFor(hub, TARGET);
		const aQuery = targetQueries.find((query) => query.method === "resolve4");
		const aaaaQuery = targetQueries.find(
			(query) => query.method === "resolve6",
		);
		if (aQuery === undefined || aaaaQuery === undefined) {
			throw new Error("expected one A and one AAAA query");
		}

		settleAll(queriesFor(hub, WELLKNOWN_NAME), null, [WELLKNOWN_ADDR]);
		aaaaQuery.settle(null, [TARGET_IPV6_ADDR]);
		aQuery.settle(null, [TARGET_ADDR]);

		await expect(pending).resolves.toEqual({
			addrs: [TARGET_ADDR, TARGET_IPV6_ADDR],
			fromCache: false,
		});
	});

	it("returns the AAAA list when A has no answer", async () => {
		const hub = installFakeResolvers();
		const pending = dnsCacheResolve(TARGET);
		settleAll(queriesFor(hub, WELLKNOWN_NAME), null, [WELLKNOWN_ADDR]);
		for (const query of queriesFor(hub, TARGET)) {
			query.settle(
				query.method === "resolve4" ? notFound() : null,
				query.method === "resolve4" ? [] : [TARGET_IPV6_ADDR],
			);
		}

		await expect(pending).resolves.toEqual({
			addrs: [TARGET_IPV6_ADDR],
			fromCache: false,
		});
	});

	it("keeps the IPv4-only result unchanged when AAAA has no answer", async () => {
		const hub = installFakeResolvers();
		const pending = dnsCacheResolve(TARGET);
		settleAll(queriesFor(hub, WELLKNOWN_NAME), null, [WELLKNOWN_ADDR]);
		for (const query of queriesFor(hub, TARGET)) {
			query.settle(
				query.method === "resolve6" ? notFound() : null,
				query.method === "resolve6" ? [] : [TARGET_ADDR],
			);
		}

		await expect(pending).resolves.toEqual({
			addrs: [TARGET_ADDR],
			fromCache: false,
		});
	});

	it("stores both families in the cache in A-then-AAAA order", async () => {
		setDnsCacheEntryForTest(CACHE_TARGET, ["192.0.2.1"]);
		const liveHub = installFakeResolvers();
		const live = dnsCacheResolve(CACHE_TARGET);
		settleAll(queriesFor(liveHub, WELLKNOWN_NAME), null, [WELLKNOWN_ADDR]);
		for (const query of queriesFor(liveHub, CACHE_TARGET)) {
			query.settle(null, [
				query.method === "resolve4" ? TARGET_ADDR : TARGET_IPV6_ADDR,
			]);
		}
		await live;
		await dnsCacheValidate(CACHE_TARGET);

		const failedHub = installFakeResolvers();
		const cached = dnsCacheResolve(CACHE_TARGET);
		settleAll(queriesFor(failedHub, WELLKNOWN_NAME), notFound(), []);
		settleAll(queriesFor(failedHub, CACHE_TARGET), notFound(), []);

		await expect(cached).resolves.toEqual({
			addrs: [TARGET_ADDR, TARGET_IPV6_ADDR],
			fromCache: true,
		});
	});
});

describe("default-rrtype consumers", () => {
	it("gateways passes an IPv6 literal through a bracketed connectivity URL", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, { status: 204 }),
		);
		try {
			await expect(checkConnectivity(TARGET_IPV6_ADDR)).resolves.toBe(true);
			expect(fetchSpy.mock.calls[0]?.[0]).toBe(
				`http://[${TARGET_IPV6_ADDR}]/generate_204`,
			);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("uplink health preserves an IPv6 target through its device-bound URL", async () => {
		const target = createConnectivityTargetResolver({
			resolve: async () => ({ addrs: [TARGET_IPV6_ADDR], fromCache: false }),
			now: () => 0,
		});
		const addr = await target();
		if (addr === undefined)
			throw new Error("expected the resolved IPv6 target");
		const argv = buildDeviceBoundProbeArgv(addr, "eth0");

		expect(argv[argv.length - 1]).toBe(
			`http://[${TARGET_IPV6_ADDR}]/generate_204`,
		);
	});

	it("remote builds a parseable WebSocket URL from an IPv6 literal", () => {
		const url = buildRemoteWsUrl("wss", TARGET_IPV6_ADDR, "/ws");
		expect(String(url)).toBe(`wss://[${TARGET_IPV6_ADDR}]/ws`);
	});
});
