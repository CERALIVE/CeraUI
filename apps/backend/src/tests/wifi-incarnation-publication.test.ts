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
import { RADIO_SHADOW_TIMEOUT_MS } from "../modules/wifi/wifi-radio-observation.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import {
	buildInitialStatus,
	getStatusProcedure,
} from "../rpc/procedures/status.procedure.ts";
import { getWifiStatusProcedure } from "../rpc/procedures/wifi.procedure.ts";
import { radioEquivalenceCases } from "./fixtures/wifi/radio-equivalence-cases.ts";
import golden from "./fixtures/wifi/radio-equivalence-main.json";
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
			const observations: WifiStatus[] = [];
			const settled: WifiStatus[] = [];
			let pending = true;
			let frameIndex = 0;
			let discoveryIndex = 0;
			let predecessor: BaseWifiInterface | undefined;
			const replacement = {
				...original,
				permanent: replacementMac,
				ifindex: 20,
				phy: 2,
			};
			const context = wifiProtocolContext((raw) => {
				if (!pending || settled.length !== 1) return;
				const decoded: unknown = JSON.parse(raw);
				if (
					typeof decoded !== "object" ||
					decoded === null ||
					!("status" in decoded)
				)
					return;
				const wifi = statusResponseSchema.parse(decoded.status).wifi;
				if (wifi) {
					observations.push(wifi);
					if (getWifiInterfacesByMacAddress()[replacementMac])
						frames.push(wifi);
				}
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
				expect(Object.keys(rows ?? {})).toEqual(["0"]);
				for (const row of Object.values(rows ?? {})) {
					expect(row).not.toHaveProperty("incarnation");
					expect(row.incarnation).not.toBe(settled[0]?.[0]?.incarnation);
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
						duringDiscovery: async (discovery) => {
							if (++discoveryIndex !== 2) return;
							predecessor = Object.values(getWifiInterfacesByMacAddress())[0];
							await entered.promise;
							expect(observations).toEqual([]);
							expect(frames).toEqual([]);
							for (const rows of await statusSurfaces()) expectUnproven(rows);
							if (outcome === "timeout") {
								jest.advanceTimersByTime(RADIO_SHADOW_TIMEOUT_MS);
								await discovery;
								release.resolve();
							} else {
								if (outcome === "rejection")
									release.reject(new Error("sysfs read failed"));
								else release.resolve();
								await discovery;
							}
						},
						publication: async () => {
							if (++frameIndex !== 2) return;
							pending = false;
							const id = outcome === "success" && sameMac ? "0" : "1";
							let expected: WifiStatus;
							if (outcome === "success") {
								const token =
									wifiRadioIdentity.state.rows.get("wlan0")?.incarnation;
								expect(token).toEqual(expect.any(String));
								expect(token).not.toBe(settled[0]?.[0]?.incarnation);
								const baseline = sameMac
									? golden.broadcasts["sysfs fail ifname cache hit"].filter(
											({ at }) => at === 1,
										)
									: golden.broadcasts["verified fresh"];
								const expectedFrames = baseline.map(({ payload }) => {
									const row = payload.wifi["0"];
									return (
										statusResponseSchema.parse({
											wifi: {
												[id]: {
													...row,
													observed_mode: row.mode,
													...("hotspot" in row
														? {
																hotspot: {
																	...row.hotspot,
																	name: `fixture-${replacementMac.replaceAll(":", "")}`,
																},
															}
														: {}),
													incarnation: token,
												},
											},
										}).wifi ?? {}
									);
								});
								const confirmedFrame = expectedFrames.at(-1);
								if (!confirmedFrame)
									throw new Error("Missing settled Hotspot baseline");
								const beforeRoster = expectedFrames
									.slice(0, -1)
									.map<WifiStatus>((frame) => {
										const wifi = frame[id];
										if (!wifi) throw new Error("Missing Wi-Fi row");
										return wifi.transition === "activating" ||
											wifi.mode === "hotspot"
											? { [id]: { ...wifi, leaving: "station" } }
											: frame;
									});
								const firstAp = expectedFrames.find(
									(frame) => frame[id]?.mode === "hotspot",
								);
								if (!firstAp) throw new Error("Missing initial Hotspot frame");
								// The cached settlement does not wait for the AP client poll.
								const expectedLocal = [
									...beforeRoster,
									firstAp,
									confirmedFrame,
								];
								expect(observations).toEqual(expectedLocal);
								expect(frames).toEqual(expectedLocal);
								expected = confirmedFrame;
							} else {
								const registry = getWifiInterfacesByMacAddress();
								expect(Object.keys(registry)).toEqual(["degraded:wlan0"]);
								expect(registry["degraded:wlan0"]).not.toBe(predecessor);
								expect(registry["degraded:wlan0"]?.id).toBe(1);
								expect(frames).toEqual([]);
								expected = {
									[id]: {
										ifname: "wlan0",
										conn: "",
										hw: "Fixture Radio",
										saved: {},
										available: [],
										supports_hotspot: true,
										mode: "station",
										observed_mode: "station",
										degraded_reason: "permanent-mac-unresolved",
									},
								};
								expect(observations).toEqual([expected, expected]);
							}
							for (const rows of await statusSurfaces())
								expect(rows).toEqual(expected);
							for (const rows of [...observations, ...(await statusSurfaces())])
								for (const row of Object.values(rows ?? {}))
									expect(row.incarnation).not.toBe(
										settled[0]?.[0]?.incarnation,
									);
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
