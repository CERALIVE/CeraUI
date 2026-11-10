import { expect, jest, spyOn, test } from "bun:test";
import { statusResponseSchema, type WifiStatus } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import * as nm from "../modules/network/network-manager.ts";
import * as ssh from "../modules/system/ssh.ts";
import {
	onWifiChange,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import { broadcastWifiState, wifiBuildMsg } from "../modules/wifi/wifi.ts";
import {
	addWifiInterface,
	getWifiInterfacesByMacAddress,
	handleWifiMonitorEvent,
} from "../modules/wifi/wifi-connections.ts";
import {
	type BaseWifiInterface,
	wifiUpdateDevices,
} from "../modules/wifi/wifi-interfaces.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import {
	RADIO_SHADOW_TIMEOUT_MS,
	wifiRadioObservation,
} from "../modules/wifi/wifi-radio-observation.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import {
	buildInitialStatus,
	getStatusProcedure,
} from "../rpc/procedures/status.procedure.ts";
import { getWifiStatusProcedure } from "../rpc/procedures/wifi.procedure.ts";
import { radioEquivalenceCases } from "./fixtures/wifi/radio-equivalence-cases.ts";
import { wifiProtocolContext } from "./helpers/wifi-protocol-context.ts";
import { radioEquivalenceTranscript } from "./helpers/wifi-radio-equivalence.ts";
import { fakeShadowSysfs } from "./helpers/wifi-radio-equivalence-shadow.ts";
import {
	isolateWifiRegistry,
	restoreWifiRegistry,
} from "./helpers/wifi-registry.ts";

const original = radioEquivalenceCases[0]?.frames[0]?.[0];
if (!original) throw new Error("Missing verified radio fixture");
for (const sameMac of [false, true]) {
	for (const outcome of [
		"success",
		"timeout",
		"rejection",
		"incoherent",
	] as const) {
		test(`same-ifname replacement never publishes its predecessor token: ${outcome}, same MAC=${sameMac}`, async () => {
			const replacementMac = sameMac ? original.permanent : "dc:a6:32:aa:bb:cc";
			if (!replacementMac) throw new Error("Missing replacement MAC");
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const frames: WifiStatus[] = [];
			const settled: WifiStatus[] = [];
			let pending = true;
			let frameIndex = 0;
			const replacement = {
				...original,
				permanent: replacementMac,
				ifindex: 20,
				phy: 2,
			};
			const context = wifiProtocolContext((raw) => {
				if (
					!pending ||
					settled.length !== 1 ||
					!getWifiInterfacesByMacAddress()[replacementMac]
				)
					return;
				const decoded: unknown = JSON.parse(raw);
				if (
					typeof decoded !== "object" ||
					decoded === null ||
					!("status" in decoded)
				)
					return;
				const wifi = statusResponseSchema.parse(decoded.status).wifi;
				if (wifi) frames.push(wifi);
			});
			const statusSurfaces = async () => {
				const wifiRpc = await call(getWifiStatusProcedure, undefined, {
					context,
				});
				const aggregate = await call(getStatusProcedure, undefined, {
					context,
				});
				return [
					wifiBuildMsg(),
					buildInitialStatus().status.wifi,
					wifiRpc,
					aggregate.wifi,
				];
			};
			const expectUnproven = (rows: WifiStatus | undefined) => {
				expect(Object.keys(rows ?? {})).toEqual([sameMac ? "0" : "1"]);
				for (const row of Object.values(rows ?? {})) {
					expect(row).not.toHaveProperty("incarnation");
				}
			};
			const sshProbe = spyOn(ssh, "getSshStatus").mockResolvedValue(undefined);
			addClient(context.ws);
			try {
				await radioEquivalenceTranscript(
					{
						name: `publication window ${outcome}`,
						admitted: true,
						frames: [
							[original],
							[
								{
									...replacement,
									ifindex: outcome === "incoherent" ? 0 : replacement.ifindex,
									beforeRead: async () => {
										entered.resolve();
										await release.promise;
									},
								},
							],
							[replacement],
						],
						publication: async () => {
							if (++frameIndex !== 2) return;
							// Actual discovery/activation broadcasts occur before detached sampling.
							if (!sameMac) expect(frames).toHaveLength(7);
							for (const rows of [...frames, ...(await statusSurfaces())]) {
								expectUnproven(rows);
							}
							jest.advanceTimersByTime(1);
							await entered.promise;
							for (const rows of await statusSurfaces()) {
								expectUnproven(rows);
							}
							if (outcome === "timeout") {
								jest.advanceTimersByTime(RADIO_SHADOW_TIMEOUT_MS + 1);
							}
							if (outcome === "rejection")
								release.reject(new Error("sysfs read failed"));
							else release.resolve();
							await wifiRadioObservation.settled;
							pending = false;
							for (const rows of await statusSurfaces()) {
								expect(Object.keys(rows ?? {})).toEqual([sameMac ? "0" : "1"]);
								for (const row of Object.values(rows ?? {})) {
									if (outcome === "success") {
										expect(row.incarnation).toEqual(expect.any(String));
										expect(row.incarnation).not.toBe(
											settled[0]?.[0]?.incarnation,
										);
									} else {
										expect(row).not.toHaveProperty("incarnation");
									}
								}
							}
						},
					},
					false,
					(rows) => settled.push(rows),
				);
				const before = Object.values(settled[0] ?? {})[0]?.incarnation;
				const after = Object.values(settled[2] ?? {})[0]?.incarnation;
				expect(before).toEqual(expect.any(String));
				expect(after).toEqual(expect.any(String));
				expect(after).not.toBe(before);
				if (outcome === "success") {
					expect(after).toBe(Object.values(settled[1] ?? {})[0]?.incarnation);
				}
			} finally {
				release.resolve();
				removeClient(context.ws);
				sshProbe.mockRestore();
			}
		});
	}
}

for (const reentrant of [false, true]) {
	test(`unavailable broadcast withholds its token and preserves a newer discovery: ${reentrant}`, async () => {
		jest.useFakeTimers();
		jest.setSystemTime(0);
		const registry = isolateWifiRegistry();
		const restoreShadow = await fakeShadowSysfs(() => [original]);
		const mac = original.permanent;
		if (!mac) throw new Error("Missing verified MAC");
		const row: BaseWifiInterface = {
			id: 0,
			ifname: "wlan0",
			conn: "station-uuid",
			hw: "radio",
			available: new Map(),
			saved: {},
			savedAll: {},
		};
		const received: WifiStatus[] = [];
		const deviceGate = Promise.withResolvers<string[] | undefined>();
		const deviceProbe = spyOn(nm, "nmDevices").mockImplementation(
			() => deviceGate.promise,
		);
		let pendingDiscovery: ReturnType<typeof wifiUpdateDevices> | undefined;
		const context = wifiProtocolContext((raw) => {
			const decoded: { status: { wifi: WifiStatus } } = JSON.parse(raw);
			received.push(decoded.status.wifi);
			if (reentrant) pendingDiscovery = wifiUpdateDevices();
		});
		addClient(context.ws);
		try {
			addWifiInterface(mac, row);
			setWifiState({ [mac]: { ...row, mode: "station" } });
			onWifiChange(broadcastWifiState);
			await wifiRadioIdentity.discover([{ ifname: row.ifname, row }]);
			const healthy = wifiBuildMsg()[0]?.incarnation;
			handleWifiMonitorEvent({
				type: "device-state",
				device: "wlan0",
				state: "unavailable",
			});
			expect(received).toHaveLength(1);
			expect(received[0]?.[0]).not.toHaveProperty("incarnation");
			const unavailable = wifiBuildMsg()[0]?.incarnation;
			if (reentrant) {
				expect(wifiBuildMsg()[0]).not.toHaveProperty("incarnation");
			} else {
				expect(unavailable).toEqual(expect.any(String));
				expect(unavailable).not.toBe(healthy);
			}
			deviceGate.resolve(undefined);
			await pendingDiscovery;
			await wifiRadioIdentity.discover([{ ifname: row.ifname, row }]);
			const recovered = wifiBuildMsg()[0]?.incarnation;
			expect(recovered).toEqual(expect.any(String));
			expect(recovered).not.toBe(unavailable);
			expect(recovered).not.toBe(healthy);
		} finally {
			deviceGate.resolve(undefined);
			await pendingDiscovery;
			deviceProbe.mockRestore();
			removeClient(context.ws);
			onWifiChange(() => undefined);
			setWifiState({});
			restoreWifiRegistry(registry);
			await restoreShadow();
			jest.useRealTimers();
		}
	});
}
