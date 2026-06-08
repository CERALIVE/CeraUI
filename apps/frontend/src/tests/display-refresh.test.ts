import { afterEach, describe, expect, it, vi } from "vitest";

import {
	getDisplayRefreshNonce,
	onDisplayRefresh,
	requestDisplayRefresh,
	resetDisplayRefresh,
} from "$lib/stores/display-refresh.svelte";

/**
 * Display-refresh hook (Task 12) — the single release path for the e-ink freeze.
 *
 * This pins the rune-free pub/sub core plus the reactive nonce: subscribe /
 * unsubscribe, fan-out to every listener, monotonic nonce, and the safety
 * guarantee that a listener mutating the subscriber set mid-fire cannot break
 * the iteration. The vitest env is `node`; the top-level `$state` nonce compiles
 * and is read through `getDisplayRefreshNonce`, the same pattern as the
 * display-profile store's `$persist` state.
 */

afterEach(() => {
	// Module-level subscriber set + nonce are shared across tests.
	resetDisplayRefresh();
});

describe("requestDisplayRefresh", () => {
	it("notifies a subscribed listener once per call", () => {
		const listener = vi.fn();
		onDisplayRefresh(listener);

		requestDisplayRefresh();
		requestDisplayRefresh();

		expect(listener).toHaveBeenCalledTimes(2);
	});

	it("fans out to every subscribed listener", () => {
		const a = vi.fn();
		const b = vi.fn();
		onDisplayRefresh(a);
		onDisplayRefresh(b);

		requestDisplayRefresh();

		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);
	});

	it("bumps the reactive nonce by exactly one per call", () => {
		const before = getDisplayRefreshNonce();
		requestDisplayRefresh();
		expect(getDisplayRefreshNonce()).toBe(before + 1);
		requestDisplayRefresh();
		expect(getDisplayRefreshNonce()).toBe(before + 2);
	});

	it("does not throw with no subscribers", () => {
		expect(() => requestDisplayRefresh()).not.toThrow();
	});
});

describe("onDisplayRefresh", () => {
	it("stops notifying after the returned unsubscribe runs", () => {
		const listener = vi.fn();
		const unsubscribe = onDisplayRefresh(listener);

		requestDisplayRefresh();
		unsubscribe();
		requestDisplayRefresh();

		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("lets a listener unsubscribe itself mid-fire without skipping others", () => {
		const order: string[] = [];
		const self = onDisplayRefresh(() => {
			order.push("self");
			self();
		});
		onDisplayRefresh(() => order.push("other"));

		requestDisplayRefresh();
		requestDisplayRefresh();

		// First fire reaches both; the self-unsubscribe only takes effect next time.
		expect(order).toEqual(["self", "other", "other"]);
	});
});

describe("resetDisplayRefresh", () => {
	it("clears subscribers and resets the nonce to zero", () => {
		const listener = vi.fn();
		onDisplayRefresh(listener);
		requestDisplayRefresh();

		resetDisplayRefresh();

		expect(getDisplayRefreshNonce()).toBe(0);
		requestDisplayRefresh();
		expect(listener).toHaveBeenCalledTimes(1);
	});
});
