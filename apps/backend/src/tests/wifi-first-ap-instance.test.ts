import { expect, spyOn, test } from "bun:test";
import * as retries from "../helpers/retry.ts";
import * as nm from "../modules/network/network-manager.ts";
import { wifiUpdateSavedConns } from "../modules/wifi/wifi.ts";
import { defaultHotspotDeps } from "../modules/wifi/wifi-hotspot-activation.ts";
import { handleHotspotConn } from "../modules/wifi/wifi-hotspot-discovery.ts";
import {
	recordHotspotProfileDeletion,
	trackHotspotProfileRead,
	wasHotspotConnDeletedSince,
} from "../modules/wifi/wifi-hotspot-discovery-fence.ts";
import {
	handleWifiMonitorEvent,
	syncWifiStateCache,
} from "../modules/wifi/wifi-hotspot-monitor.ts";
import * as interfaces from "../modules/wifi/wifi-interfaces.ts";
import { firstAp, MAC, OTHER_UUID } from "./helpers/wifi-first-ap-fixture.ts";

const productionPoll = defaultHotspotDeps.pollHotspotActive;
if (!productionPoll) throw new Error("Missing production confirmation probe");

test("replacement during the final NM roster await cannot confirm the original activation", async () => {
	const f = await firstAp();
	const outcomes: unknown[] = [];
	const backstop = Promise.withResolvers<never>();
	const retry = retries.retryWithBackoff;
	spyOn(retries, "retryWithBackoff").mockImplementation((operation, options) =>
		options.signal ? backstop.promise : retry(operation, options),
	);
	spyOn(interfaces, "wifiUpdateDevices").mockResolvedValue(false);
	f.deps.pollHotspotActive = productionPoll;
	f.deps.publishOutcome = (kind, device, outcome) =>
		outcomes.push([kind, device, outcome]);
	try {
		expect(await f.start()).toEqual({ success: true });
		const uuid = f.created();
		if (!uuid) throw new Error("Missing captured activation");
		spyOn(nm, "nmDevices").mockImplementation(async () => {
			f.replace(uuid);
			await wifiUpdateSavedConns();
			return [`wlan0:wifi:connected:${uuid}`];
		});
		await handleWifiMonitorEvent({
			type: "device-state",
			device: "wlan0",
			state: "connected",
		});
		expect(f.row.hotspot.name).toBe("Operator AP");
		expect(outcomes).toEqual([]);
		expect(f.row.hotspot.transition).toBe("activating");
	} finally {
		backstop.reject(new Error("Fixture backstop cancelled"));
		await f.restore();
	}
});

for (const change of [
	"recreated",
	"edited",
	"gone",
	"during-cleanup",
] as const) {
	test(`retained cleanup drops authority when its profile is ${change}`, async () => {
		const f = await firstAp();
		f.faults.upTimeout = true;
		f.faults.downFails = true;
		f.faults.deleteFails = true;
		f.faults.offFails = change === "during-cleanup";
		try {
			expect(await f.start()).toEqual({
				success: false,
				error: "activation-failed",
				reason: "cleanup-pending",
			});
			const uuid = f.created();
			if (!uuid) throw new Error("Missing created UUID");
			f.faults.upTimeout = f.faults.downFails = f.faults.deleteFails = false;
			f.faults.offFails = false;
			if (change === "gone") {
				f.profiles.delete(uuid);
				f.observe(undefined, "ap");
			} else if (change === "during-cleanup") {
				await f.armRetainedProfile();
				f.faults.afterModify = () => {
					f.faults.afterModify = () => undefined;
					f.replace(uuid);
				};
			} else {
				f.replace(uuid, "Operator AP", change === "recreated");
			}
			f.row.hotspot = { ...f.row.hotspot, conn: uuid };
			if (change === "recreated" || change === "edited")
				await wifiUpdateSavedConns();
			f.row.conn = f.row.activeConn = uuid;
			f.row.activeMode = "ap";
			syncWifiStateCache(MAC, f.row);
			const start = f.commands.length;
			await f.start();
			const mutations = f.commands
				.slice(start)
				.filter(
					(args) =>
						["modify", "down", "del"].includes(args[1] ?? "") &&
						args[2] === uuid,
				);
			expect(
				mutations.filter((args) => args[1] === "del" || args[1] === "down"),
			).toEqual([]);
			expect(
				mutations.filter(
					(args) =>
						args.includes("connection.autoconnect") && args.at(-1) === "no",
				),
			).toHaveLength(change === "during-cleanup" ? 1 : 0);
			if (
				change === "recreated" ||
				change === "edited" ||
				change === "during-cleanup"
			)
				expect(f.profiles.has(uuid)).toBe(true);
			// A stale active alias cannot acknowledge Start without an NM activation.
			expect(
				f.commands
					.slice(start)
					.some((args) => args.includes("up") || args[1] === "add"),
			).toBe(true);
			expect(f.profiles.has(OTHER_UUID)).toBe(true);
		} finally {
			await f.restore();
		}
	});
}

for (const replacement of [
	"before-discovery",
	"between-reads",
	"same-settings",
	"reactivated",
	"same-object-file",
] as const) {
	test(`UUID reuse ${replacement} cannot confirm the original Start`, async () => {
		const f = await firstAp();
		const outcomes: unknown[] = [];
		const backstop = Promise.withResolvers<never>();
		const retry = retries.retryWithBackoff;
		spyOn(retries, "retryWithBackoff").mockImplementation(
			(operation, options) =>
				options.signal ? backstop.promise : retry(operation, options),
		);
		spyOn(interfaces, "wifiUpdateDevices").mockImplementation(async () => {
			await wifiUpdateSavedConns();
			return false;
		});
		f.deps.publishOutcome = (kind, device, outcome) =>
			outcomes.push([kind, device, outcome]);
		f.deps.pollHotspotActive = productionPoll;
		try {
			expect(await f.start()).toEqual({ success: true });
			const uuid = f.created();
			if (!uuid) throw new Error("Missing created UUID");
			if (replacement === "between-reads") {
				f.faults.afterDeviceRead = () => {
					f.faults.afterDeviceRead = () => undefined;
					f.replace(uuid);
				};
			} else if (replacement === "same-object-file") {
				f.nm.files.write(uuid);
			} else
				f.replace(
					uuid,
					replacement === "same-settings" || replacement === "reactivated"
						? "First AP"
						: "Operator AP",
					replacement !== "reactivated",
				);
			f.observe(uuid, "ap");
			await handleWifiMonitorEvent({
				type: "device-state",
				device: "wlan0",
				state: "connected",
			});
			expect(outcomes).toEqual([]);
			expect(f.row.hotspot.transition).toBe("activating");
		} finally {
			backstop.reject(new Error("Fixture backstop cancelled"));
			await f.restore();
		}
	});
}

test("256 profile deletions leave no tombstones after their discovery reads retire", () => {
	const uuids = Array.from({ length: 256 }, (_, index) => `deleted-${index}`);
	for (const uuid of uuids) {
		using read = trackHotspotProfileRead();
		recordHotspotProfileDeletion(uuid);
		expect(wasHotspotConnDeletedSince(uuid, read.epoch)).toBe(true);
	}
	for (const uuid of uuids) {
		expect(wasHotspotConnDeletedSince(uuid, 0)).toBe(false);
	}
});

test("first-profile cleanup fences only the in-flight discovery continuation", async () => {
	const f = await firstAp();
	const writes = Map.prototype.set;
	const tombstones = new Set<Map<unknown, unknown>>();
	spyOn(Map.prototype, "set").mockImplementation(function <K, V>(
		this: Map<K, V>,
		key: K,
		value: V,
	) {
		if (
			typeof key === "string" &&
			typeof value === "number" &&
			key === f.created()
		)
			tombstones.add(this);
		return writes.call(this, key, value);
	});
	const size = () => [...tombstones].reduce((sum, map) => sum + map.size, 0);
	const fields = nm.nmConnGetFields;
	const paused = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let discovery: Promise<void> | undefined;
	f.faults.receiptUnreadable = true;
	try {
		expect((await f.start()).success).toBe(false);
		expect(size()).toBe(0);
		f.faults.afterAdd = async () => {
			const uuid = f.created();
			if (!uuid) throw new Error("Missing created UUID");
			spyOn(nm, "nmConnGetFields").mockImplementation(
				async (target, requested) => {
					const result = await fields(target, requested);
					if (
						target === uuid &&
						requested[0] === "connection.autoconnect-priority"
					) {
						paused.resolve();
						await release.promise;
					}
					return result;
				},
			);
			discovery = handleHotspotConn(MAC, uuid);
			await paused.promise;
		};
		expect((await f.start()).success).toBe(false);
		expect(size()).toBe(1);
		release.resolve();
		await discovery;
		expect(f.row.hotspot.conn).toBeUndefined();
		expect(size()).toBe(0);
	} finally {
		release.resolve();
		await discovery;
		await f.restore();
	}
});
