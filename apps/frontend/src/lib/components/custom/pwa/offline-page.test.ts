// @vitest-environment jsdom
/**
 * offline-page.svelte against the REAL connection-ux store.
 *
 * The full-page takeover also appears when the browser is online but the page
 * has never reached the device since it loaded, for example an installed app
 * opened while the device is off. It used to say "You're Offline · CeraUI needs
 * an internet connection" there too, which sends the operator after their own
 * network. These cases check the words for each cause:
 *
 *   · browser offline → the existing offline page, unchanged;
 *   · browser online, device never reached → "Can't reach the device", with
 *     checks for the device's power and network, nothing about the stream;
 *   · the wording follows the browser's own offline/online edges;
 *   · a failed manual retry repeats the cause instead of "Still Offline".
 */
import { m } from "@ceraui/i18n/svelte";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionState } from "$lib/rpc/client";

const manualConnectionCheck = vi.hoisted(() => vi.fn(async () => false));

vi.mock("$lib/rpc/client", () => ({
	rpcClient: {
		onConnectionChange: () => () => {},
		getConnectionState: (): ConnectionState => "connecting",
		connect: () => {},
	},
}));

vi.mock("$lib/stores/offline-state.svelte", () => ({ manualConnectionCheck }));

import * as connUx from "$lib/stores/connection-ux.svelte";

import OfflinePage from "./offline-page.svelte";

function mountWithRealStore(): void {
	// A fresh store per case, created outside the component as in the browser.
	connUx.destroyConnectionUxStore();
	connUx.getReconnectAttempts();
	render(OfflinePage);
}

function browser(event: "online" | "offline"): void {
	window.dispatchEvent(new Event(event));
	flushSync();
}

const text = (value: string) => screen.queryByText(value, { exact: false });
const offlineTitle = () => text(m["offline.title"]());
const internetCopy = () => text(m["offline.description"]());
const unreachableTitle = () => text(m["offline.unreachableTitle"]());

beforeEach(() => {
	manualConnectionCheck.mockReset();
	manualConnectionCheck.mockResolvedValue(false);
});

afterEach(() => {
	connUx.destroyConnectionUxStore();
});

describe("offline page wording", () => {
	it("names the device, not the browser, when the browser is online", () => {
		mountWithRealStore();

		expect(unreachableTitle()).not.toBeNull();
		expect(text(m["offline.unreachableDescription"]())).not.toBeNull();
		expect(text(m["offline.unreachableCheckPower"]())).not.toBeNull();
		expect(text(m["offline.unreachableCheckNetwork"]())).not.toBeNull();
		expect(offlineTitle()).toBeNull();
		expect(internetCopy()).toBeNull();
		expect(text(m["offline.checkWifi"]())).toBeNull();
	});

	it("keeps the existing offline page while the browser has no network", () => {
		mountWithRealStore();
		browser("offline");

		expect(offlineTitle()).not.toBeNull();
		expect(internetCopy()).not.toBeNull();
		expect(text(m["offline.checkWifi"]())).not.toBeNull();
		expect(text(m["offline.checkDevice"]())).not.toBeNull();
		expect(unreachableTitle()).toBeNull();
	});

	it("starts on the offline wording when the browser loads without network", () => {
		const onLine = vi.spyOn(window.navigator, "onLine", "get");
		onLine.mockReturnValue(false);
		try {
			mountWithRealStore();
		} finally {
			onLine.mockRestore();
		}

		expect(offlineTitle()).not.toBeNull();
		expect(unreachableTitle()).toBeNull();
	});

	it("re-words when the browser's network comes back before the device", () => {
		mountWithRealStore();
		browser("offline");
		expect(offlineTitle()).not.toBeNull();

		browser("online");

		expect(offlineTitle()).toBeNull();
		expect(unreachableTitle()).not.toBeNull();
	});

	it("repeats the device cause when a manual retry still fails", async () => {
		mountWithRealStore();

		await fireEvent.click(
			screen.getByRole("button", { name: m["offline.tryAgain"]() }),
		);
		await tick();

		expect(manualConnectionCheck).toHaveBeenCalledOnce();
		expect(
			screen.getByRole("button", {
				name: m["offline.unreachableCheckFailed"](),
			}),
		).not.toBeNull();
		expect(text(m["offline.checkFailed"]())).toBeNull();
	});

	it("keeps 'Still Offline' for a failed retry while the browser is offline", async () => {
		mountWithRealStore();
		browser("offline");

		await fireEvent.click(
			screen.getByRole("button", { name: m["offline.tryAgain"]() }),
		);
		await tick();

		expect(
			screen.getByRole("button", { name: m["offline.checkFailed"]() }),
		).not.toBeNull();
	});
});
