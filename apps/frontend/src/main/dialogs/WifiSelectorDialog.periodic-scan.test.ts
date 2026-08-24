// @vitest-environment jsdom
/**
 * WifiSelectorDialog — the open dialog's periodic silent rescan must tick on its
 * INTERVAL, never on its own RPC round-trip.
 *
 * `osCommand` reads the async-operation store (its `isOperationPending`
 * re-entry guard) and then writes it (`beginOperation`), both before its first
 * `await` — i.e. synchronously inside whatever reactive scope called it. Called
 * bare from an `$effect` body, that made the effect a SUBSCRIBER of the very
 * operation it dispatches: `confirmOnResolve` flipped `pending → confirmed` the
 * instant the RPC resolved, the effect re-ran, the now-not-pending guard let a
 * NEW scan through, and its `begin` re-dirtied the effect. The 22 s interval was
 * never the cadence; the network round-trip was.
 *
 * Board-measured on a Rock 5B+ (2026-08-19): with this dialog CLOSED the device
 * ran ONE nmcli and held 31 system-bus names; five seconds after OPENING it,
 * 250-330 concurrent `nmcli device wifi rescan` processes were live and root's
 * D-Bus `max_connections_per_user=256` limit was exhausted — so every nmcli on
 * the box, including the backend's own `conn down` / `conn del`, failed with
 * `Could not create NMClient object`. That is the operator-reported "forgetting
 * a network or disconnecting from a network is not working": the storm runs
 * exactly while the dialog they use for both is open.
 */

import { render } from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import {
	destroyAsyncOperations,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";

import WifiSelectorDialog from "./WifiSelectorDialog.svelte";

const scan = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc", () => ({
	rpc: {
		wifi: {
			scan,
			connect: vi.fn(),
			connectNew: vi.fn(),
			disconnect: vi.fn(),
			forget: vi.fn(),
		},
	},
}));

const wifiFeed = vi.hoisted(() => ({
	value: {
		"0": {
			ifname: "wlan0",
			conn: "",
			hw: "test radio",
			saved: {},
			available: [],
		},
	} as Record<string, unknown>,
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getWifi: () => wifiFeed.value,
}));

/** Let every queued microtask AND every Svelte effect flush. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
		vi.advanceTimersByTime(0);
	}
}

// AppDialog picks Dialog vs Sheet via `new MediaQuery(...)` → window.matchMedia,
// absent in jsdom. Stub it to the desktop (Dialog) branch.
beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
});

beforeEach(() => {
	vi.useFakeTimers();
	scan.mockReset();
	scan.mockResolvedValue({ success: true });
	// The scan op is a module singleton shared by every test here, and it no
	// longer self-confirms when the RPC resolves — a resolved reply says only that
	// nmcli was dispatched, so confirmation waits for the device's own scan
	// generation, which this file's feed never reports. Warm a FRESH store per
	// test (the documented lifecycle) so the TTL valve that releases an
	// unconfirmed poll is genuinely running, and no test inherits the previous
	// one's pending op.
	initAsyncOperations();
});

afterEach(() => {
	destroyAsyncOperations();
	vi.useRealTimers();
});

describe("WifiSelectorDialog — periodic silent rescan", () => {
	it("dispatches ONE scan on open, not one per RPC round-trip", async () => {
		// Given/When: the dialog is opened and its first scan resolves.
		render(WifiSelectorDialog, { props: { open: true, deviceId: "0" } });
		await settle();

		// Then: the resolution did not re-arm the effect into another dispatch.
		expect(scan).toHaveBeenCalledTimes(1);
	});

	it("stays at ONE scan across many resolved round-trips", async () => {
		// Given: an open dialog whose scan RPC keeps resolving.
		render(WifiSelectorDialog, { props: { open: true, deviceId: "0" } });

		// When: far more settle passes elapse than the interval has ticks for.
		for (let i = 0; i < 10; i++) await settle();

		// Then: still one — the cadence is the interval, not the round-trip.
		expect(scan).toHaveBeenCalledTimes(1);
	});

	it("still ticks on the 22 s interval", async () => {
		// Given: an open dialog that has issued its initial scan.
		render(WifiSelectorDialog, { props: { open: true, deviceId: "0" } });
		await settle();
		expect(scan).toHaveBeenCalledTimes(1);

		// When: two interval periods pass.
		vi.advanceTimersByTime(22_000);
		await settle();
		vi.advanceTimersByTime(22_000);
		await settle();

		// Then: the periodic refresh is intact — untracking silenced the loop, not
		// the feature.
		expect(scan).toHaveBeenCalledTimes(3);
	});

	it("dispatches nothing while closed", async () => {
		// Given/When: the dialog is mounted closed.
		render(WifiSelectorDialog, { props: { open: false, deviceId: "0" } });
		await settle();
		vi.advanceTimersByTime(60_000);
		await settle();

		// Then: a closed dialog costs the device nothing.
		expect(scan).not.toHaveBeenCalled();
	});
});
