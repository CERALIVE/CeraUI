/*
 * Regression: an ACTIVE, connected saved network showed a "Connect" button
 * instead of "Disconnect" (confirmed on real hardware — SSID "SOMOS - 701").
 *
 * Root cause lived in wifiUpdateSavedConns: a saved infrastructure profile was
 * added to an interface's `saved` map ONLY when its `802-11-wireless.mac-address`
 * matched a currently-present adapter. A profile with no bound MAC (created
 * outside CeraUI — nmtui, `nmcli device wifi connect`, a baked image profile) or
 * a bound MAC that no longer matches the live adapter (MAC randomization / swapped
 * adapter) was silently dropped. The scan path (wifiUpdateScanResult) has no such
 * requirement, so the network still rendered `active: true` in `available` while
 * being absent from `saved` — the frontend `getWifiUUID` then resolved `undefined`
 * and the UI offered "Connect" on the already-connected network.
 *
 * `registerSavedWifiConnection` is the extracted keying step. The "unbound" case
 * below is the exact reproduction: before the fix the connection was NOT recorded
 * in `saved`, so the `toBe(UUID)` assertions would have failed (the value was
 * `undefined`).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as networkManager from "../modules/network/network-manager.ts";
import {
	registerSavedWifiConnection,
	wifiUpdateSavedConns,
} from "../modules/wifi/wifi.ts";
import {
	addWifiInterface,
	getWifiInterfacesByMacAddress,
	removeWifiInterface,
} from "../modules/wifi/wifi-connections.ts";
import * as hotspotDiscovery from "../modules/wifi/wifi-hotspot-discovery.ts";
import type { SSID, WifiInterface } from "../modules/wifi/wifi-interfaces.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

const SSID_NAME: SSID = "SOMOS - 701";
const UUID = "11112222-3333-4444-5555-666677778888";
const ADAPTER_A = "aa:bb:cc:dd:ee:01";
const ADAPTER_B = "aa:bb:cc:dd:ee:02";

function makeInterface(id: number, ifname: string): WifiInterface {
	return {
		id,
		ifname,
		conn: null,
		hw: "Test Adapter",
		available: new Map(),
		saved: {},
		savedAll: {},
	};
}

describe("registerSavedWifiConnection", () => {
	it("records an unbound profile (empty MAC) so an active network resolves a UUID", () => {
		const interfaces = { [ADAPTER_A]: makeInterface(0, "wlan0") };

		registerSavedWifiConnection(interfaces, "", SSID_NAME, UUID);

		// Pre-fix this profile was dropped (empty MAC matched no adapter) and the
		// value here was `undefined` — the "Connect"-on-connected-network bug.
		expect(interfaces[ADAPTER_A]?.saved[SSID_NAME]).toBe(UUID);
	});

	it("records a profile whose bound MAC matches no present adapter on every adapter", () => {
		const interfaces = {
			[ADAPTER_A]: makeInterface(0, "wlan0"),
			[ADAPTER_B]: makeInterface(1, "wlan1"),
		};

		// A stale/randomized bound MAC that matches neither present adapter.
		registerSavedWifiConnection(
			interfaces,
			"de:ad:be:ef:00:99",
			SSID_NAME,
			UUID,
		);

		expect(interfaces[ADAPTER_A]?.saved[SSID_NAME]).toBe(UUID);
		expect(interfaces[ADAPTER_B]?.saved[SSID_NAME]).toBe(UUID);
	});

	it("attributes a MAC-bound profile to only its adapter (multi-adapter disambiguation)", () => {
		const interfaces = {
			[ADAPTER_A]: makeInterface(0, "wlan0"),
			[ADAPTER_B]: makeInterface(1, "wlan1"),
		};

		registerSavedWifiConnection(interfaces, ADAPTER_B, SSID_NAME, UUID);

		expect(interfaces[ADAPTER_B]?.saved[SSID_NAME]).toBe(UUID);
		expect(interfaces[ADAPTER_A]?.saved[SSID_NAME]).toBeUndefined();
	});

	/*
	 * Duplicate-SSID precedence: two profiles for the SAME ssid — one precisely
	 * bound to a present adapter, one on the fallback path (unbound / stale MAC).
	 * The precise binding must win on its adapter regardless of nmcli enumeration
	 * order; the fallback only fills the adapters the precise profile does not own.
	 */
	const UUID_BOUND = "aaaaaaaa-1111-2222-3333-444444444444";
	const UUID_FALLBACK = "bbbbbbbb-5555-6666-7777-888888888888";

	it("keeps a precise MAC binding when a same-SSID fallback profile is registered after it", () => {
		const interfaces = {
			[ADAPTER_A]: makeInterface(0, "wlan0"),
			[ADAPTER_B]: makeInterface(1, "wlan1"),
		};

		registerSavedWifiConnection(interfaces, ADAPTER_A, SSID_NAME, UUID_BOUND);
		registerSavedWifiConnection(interfaces, "", SSID_NAME, UUID_FALLBACK);

		expect(interfaces[ADAPTER_A]?.saved[SSID_NAME]).toBe(UUID_BOUND);
		expect(interfaces[ADAPTER_B]?.saved[SSID_NAME]).toBe(UUID_FALLBACK);
	});

	it("lets a precise MAC binding override a same-SSID fallback profile registered before it", () => {
		const interfaces = {
			[ADAPTER_A]: makeInterface(0, "wlan0"),
			[ADAPTER_B]: makeInterface(1, "wlan1"),
		};

		registerSavedWifiConnection(interfaces, "", SSID_NAME, UUID_FALLBACK);
		registerSavedWifiConnection(interfaces, ADAPTER_A, SSID_NAME, UUID_BOUND);

		expect(interfaces[ADAPTER_A]?.saved[SSID_NAME]).toBe(UUID_BOUND);
		expect(interfaces[ADAPTER_B]?.saved[SSID_NAME]).toBe(UUID_FALLBACK);
	});
});

type ProfileFields = [string, string, string];
const REFRESH_OLD = "00000000-0000-4000-8000-000000000001";
const REFRESH_NEW = "00000000-0000-4000-8000-000000000002";
const REFRESH_BOUND = "00000000-0000-4000-8000-000000000003";
const REFRESH_DUPLICATE = "00000000-0000-4000-8000-000000000004";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function savedRefreshFixture() {
	const inherited = isolateWifiRegistry();
	const a = makeInterface(0, "wlan0");
	const b = makeInterface(1, "wlan1");
	for (const iface of [a, b]) {
		iface.saved = { "Previous network": REFRESH_OLD };
		iface.savedAll = { "Previous network": [REFRESH_OLD] };
	}
	addWifiInterface(ADAPTER_A, a);
	addWifiInterface(ADAPTER_B, b);
	const previousA = { saved: a.saved, savedAll: a.savedAll };
	const previousB = { saved: b.saved, savedAll: b.savedAll };
	const pending = new Map<
		string,
		ReturnType<typeof deferred<ProfileFields | undefined>>
	>();
	const requested = new Map<string, ReturnType<typeof deferred<void>>>();
	const profiles = new Map<string, ProfileFields | undefined>();
	const settle: Array<() => void> = [];
	const runs: Array<Promise<void>> = [];
	const list = spyOn(networkManager, "nmConnsGet").mockResolvedValue([]);
	const fields = spyOn(networkManager, "nmConnGetFields").mockImplementation(
		async <T extends ReadonlyArray<string>>(uuid: string, _fields: T) => {
			requested.get(uuid)?.resolve();
			const value = pending.has(uuid)
				? await pending.get(uuid)?.promise
				: profiles.get(uuid);
			return value as { [K in keyof T]: string } | undefined;
		},
	);
	const ap = spyOn(hotspotDiscovery, "handleHotspotConn").mockResolvedValue(
		undefined,
	);
	const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
		throw new Error("Unexpected native command in saved refresh fixture");
	});
	return {
		a,
		b,
		previousA,
		previousB,
		list,
		fields,
		profiles,
		ap,
		deferFields(uuid: string) {
			const answer = deferred<ProfileFields | undefined>();
			const started = deferred<void>();
			pending.set(uuid, answer);
			requested.set(uuid, started);
			settle.push(() => answer.resolve(undefined));
			return { resolve: answer.resolve, started: started.promise };
		},
		deferList() {
			const answer = deferred<string[] | undefined>();
			list.mockImplementationOnce(() => answer.promise);
			settle.push(() => answer.resolve(undefined));
			return answer;
		},
		run(signal?: AbortSignal) {
			const result = wifiUpdateSavedConns(signal);
			runs.push(result);
			return result;
		},
		async restore() {
			for (const finish of settle) finish();
			await Promise.allSettled(runs);
			try {
				expect(spawn).not.toHaveBeenCalled();
			} finally {
				fields.mockRestore();
				ap.mockRestore();
				list.mockRestore();
				spawn.mockRestore();
				restoreWifiRegistry(inherited);
			}
		},
	};
}

const wirelessRow = (uuid: string) => `${uuid}:802-11-wireless`;

describe("wifiUpdateSavedConns publication ownership", () => {
	let f: ReturnType<typeof savedRefreshFixture>;
	beforeEach(() => {
		f = savedRefreshFixture();
	});
	afterEach(async () => {
		await f.restore();
	});

	it("an aborted held listing starts no profile reads and preserves visible maps", async () => {
		const controller = new AbortController();
		const listing = f.deferList();
		const run = f.run(controller.signal);
		controller.abort();
		listing.resolve([wirelessRow(REFRESH_NEW)]);
		await run;
		await f.run(controller.signal);
		expect(f.list).toHaveBeenCalledTimes(1);
		expect(f.fields).not.toHaveBeenCalled();
		expect(f.a.saved).toBe(f.previousA.saved);
		expect(f.a.savedAll).toBe(f.previousA.savedAll);
	});

	it("an aborted held profile neither dispatches an AP nor reads the next profile", async () => {
		const controller = new AbortController();
		f.list.mockResolvedValue([
			wirelessRow(REFRESH_NEW),
			wirelessRow(REFRESH_BOUND),
		]);
		const delayed = f.deferFields(REFRESH_NEW);
		f.profiles.set(REFRESH_BOUND, ["infrastructure", "Later network", ""]);
		const run = f.run(controller.signal);
		await delayed.started;
		controller.abort();
		delayed.resolve(["ap", "Cancelled AP", ADAPTER_A]);
		await run;
		expect(f.ap).not.toHaveBeenCalled();
		expect(f.fields).not.toHaveBeenCalledWith(REFRESH_BOUND, [
			"802-11-wireless.mode",
			"802-11-wireless.ssid",
			"802-11-wireless.mac-address",
		]);
		expect(f.a.saved).toBe(f.previousA.saved);
		expect(f.a.savedAll).toBe(f.previousA.savedAll);
	});

	it("retains both visible maps while profile fields are pending, then publishes the complete pair", async () => {
		f.list.mockResolvedValue([
			wirelessRow(REFRESH_NEW),
			wirelessRow(REFRESH_BOUND),
		]);
		f.profiles.set(REFRESH_NEW, ["infrastructure", "Fresh first", ""]);
		const delayed = f.deferFields(REFRESH_BOUND);
		const run = f.run();
		await delayed.started;
		expect(f.a.saved).toBe(f.previousA.saved);
		expect(f.a.savedAll).toBe(f.previousA.savedAll);
		expect(f.b.saved).toBe(f.previousB.saved);
		expect(f.b.savedAll).toBe(f.previousB.savedAll);
		delayed.resolve(["infrastructure", "Fresh second", ""]);
		await run;
		expect(f.a.saved).toEqual({
			"Fresh first": REFRESH_NEW,
			"Fresh second": REFRESH_BOUND,
		});
		expect(f.a.savedAll).toEqual({
			"Fresh first": [REFRESH_NEW],
			"Fresh second": [REFRESH_BOUND],
		});
		expect(f.fields).toHaveBeenCalledWith(REFRESH_BOUND, [
			"802-11-wireless.mode",
			"802-11-wireless.ssid",
			"802-11-wireless.mac-address",
		]);
	});

	it("withholds an older field reply after a newer refresh publishes", async () => {
		f.list
			.mockResolvedValueOnce([wirelessRow(REFRESH_OLD)])
			.mockResolvedValueOnce([wirelessRow(REFRESH_NEW)]);
		const oldFields = f.deferFields(REFRESH_OLD);
		f.profiles.set(REFRESH_NEW, ["infrastructure", "Current network", ""]);
		const older = f.run();
		await oldFields.started;
		await f.run();
		const published = { saved: f.a.saved, savedAll: f.a.savedAll };
		expect(published.saved).toEqual({ "Current network": REFRESH_NEW });
		oldFields.resolve(["infrastructure", "Retired network", ""]);
		await older;
		expect(f.a.saved).toBe(published.saved);
		expect(f.a.savedAll).toBe(published.savedAll);
		expect(f.a.saved).toEqual({ "Current network": REFRESH_NEW });
		expect(f.a.savedAll).toEqual({ "Current network": [REFRESH_NEW] });
	});

	it("captures ownership at entry even when an older list resolves after the latest publication", async () => {
		const oldList = f.deferList();
		f.profiles.set(REFRESH_OLD, ["infrastructure", "Retired network", ""]);
		const older = f.run();
		f.list.mockResolvedValue([wirelessRow(REFRESH_NEW)]);
		f.profiles.set(REFRESH_NEW, ["infrastructure", "Current network", ""]);
		await f.run();
		oldList.resolve([wirelessRow(REFRESH_OLD)]);
		await older;
		expect(f.a.saved).toEqual({ "Current network": REFRESH_NEW });
		expect(f.a.savedAll).toEqual({ "Current network": [REFRESH_NEW] });
	});

	it.each(["removed", "replaced", "added"] as const)(
		"withholds publication when the interface roster is %s during a field read",
		async (change) => {
			f.list.mockResolvedValue([wirelessRow(REFRESH_NEW)]);
			const delayed = f.deferFields(REFRESH_NEW);
			const run = f.run();
			await delayed.started;
			const replacement = makeInterface(0, "wlan2");
			replacement.saved = { "Replacement network": REFRESH_BOUND };
			replacement.savedAll = { "Replacement network": [REFRESH_BOUND] };
			if (change === "added")
				addWifiInterface("02:00:00:00:00:03", replacement);
			else {
				removeWifiInterface(ADAPTER_A);
				if (change === "replaced") addWifiInterface(ADAPTER_A, replacement);
			}
			delayed.resolve(["infrastructure", "Stale result", ""]);
			await run;
			expect(f.a.saved).toBe(f.previousA.saved);
			expect(f.a.savedAll).toBe(f.previousA.savedAll);
			expect(f.b.saved).toBe(f.previousB.saved);
			expect(f.b.savedAll).toBe(f.previousB.savedAll);
			expect(replacement.saved).toEqual({
				"Replacement network": REFRESH_BOUND,
			});
			expect(replacement.savedAll).toEqual({
				"Replacement network": [REFRESH_BOUND],
			});
		},
	);

	it("does not adopt a replacement interface while the original list is pending", async () => {
		const list = f.deferList();
		const run = f.run();
		const replacement = makeInterface(0, "wlan2");
		replacement.saved = { "Replacement network": REFRESH_BOUND };
		replacement.savedAll = { "Replacement network": [REFRESH_BOUND] };
		removeWifiInterface(ADAPTER_A);
		addWifiInterface(ADAPTER_A, replacement);
		f.profiles.set(REFRESH_NEW, ["infrastructure", "Stale result", ""]);
		list.resolve([wirelessRow(REFRESH_NEW)]);
		await run;
		expect(getWifiInterfacesByMacAddress()[ADAPTER_A]).toBe(replacement);
		expect(replacement.saved).toEqual({ "Replacement network": REFRESH_BOUND });
		expect(replacement.savedAll).toEqual({
			"Replacement network": [REFRESH_BOUND],
		});
	});

	it("retains the previous pair after the existing list retries are exhausted", async () => {
		f.list.mockResolvedValue(undefined);
		await f.run();
		expect(f.list).toHaveBeenCalledTimes(3);
		expect(f.a.saved).toBe(f.previousA.saved);
		expect(f.a.savedAll).toBe(f.previousA.savedAll);
		expect(f.fields).not.toHaveBeenCalled();
	});

	it("a failed newer list still withholds the older pending field result", async () => {
		f.list
			.mockResolvedValueOnce([wirelessRow(REFRESH_NEW)])
			.mockResolvedValue(undefined);
		const delayed = f.deferFields(REFRESH_NEW);
		const older = f.run();
		await delayed.started;
		await f.run();
		delayed.resolve(["infrastructure", "Stale result", ""]);
		await older;
		expect(f.a.saved).toBe(f.previousA.saved);
		expect(f.a.savedAll).toBe(f.previousA.savedAll);
	});

	it.each([{ rows: [] }, { rows: [""] }])(
		"preserves the existing confirmed empty-list policy for %p",
		async ({ rows }) => {
			f.list.mockResolvedValue([...rows]);
			await f.run();
			expect(f.a.saved).toEqual({});
			expect(f.a.savedAll).toEqual({});
			expect(f.list).toHaveBeenCalledTimes(1);
		},
	);

	it.each([true, false])(
		"preserves MAC precedence and duplicate SSIDs with bound-first=%p",
		async (boundFirst) => {
			const ids = boundFirst
				? [REFRESH_BOUND, REFRESH_NEW, REFRESH_DUPLICATE]
				: [REFRESH_NEW, REFRESH_DUPLICATE, REFRESH_BOUND];
			f.list.mockResolvedValue(ids.map(wirelessRow));
			f.profiles.set(REFRESH_BOUND, [
				"infrastructure",
				"Shared synthetic network",
				ADAPTER_A.toUpperCase(),
			]);
			f.profiles.set(REFRESH_NEW, [
				"infrastructure",
				"Shared synthetic network",
				"",
			]);
			f.profiles.set(REFRESH_DUPLICATE, [
				"infrastructure",
				"Shared synthetic network",
				"",
			]);
			await f.run();
			expect(f.a.saved).toEqual({ "Shared synthetic network": REFRESH_BOUND });
			expect(f.b.saved).toEqual({ "Shared synthetic network": REFRESH_NEW });
			expect(f.a.savedAll).toEqual({ "Shared synthetic network": ids });
			expect(f.b.savedAll).toEqual({
				"Shared synthetic network": [REFRESH_NEW, REFRESH_DUPLICATE],
			});
		},
	);

	it("reads unsupported and missing-field rows without publishing an incomplete snapshot", async () => {
		f.list.mockResolvedValue([
			"synthetic-ethernet:802-3-ethernet",
			wirelessRow(REFRESH_OLD),
			wirelessRow(REFRESH_NEW),
			wirelessRow(REFRESH_BOUND),
		]);
		f.profiles.set(REFRESH_OLD, undefined);
		f.profiles.set(REFRESH_NEW, ["adhoc", "Unsupported synthetic network", ""]);
		f.profiles.set(REFRESH_BOUND, [
			"infrastructure",
			"Valid synthetic network",
			"",
		]);
		await f.run();
		expect(f.a.saved).toBe(f.previousA.saved);
		expect(f.a.savedAll).toBe(f.previousA.savedAll);
		expect(f.b.saved).toBe(f.previousB.saved);
		expect(f.b.savedAll).toBe(f.previousB.savedAll);
		expect(f.fields).toHaveBeenCalledTimes(3);
	});

	it("preserves current AP dispatch when roster drift withholds station publication", async () => {
		f.list.mockResolvedValue([wirelessRow(REFRESH_NEW)]);
		const delayed = f.deferFields(REFRESH_NEW);
		const run = f.run();
		await delayed.started;
		addWifiInterface("02:00:00:00:00:03", makeInterface(2, "wlan2"));
		delayed.resolve(["ap", "Synthetic AP", ADAPTER_A]);
		await run;
		expect(f.ap).toHaveBeenCalledTimes(1);
		expect(f.ap).toHaveBeenCalledWith(ADAPTER_A, REFRESH_NEW);
		expect(f.a.saved).toBe(f.previousA.saved);
		expect(f.a.savedAll).toBe(f.previousA.savedAll);
	});

	it("withholds AP dispatch from an already superseded refresh", async () => {
		f.list
			.mockResolvedValueOnce([wirelessRow(REFRESH_OLD)])
			.mockResolvedValue([]);
		const delayed = f.deferFields(REFRESH_OLD);
		const older = f.run();
		await delayed.started;
		await f.run();
		delayed.resolve(["ap", "Retired synthetic AP", ADAPTER_A]);
		await older;
		expect(f.ap).not.toHaveBeenCalled();
		expect(f.a.saved).toEqual({});
		expect(f.a.savedAll).toEqual({});
	});
});
