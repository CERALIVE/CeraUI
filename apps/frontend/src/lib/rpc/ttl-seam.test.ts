/**
 * TTL test-seam guard (Task 22).
 *
 * The TTL-boundary e2e suites (bond-toggle-flash scenarios E/K, wifi-surface
 * scenario 4) used to burn the full FIELD_LOCK_TTL_MS (10s) / ASYNC_OP_TTL_MS
 * (15s) of real wall-clock. The `window.__ceraFieldLockTtlMs` /
 * `window.__ceraAsyncOpTtlMs` seams (mirroring the `__ceraRebootCountdownSeconds`
 * precedent) let those suites collapse the wait. This suite is the contract that
 * the seam DOES NOT LEAK: the production defaults are unchanged, the resolver
 * falls back to them whenever the window override is absent or invalid, and the
 * pure sweep cores keep the production constant as their default argument (so the
 * seam touches nothing unless a positive override is explicitly armed).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ASYNC_OP_TTL_MS,
	asyncOpCore,
	resolveAsyncOpTtlMs,
} from "./async-operation.svelte";
import {
	FIELD_LOCK_TTL_MS,
	registryCore,
	resolveFieldLockTtlMs,
} from "./dirty-registry.svelte";
import { createSyncRegistry, syncCore } from "./field-sync-state.svelte";

// async-operation.svelte pulls in i18n + toast at import time; the seam tests
// never reach osCommand, but mock them so the import never boots the i18n runtime.
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@ceraui/i18n/svelte", () => ({
	getLL: () => ({ network: { os: { operationFailed: () => "failed" } } }),
}));

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("TTL test seams — production defaults are untouched", () => {
	it("FIELD_LOCK_TTL_MS / ASYNC_OP_TTL_MS keep their hardware defaults", () => {
		expect(FIELD_LOCK_TTL_MS).toBe(10_000);
		expect(ASYNC_OP_TTL_MS).toBe(15_000);
	});

	it("resolvers return the production default with no window override (node env)", () => {
		expect(typeof window).toBe("undefined");
		expect(resolveFieldLockTtlMs()).toBe(FIELD_LOCK_TTL_MS);
		expect(resolveAsyncOpTtlMs()).toBe(ASYNC_OP_TTL_MS);
	});

	it("resolvers return the production default when the override is absent on window", () => {
		vi.stubGlobal("window", {});
		expect(resolveFieldLockTtlMs()).toBe(FIELD_LOCK_TTL_MS);
		expect(resolveAsyncOpTtlMs()).toBe(ASYNC_OP_TTL_MS);
	});

	it("a positive window override wins; clearing it reverts to the default", () => {
		vi.stubGlobal("window", {
			__ceraFieldLockTtlMs: 100,
			__ceraAsyncOpTtlMs: 250,
		});
		expect(resolveFieldLockTtlMs()).toBe(100);
		expect(resolveAsyncOpTtlMs()).toBe(250);

		vi.stubGlobal("window", {});
		expect(resolveFieldLockTtlMs()).toBe(FIELD_LOCK_TTL_MS);
		expect(resolveAsyncOpTtlMs()).toBe(ASYNC_OP_TTL_MS);
	});

	it("a non-positive or non-numeric override is ignored (falls back to default)", () => {
		for (const bad of [0, -5, Number.NaN, "100", null]) {
			vi.stubGlobal("window", {
				__ceraFieldLockTtlMs: bad,
				__ceraAsyncOpTtlMs: bad,
			});
			expect(resolveFieldLockTtlMs()).toBe(FIELD_LOCK_TTL_MS);
			expect(resolveAsyncOpTtlMs()).toBe(ASYNC_OP_TTL_MS);
		}
	});
});

describe("TTL test seams — the pure cores keep the production constant as default", () => {
	it("dirty-registry expire() uses FIELD_LOCK_TTL_MS when no ttl is passed", () => {
		const reg = registryCore.createRegistry();
		registryCore.markPending(reg, "max_br", 7, 0);
		// At exactly the TTL the lock survives (strict >); one ms past it expires.
		expect(registryCore.expire(reg, FIELD_LOCK_TTL_MS)).toEqual([]);
		expect(registryCore.expire(reg, FIELD_LOCK_TTL_MS + 1)).toEqual(["max_br"]);
	});

	it("dirty-registry expire() honors an explicit short ttl (the seam path)", () => {
		const reg = registryCore.createRegistry();
		registryCore.markPending(reg, "max_br", 7, 0);
		expect(registryCore.expire(reg, 200, 100)).toEqual(["max_br"]);
	});

	it("field-sync sweepSync() uses FIELD_LOCK_TTL_MS when no ttl is passed", () => {
		const reg = createSyncRegistry();
		syncCore.beginPending(reg, "max_br", 0);
		expect(syncCore.sweepSync(reg, FIELD_LOCK_TTL_MS)).toEqual([]);
		expect(syncCore.sweepSync(reg, FIELD_LOCK_TTL_MS + 1)).toEqual(["max_br"]);
	});

	it("field-sync sweepSync() honors an explicit short ttl (the seam path)", () => {
		const reg = createSyncRegistry();
		syncCore.beginPending(reg, "max_br", 0);
		expect(syncCore.sweepSync(reg, 200, 100)).toEqual(["max_br"]);
	});

	it("async-operation sweep() uses ASYNC_OP_TTL_MS when no ttl is passed", () => {
		const reg = asyncOpCore.createRegistry();
		asyncOpCore.begin(reg, "reboot", undefined, 0);
		expect(asyncOpCore.sweep(reg, ASYNC_OP_TTL_MS)).toEqual([]);
		expect(asyncOpCore.getPhase(reg, "reboot")).toBe("pending");
		expect(asyncOpCore.sweep(reg, ASYNC_OP_TTL_MS + 1)).toEqual(["reboot"]);
		expect(asyncOpCore.getPhase(reg, "reboot")).toBe("timed_out");
	});

	it("async-operation sweep() honors an explicit short ttl (the seam path)", () => {
		const reg = asyncOpCore.createRegistry();
		asyncOpCore.begin(reg, "reboot", undefined, 0);
		expect(asyncOpCore.sweep(reg, 200, 100)).toEqual(["reboot"]);
		expect(asyncOpCore.getPhase(reg, "reboot")).toBe("timed_out");
	});
});
