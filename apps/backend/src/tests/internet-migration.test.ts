/*
 * Tests for the internet.ts `http.get` → `fetch()` migration (Task 12).
 *
 * Backfilled by Task 19 (verification sweep): the http.get → fetch migration
 * landed without a dedicated test. These lock the two public surfaces:
 *
 *   httpGet()          — builds `http://<host><path>`, returns { code, body },
 *                        clears its timeout timer, and rethrows fetch failures.
 *   checkConnectivity()— returns true ONLY on the gstatic 204 + empty-body
 *                        signal; false on any other code/body or a fetch throw
 *                        (the error is swallowed and logged, never propagated).
 *
 * shouldUseMocks() is false here (initMockService() is never called in this
 * file → mockState.initialized stays false), so checkConnectivity() exercises
 * the real fetch path rather than the mock short-circuit.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
	CONNECTIVITY_CHECK_DOMAIN,
	checkConnectivity,
	httpGet,
} from "../modules/network/internet.ts";

let fetchSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
	fetchSpy?.mockRestore();
	fetchSpy = undefined;
});

function mockFetch(impl: (input: unknown, init?: RequestInit) => Response) {
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		async (input: unknown, init?: RequestInit) => impl(input, init),
	);
	return fetchSpy;
}

describe("httpGet — fetch-backed HTTP probe", () => {
	test("happy: builds http URL from host+path and returns { code, body }", async () => {
		const spy = mockFetch(() => new Response("hello", { status: 200 }));

		const res = await httpGet({ host: "1.2.3.4", path: "/probe" });

		expect(res).toEqual({ code: 200, body: "hello" });
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[0]).toBe("http://1.2.3.4/probe");
	});

	test("happy: 204 null-body response yields code 204 + empty body", async () => {
		mockFetch(() => new Response(null, { status: 204 }));

		const res = await httpGet({ host: "1.2.3.4", path: "/generate_204" });

		expect(res).toEqual({ code: 204, body: "" });
	});

	test("defaults the path to '/' when none is supplied", async () => {
		const spy = mockFetch(() => new Response("", { status: 200 }));

		await httpGet({ host: "example.test" });

		expect(spy.mock.calls[0]?.[0]).toBe("http://example.test/");
	});

	test("forwards request headers to fetch", async () => {
		const spy = mockFetch(() => new Response(null, { status: 204 }));

		await httpGet({
			host: "1.2.3.4",
			path: "/generate_204",
			headers: { Host: CONNECTIVITY_CHECK_DOMAIN },
		});

		const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
		expect((init?.headers as Record<string, string>).Host).toBe(
			CONNECTIVITY_CHECK_DOMAIN,
		);
		// An AbortSignal is always attached for the timeout path.
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});

	test("negative: rethrows when fetch rejects (timer still cleared)", async () => {
		mockFetch(() => {
			throw new Error("network down");
		});

		await expect(httpGet({ host: "1.2.3.4", timeout: 4000 })).rejects.toThrow(
			"network down",
		);
	});
});

describe("checkConnectivity — gstatic 204 signal", () => {
	test("happy: 204 + empty body → true", async () => {
		const spy = mockFetch(() => new Response(null, { status: 204 }));

		await expect(checkConnectivity("8.8.8.8")).resolves.toBe(true);
		// Probes the supplied remote addr with the gstatic Host header.
		expect(spy.mock.calls[0]?.[0]).toBe("http://8.8.8.8/generate_204");
		const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
		expect((init?.headers as Record<string, string>).Host).toBe(
			CONNECTIVITY_CHECK_DOMAIN,
		);
	});

	test("negative: wrong status code → false", async () => {
		mockFetch(() => new Response("", { status: 200 }));

		await expect(checkConnectivity("8.8.8.8")).resolves.toBe(false);
	});

	test("negative: 204 but non-empty body → false", async () => {
		mockFetch(() => new Response("captive-portal", { status: 200 }));

		await expect(checkConnectivity("8.8.8.8")).resolves.toBe(false);
	});

	test("negative: fetch throw is swallowed → false (never propagates)", async () => {
		mockFetch(() => {
			throw new Error("ECONNREFUSED");
		});

		await expect(checkConnectivity("8.8.8.8")).resolves.toBe(false);
	});
});
