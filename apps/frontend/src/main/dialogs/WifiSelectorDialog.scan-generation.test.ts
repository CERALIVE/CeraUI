// @vitest-environment jsdom
/**
 * WifiSelectorDialog — a scan is confirmed by the DEVICE's own per-adapter scan
 * generation, never by guessing at the content of the network list.
 *
 * The retired rule fingerprinted `available` and waited for the fingerprint to
 * change. That cannot answer "did my scan finish": a scan that legitimately
 * finds the same access points, or finds none at all, leaves the content
 * byte-identical — so an honest empty result was indistinguishable from a scan
 * that never ran, and could only die on its TTL.
 *
 * It was also shared evidence across TWO keyed ops (`wifi-scan:` for the manual
 * tap, `wifi-scan-auto:` for the 22 s background poll), so whichever broadcast
 * landed first resolved BOTH — a background tick could clear the operator's
 * manual spinner without their scan having finished. The two are now ONE keyed
 * op per adapter, distinguished only by intent, so there is nothing left to
 * cross-confirm.
 */

import { fireEvent, render, screen } from "@testing-library/svelte";
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
	clearOperation,
	getOperationPhase,
} from "$lib/rpc/async-operation.svelte";

import {
	getWifiFeed,
	publishWifi,
	resetWifiFeed,
} from "../../tests/helpers/wifi-feed.svelte";
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

vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const feed = await import("../../tests/helpers/wifi-feed.svelte");
	return { getWifi: () => feed.getWifiFeed() };
});

const MANUAL_KEY = "wifi-scan:0";
/** The key the retired background op used. Nothing may ever begin it again. */
const RETIRED_AUTO_KEY = "wifi-scan-auto:0";

function radio(scanGeneration?: number, ssids: string[] = []) {
	return {
		ifname: "wlan0",
		conn: "",
		hw: "aa:bb:cc:dd:ee:01",
		saved: {},
		available: ssids.map((ssid) => ({
			active: false,
			ssid,
			signal: 70,
			security: "WPA2",
			freq: 2437,
		})),
		...(scanGeneration === undefined
			? {}
			: { scanGeneration, scanAt: 1_700_000_000_000 }),
	};
}

/** Let every queued microtask AND every Svelte effect flush. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
		vi.advanceTimersByTime(0);
	}
}

function manualSpinnerShown(): boolean {
	return screen.queryByTestId("wifi-scan-status") !== null;
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
	resetWifiFeed();
	publishWifi({ "0": radio(), "1": radio() });
	clearOperation(MANUAL_KEY);
	clearOperation(RETIRED_AUTO_KEY);
});

afterEach(() => {
	clearOperation(MANUAL_KEY);
	clearOperation(RETIRED_AUTO_KEY);
	vi.useRealTimers();
});

/** Open the dialog and let its automatic first scan settle to `confirmed`. */
async function openAndSettleFirstScan(): Promise<void> {
	render(WifiSelectorDialog, { props: { open: true, deviceId: "0" } });
	await settle();
	publishWifi({ ...getWifiFeed(), "0": radio(1) });
	await settle();
}

describe("WifiSelectorDialog — generation-confirmed scans", () => {
	it("confirms a manual scan ONLY when its own adapter's generation advances", async () => {
		// Given: an open dialog whose first (background) scan has settled, and an
		// operator-initiated scan in flight.
		await openAndSettleFirstScan();
		await fireEvent.click(screen.getByTestId("wifi-scan-button"));
		await settle();
		expect(manualSpinnerShown()).toBe(true);
		expect(getOperationPhase(MANUAL_KEY)).toBe("pending");

		// When: the OTHER radio completes a scan.
		publishWifi({ ...getWifiFeed(), "1": radio(9) });
		await settle();

		// Then: nothing is confirmed — a scan of wlan1 is not an answer about
		// wlan0, and the feed genuinely changed, so this is not a vacuous pass.
		expect(getWifiFeed()["1"]?.scanGeneration).toBe(9);
		expect(manualSpinnerShown()).toBe(true);
		expect(getOperationPhase(MANUAL_KEY)).toBe("pending");

		// When: THIS radio completes its scan.
		publishWifi({ ...getWifiFeed(), "0": radio(2) });
		await settle();

		// Then: the operator's scan resolves.
		expect(manualSpinnerShown()).toBe(false);
		expect(getOperationPhase(MANUAL_KEY)).toBe("confirmed");
	});

	it("confirms an EMPTY scan, so an honest empty list is not a stuck spinner", async () => {
		// Given: an adapter whose settled scan found two networks.
		render(WifiSelectorDialog, { props: { open: true, deviceId: "0" } });
		await settle();
		publishWifi({ "0": radio(1, ["alpha", "beta"]), "1": radio() });
		await settle();

		// When: the operator rescans and the device completes a cycle that finds
		// NOTHING — the content signature the retired rule watched would be the
		// only thing left, and it would have to guess.
		await fireEvent.click(screen.getByTestId("wifi-scan-button"));
		await settle();
		expect(manualSpinnerShown()).toBe(true);

		publishWifi({ ...getWifiFeed(), "0": radio(2, []) });
		await settle();

		// Then: the scan is confirmed and the stale list is REPLACED by the honest
		// settled-empty state — not a scan still in progress, not an error, and not
		// the two networks the previous scan found.
		expect(getOperationPhase(MANUAL_KEY)).toBe("confirmed");
		expect(manualSpinnerShown()).toBe(false);
		expect(screen.queryByTestId("wifi-empty-state")).not.toBeNull();
		expect(screen.queryByTestId("wifi-scanning-state")).toBeNull();
		expect(screen.queryByTestId("wifi-scan-error")).toBeNull();
		expect(screen.queryByText("alpha")).toBeNull();
		expect(screen.queryByText("beta")).toBeNull();
	});

	it("re-confirms an unchanged network list, because the generation still moved", async () => {
		// Given: a settled adapter showing one network.
		render(WifiSelectorDialog, { props: { open: true, deviceId: "0" } });
		await settle();
		publishWifi({ "0": radio(1, ["alpha"]), "1": radio() });
		await settle();

		// When: a rescan finds exactly the same network.
		await fireEvent.click(screen.getByTestId("wifi-scan-button"));
		await settle();
		publishWifi({ ...getWifiFeed(), "0": radio(2, ["alpha"]) });
		await settle();

		// Then: confirmed. The retired content fingerprint could not have known.
		expect(getOperationPhase(MANUAL_KEY)).toBe("confirmed");
		expect(manualSpinnerShown()).toBe(false);
	});

	it("never confirms on the RPC resolving — the reply only says nmcli was dispatched", async () => {
		// Given/When: an open dialog whose background scan RPC has resolved.
		render(WifiSelectorDialog, { props: { open: true, deviceId: "0" } });
		await settle();

		// Then: the op is still in flight. A resolved reply is not a finished scan,
		// so it cannot clear anything an operator is waiting on.
		expect(scan).toHaveBeenCalledTimes(1);
		expect(getOperationPhase(MANUAL_KEY)).toBe("pending");
	});

	it("runs the background poll on the SAME op as the manual tap", async () => {
		// Given/When: the dialog opens and issues its background scan.
		render(WifiSelectorDialog, { props: { open: true, deviceId: "0" } });
		await settle();

		// Then: it took the ONE scan key, and the retired second key — the shared
		// evidence that made cross-confirmation possible — is never begun.
		expect(getOperationPhase(MANUAL_KEY)).toBe("pending");
		expect(getOperationPhase(RETIRED_AUTO_KEY)).toBe("idle");
	});

	it("keeps the background poll out of the operator's spinner", async () => {
		// Given: an open dialog whose background scan is in flight.
		render(WifiSelectorDialog, { props: { open: true, deviceId: "0" } });
		await settle();
		expect(getOperationPhase(MANUAL_KEY)).toBe("pending");

		// Then: no spinner — a background refresh never claims the operator's
		// attention, even though it holds the same op.
		expect(manualSpinnerShown()).toBe(false);

		// When: the operator taps Scan while that poll is still in flight.
		await fireEvent.click(screen.getByTestId("wifi-scan-button"));
		await settle();

		// Then: their request PROMOTES the in-flight run rather than spawning a
		// second one — one RPC, and the spinner is now theirs.
		expect(scan).toHaveBeenCalledTimes(1);
		expect(manualSpinnerShown()).toBe(true);
	});

	it("does not confirm when the device reports no generation at all", async () => {
		// Given: a backend that predates the field, so every frame omits it.
		render(WifiSelectorDialog, { props: { open: true, deviceId: "0" } });
		await settle();

		// When: the list changes without any generation being reported.
		publishWifi({ "0": radio(undefined, ["alpha"]), "1": radio() });
		await settle();

		// Then: nothing is claimed. The op rides its TTL to `timed_out`, which the
		// list renders neutrally as "scan complete" — the pre-field behaviour.
		expect(getOperationPhase(MANUAL_KEY)).toBe("pending");
	});
});
