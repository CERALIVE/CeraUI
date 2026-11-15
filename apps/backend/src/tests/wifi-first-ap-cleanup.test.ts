import { expect, spyOn, test } from "bun:test";
import * as config from "../modules/config.ts";
import {
	getBootReadiness,
	resetBootReadiness,
} from "../modules/system/readiness.ts";
import { getPendingHotspotCreation } from "../modules/wifi/hotspot-credentials.ts";
import { getWifiState } from "../modules/wifi/state/wifi-state.ts";
import { cancelWifiAdapterReconciliation } from "../modules/wifi/wifi-adapter-reconcile-retry.ts";
import { wifiHotspotStop } from "../modules/wifi/wifi-hotspot-config.ts";
import { syncWifiStateCache } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { canHotspot } from "../modules/wifi/wifi-hotspot-types.ts";
import { firstAp, MAC, OTHER_UUID } from "./helpers/wifi-first-ap-fixture.ts";

test("repeated Stop preserves a confirmed disconnection while deletion is pending", async () => {
	const f = await firstAp();
	const modes = config.getConfig().wifi_modes;
	config.getConfig().wifi_modes = { [MAC]: "hotspot" };
	spyOn(config, "saveConfig").mockImplementation(() => undefined);
	f.faults.upTimeout = f.faults.downFails = f.faults.deleteFails = true;
	try {
		expect((await f.start()).success).toBe(false);
		f.faults.downFails = false;
		expect(await wifiHotspotStop({ device: 0 })).toEqual({ success: true });
		expect(f.active()).toBeUndefined();
		const downs = f.commands.filter((args) => args[1] === "down").length;
		expect(await wifiHotspotStop({ device: 0 })).toEqual({ success: true });
		expect(f.commands.filter((args) => args[1] === "down")).toHaveLength(downs);
		expect(config.getConfig().wifi_modes).toEqual({ [MAC]: "station" });
	} finally {
		cancelWifiAdapterReconciliation();
		config.getConfig().wifi_modes = modes;
		await f.restore();
	}
});

test("a lost down reply is resolved by NM activation state while deletion remains pending", async () => {
	const f = await firstAp();
	const modes = config.getConfig().wifi_modes;
	spyOn(config, "saveConfig").mockImplementation(() => undefined);
	f.faults.upTimeout = f.faults.downTimeout = f.faults.deleteFails = true;
	try {
		expect((await f.start()).success).toBe(false);
		expect(f.active()).toBeUndefined();
		expect(await wifiHotspotStop({ device: 0 })).toEqual({ success: true });
		expect(f.commands.filter((args) => args[1] === "down")).toHaveLength(1);
		expect(f.commands.some((args) => args.includes("uuid,active"))).toBe(true);
	} finally {
		cancelWifiAdapterReconciliation();
		config.getConfig().wifi_modes = modes;
		await f.restore();
	}
});

for (const trace of [
	"up-timeout",
	"autoconnect-timeout",
	"unreadable-add",
] as const) {
	test(
		trace === "autoconnect-timeout"
			? "a committed autoconnect failure retires authority and preserves its profile"
			: `failed ${trace} cleanup retains its UUID and suppresses autoconnect until retry`,
		async () => {
			const f = await firstAp();
			f.faults.deleteFails = true;
			f.faults.downFails = trace === "up-timeout";
			f.faults.upTimeout = trace === "up-timeout";
			f.faults.autoconnectTimeout = trace === "autoconnect-timeout";
			f.faults.receiptUnreadable = trace === "unreadable-add";
			try {
				expect((await f.start()).success).toBe(false);
				const uuid = f.created();
				if (!uuid) throw new Error("Missing generated UUID");
				expect(f.profiles.has(uuid)).toBe(true);
				expect(f.row.hotspot.conn).toBe(uuid);
				expect(f.autoconnect.has(uuid)).toBe(false);
				if (trace === "autoconnect-timeout") {
					expect(f.active()).toBe(uuid);
					expect(getPendingHotspotCreation(MAC)).toBeUndefined();
					expect(getBootReadiness().degradedSubsystems).toContain(
						`wifi-hotspot-authority:${MAC}`,
					);
					const failedWrite = f.commands.findIndex(
						(args) =>
							args[1] === "modify" &&
							args[2] === uuid &&
							args.includes("connection.autoconnect-priority"),
					);
					expect(failedWrite === -1).toBe(false);
					expect(
						f.commands
							.slice(failedWrite + 1)
							.filter(
								(args) =>
									args.includes(uuid) &&
									args.some((arg) =>
										["modify", "down", "del", "up"].includes(arg),
									),
							),
					).toEqual([]);
					expect(f.profiles.has(OTHER_UUID)).toBe(true);
				} else {
					const cached = getWifiState()[MAC];
					expect(
						cached && canHotspot(cached) ? cached.hotspot.conn : undefined,
					).toBe(uuid);
					expect(f.active()).toBe(trace === "up-timeout" ? uuid : undefined);
					expect(
						f.logs.some(
							(line) => line.includes(uuid) && line.includes("cleanup"),
						),
					).toBe(true);
					expect(
						f.commands.filter(
							(args) =>
								args[1] === "modify" &&
								args[2] === uuid &&
								args.includes("connection.autoconnect") &&
								args.at(-1) === "no",
						),
					).toHaveLength(0);
					f.faults.deleteFails = false;
					f.faults.downFails = false;
					f.faults.upTimeout = false;
					f.faults.autoconnectTimeout = false;
					f.faults.receiptUnreadable = false;
					expect(await f.start()).toEqual({ success: true });
					expect(f.profiles.has(uuid)).toBe(false);
					expect(f.active()).not.toBe(uuid);
					expect(f.row.hotspot.conn).not.toBe(uuid);
					expect(f.commands.filter((args) => args[1] === "add")).toHaveLength(
						2,
					);
					expect(f.profiles.has(OTHER_UUID)).toBe(true);
					expect(
						f.commands
							.filter((args) => args[1] === "del")
							.every((args) => args[2] === uuid),
					).toBe(true);
				}
			} finally {
				await f.restore();
				resetBootReadiness();
			}
		},
	);
}

test("failed autoconnect suppression is recorded and retried without losing the target", async () => {
	const f = await firstAp();
	f.faults.upTimeout = true;
	f.faults.downFails = true;
	f.faults.deleteFails = true;
	f.faults.offFails = true;
	try {
		expect((await f.start()).success).toBe(false);
		const uuid = f.created();
		expect(f.row.hotspot.conn).toBe(uuid);
		expect(
			f.logs.some(
				(line) =>
					line.includes("autoconnectDisabled") && line.includes("false"),
			),
		).toBe(true);
		f.faults.upTimeout = false;
		f.faults.downFails = false;
		f.faults.deleteFails = false;
		f.faults.offFails = false;
		expect(await f.start()).toEqual({ success: true });
		expect(f.profiles.has(uuid ?? "")).toBe(false);
	} finally {
		await f.restore();
	}
});

test("a committed delete timeout is confirmed through an authoritative UUID list", async () => {
	const f = await firstAp();
	try {
		expect(await f.start()).toEqual({ success: true });
		const uuid = f.created();
		if (!uuid) throw new Error("Missing generated UUID");
		f.faults.deleteTimeout = true;
		expect(await f.deps.nmConnDelete(uuid)).toBe(true);
		expect(f.profiles.has(uuid)).toBe(false);
		expect(f.profiles.has(OTHER_UUID)).toBe(true);
	} finally {
		await f.restore();
	}
});

test("a failed fresh add cannot restore an already deleted active UUID from cache", async () => {
	const f = await firstAp();
	f.faults.upTimeout = true;
	f.faults.downFails = true;
	f.faults.deleteFails = true;
	try {
		expect((await f.start()).success).toBe(false);
		const uuid = f.created();
		if (!uuid) throw new Error("Missing generated UUID");
		f.row.conn = uuid;
		f.row.activeConn = uuid;
		f.row.activeMode = "ap";
		syncWifiStateCache(MAC, f.row);
		f.faults.upTimeout = false;
		f.faults.downFails = false;
		f.faults.deleteFails = false;
		f.faults.receiptUnreadable = true;
		expect((await f.start()).success).toBe(false);
		expect(f.profiles.has(uuid)).toBe(false);
		expect(getWifiState()[MAC]?.conn).not.toBe(uuid);
		expect(getWifiState()[MAC]?.activeConn).not.toBe(uuid);
	} finally {
		await f.restore();
	}
});
