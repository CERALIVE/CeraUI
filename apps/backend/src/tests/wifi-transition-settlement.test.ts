import { expect, spyOn, test } from "bun:test";
import { statusResponseSchema, type WifiMessage } from "@ceraui/rpc/schemas";
import { rememberHotspotCredentials } from "../modules/wifi/hotspot-credentials.ts";
import {
	broadcastWifiModeSettlement,
	broadcastWifiState,
	wifiBuildMsg,
} from "../modules/wifi/wifi.ts";
import {
	cancelWifiAdapterReconciliation,
	registerWifiAdapterTeardownLocked,
} from "../modules/wifi/wifi-adapter-reconcile-retry.ts";
import { wifiHotspotStart } from "../modules/wifi/wifi-hotspot-activation.ts";
import {
	getHotspotClientsForInterface,
	refreshHotspotClients,
	resetHotspotClientsForTest,
	setHotspotClientsDepsForTest,
} from "../modules/wifi/wifi-hotspot-clients.ts";
import {
	defaultHotspotConfigDeps,
	defaultHotspotStopDeps,
	wifiHotspotConfig,
} from "../modules/wifi/wifi-hotspot-config.ts";
import { handleHotspotConn } from "../modules/wifi/wifi-hotspot-discovery.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { teardownHotspotLocked } from "../modules/wifi/wifi-hotspot-teardown.ts";
import {
	bindingForRow,
	wifiOperationGuard,
} from "../modules/wifi/wifi-operation-binding.ts";
import * as compat from "../rpc/compat.ts";
import { MAC, OTHER_UUID } from "./helpers/wifi-first-ap-fixture.ts";
import { mockQualifiedHybridDriver } from "./helpers/wifi-hybrid-qualification.ts";
import { isolateTransition } from "./helpers/wifi-transition-fixture.ts";

test("Save rollback-write refusal clears an event-less peer without another relay or Up", async () => {
	const f = await isolateTransition();
	try {
		const uuid = await f.startAccepted();
		settlePending(f.row.ifname, true);
		f.peer.length = 0;
		const effects: string[] = [];
		const write = defaultHotspotConfigDeps.nmConnSetFields;
		const request = {
			device: f.row.id,
			name: "Changed AP",
			password: "changed-password",
			channel: "auto",
		};
		const deps = {
			...defaultHotspotConfigDeps,
			broadcastState: broadcastWifiState,
			nmConnSetFields: async (...args: Parameters<typeof write>) => {
				const ssid = args[1]["802-11-wireless.ssid"];
				effects.push(`write:${ssid}`);
				return ssid === request.name ? write(...args) : false;
			},
			nmConnect: async () => {
				effects.push("refused Up");
				const joined = wifiBuildMsg()[f.row.id];
				expect(joined?.incarnation).toBe(f.before);
				expect(joined?.transition).toBe("activating");
				return false; // No activation receipt or timeout.
			},
		};
		const from = f.commands.length;
		await wifiHotspotConfig(f.context.ws, request, deps);
		expect(effects).toEqual([
			"write:Changed AP",
			"refused Up",
			"write:First AP",
		]);
		expect(f.settings.get(uuid)?.["802-11-wireless.ssid"]).toBe(request.name);
		expect(f.commands.slice(from).filter((args) => args[1] === "down")).toEqual(
			[],
		);
		expect(
			f.frames.map((raw) => {
				const frame: { wifi?: WifiMessage } = JSON.parse(raw);
				return frame.wifi?.hotspot?.config;
			}),
		).toEqual([
			{ device: f.row.id, error: "activating", incarnation: f.before },
		]);
		expect(f.row.hotspot.transition).toBeUndefined();
		expect(f.peer).toEqual([
			["normal", f.before, "activating", undefined],
			["local", f.before, undefined, undefined],
		]);
	} finally {
		await f.restore();
	}
});

test("a guarded Stop refusal before Down settles even without a mode witness", async () => {
	const f = await isolateTransition();
	try {
		const uuid = await f.startAccepted();
		settlePending(f.row.ifname, true);
		f.peer.length = 0;
		const binding = bindingForRow(MAC, f.row);
		if (!binding) throw new Error("Missing verified fixture binding");
		const operation = wifiOperationGuard(binding);
		const from = f.commands.length;
		const rescan = spyOn(defaultHotspotStopDeps, "rescan");
		expect(
			await teardownHotspotLocked(
				MAC,
				f.row,
				{
					...defaultHotspotStopDeps,
					broadcastState: () => {
						broadcastWifiState();
						operation.refuse();
					},
				},
				uuid,
				{ operation, pendingCleanup: false, targetIfname: f.row.ifname },
			),
		).toEqual({ success: false, error: "radio-changed" });
		expect(f.commands.slice(from).filter((args) => args[1] === "down")).toEqual(
			[],
		);
		expect(rescan).not.toHaveBeenCalled();
		expect(f.peer).toEqual([
			["normal", f.before, "deactivating", undefined],
			["local", f.before, undefined, undefined],
		]);
	} finally {
		await f.restore();
	}
});

test("profile discovery withdraws an old Start marker without waiting for its monitor", async () => {
	const f = await isolateTransition();
	try {
		f.deps.broadcastState = broadcastWifiState;
		const uuid = await f.startAccepted();
		const before = f.peer.length;
		expect(f.peer.at(-1)).toEqual([
			"normal",
			f.before,
			"activating",
			"station",
		]);
		const oldHotspot = f.row.hotspot;
		const fields = f.settings.get(uuid);
		if (!fields) throw new Error("Missing fixture profile fields");
		const foreignMac = "dc:a6:32:aa:bb:ff";
		rememberHotspotCredentials(foreignMac, {
			ssid: "Foreign AP",
			password: "foreign-password",
		});
		fields["802-11-wireless.mac-address"] = foreignMac;
		await handleHotspotConn(MAC, uuid);
		expect(f.row.hotspot).not.toBe(oldHotspot);
		expect(f.row.hotspot.conn).toBeUndefined();
		expect(f.row.hotspot.transition).toBe("activating");
		expect(wifiBuildMsg()[f.row.id]?.transition).toBeUndefined();
		expect(f.peer.slice(before)).toEqual([
			["local", f.before, undefined, undefined],
		]);
		await settlePending(f.row.ifname, false);
		expect(f.peer.slice(before)).toEqual([
			["local", f.before, undefined, undefined],
		]);
	} finally {
		await f.restore();
	}
});

test("failed Start with cleanup debt clears peer markers but retains the recovery target", async () => {
	const f = await isolateTransition();
	try {
		f.deps.broadcastState = broadcastWifiState;
		f.faults.upTimeout = f.faults.downFails = f.faults.deleteFails = true;
		const started = await f.start();
		expect(started).toEqual({
			success: false,
			error: "activation-failed",
			reason: "cleanup-pending",
		});
		expect(f.row.hotspot.conn).toBe(f.active());
		expect(f.active()).toBeString();
		expect(f.row.hotspot.transition).toBe("activating");
		expect(f.peer[0]).toEqual(["normal", f.before, "activating", "station"]);
		expect(f.peer.at(-1)).toEqual(["local", f.before, undefined, undefined]);
	} finally {
		cancelWifiAdapterReconciliation();
		await f.restore();
	}
});

test("public Start captures the replacement profile's prior after admission cleanup", async () => {
	const f = await isolateTransition();
	const entered = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<{ complete: true; stopped: true }>();
	f.row.hotspot.conn = OTHER_UUID;
	rememberHotspotCredentials("dc:a6:32:aa:bb:ff", {
		ssid: "Foreign AP",
		password: "foreign-password",
	});
	registerWifiAdapterTeardownLocked(MAC, () => {
		entered.resolve();
		return resume.promise;
	});
	const pending = wifiHotspotStart(
		{ device: f.row.id },
		{
			...f.deps,
			broadcastState: broadcastWifiState,
			publishOutcome: (kind, device, outcome) => {
				f.peer.push([kind, device, outcome]);
			},
		},
	);
	try {
		expect(
			await Promise.race([entered.promise.then(() => "cleanup"), pending]),
		).toBe("cleanup");
		const original = f.row.hotspot;
		await handleHotspotConn(MAC, OTHER_UUID);
		expect(f.row.hotspot).not.toBe(original);
		expect(f.row.hotspot.conn).toBeUndefined();
		expect(wifiBuildMsg()[f.row.id]?.incarnation).toBe(f.before);
		expect(f.peer).toEqual([]);
		resume.resolve({ complete: true, stopped: true });
		expect(await pending).toEqual({ success: true });
		settlePending(f.row.ifname, true);
		expect(f.peer).toEqual([
			["normal", f.before, "activating", "station"],
			["normal", f.before, "activating", "station"],
			["normal", f.before, undefined, "station"],
			["start", f.row.id, { success: true }],
			["local", f.before, undefined, undefined],
		]);
	} finally {
		resume.resolve({ complete: true, stopped: true });
		await pending;
		cancelWifiAdapterReconciliation();
		await f.restore();
	}
});

test("settlement emits current authority without probing the driver or retiring roster work", async () => {
	const f = await isolateTransition();
	resetHotspotClientsForTest();
	const driver = mockQualifiedHybridDriver();
	const dump = Promise.withResolvers<string>();
	const started = Promise.withResolvers<void>();
	const station = "Station 02:11:22:33:44:55 (on wlan0)\n\tsignal: -45 dBm\n";
	let rosterReads = 0;
	setHotspotClientsDepsForTest({
		runIw: async () => {
			if (++rosterReads === 1) return station;
			started.resolve();
			return dump.promise;
		},
		now: () => 0,
	});
	try {
		f.row.supportsApStaConcurrency = true;
		f.row.activeMode = "ap";
		await refreshHotspotClients([f.row.ifname]);
		expect(rosterReads).toBe(1);
		wifiBuildMsg();
		const flight = refreshHotspotClients([f.row.ifname], { force: true });
		expect(
			await Promise.race([started.promise.then(() => "reading"), flight]),
		).toBe("reading");
		driver.mockClear();
		f.row.activeMode = "infrastructure";
		f.row.hw = "Current fixture authority";
		let settled: ReturnType<typeof statusResponseSchema.parse> | undefined;
		spyOn(compat, "broadcastMsgLocal").mockImplementation((type, payload) => {
			if (type === "status") settled = statusResponseSchema.parse(payload);
			return "";
		});
		broadcastWifiModeSettlement();
		expect(settled?.wifi?.[0]).toMatchObject({
			hw: "Current fixture authority",
			incarnation: f.before,
			observed_mode: "station",
			supports_ap_sta_concurrency: true,
		});
		expect(settled?.wifi?.[0]).not.toHaveProperty("hotspot");
		f.row.activeMode = "ap";
		const remembered = getHotspotClientsForInterface(f.row.ifname);
		const joined = refreshHotspotClients([f.row.ifname], { force: true });
		dump.resolve(station);
		await Promise.all([flight, joined]);
		expect({
			driverReads: driver.mock.calls.length,
			rosterReads,
			remembered: remembered?.count,
		}).toEqual({ driverReads: 0, rosterReads: 2, remembered: 1 });
	} finally {
		dump.resolve(station);
		resetHotspotClientsForTest();
		await f.restore();
	}
});
