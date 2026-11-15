import { expect, jest, spyOn, test } from "bun:test";
import { call } from "@orpc/server";
import { getMockState, initMockService } from "../mocks/mock-service.ts";
import { getMockWifiIncarnation } from "../mocks/providers/wifi-incarnation.ts";
import * as config from "../modules/config.ts";
import * as streaming from "../modules/streaming/streaming.ts";
import {
	getWifiState,
	setWifiState,
} from "../modules/wifi/state/wifi-state.ts";
import * as locks from "../modules/wifi/wifi-adapter-lock.ts";
import { notifyWifiAdapterModeDiscovery } from "../modules/wifi/wifi-adapter-mode-events.ts";
import {
	defaultAdapterModeDeps,
	setWifiAdapterMode,
	startWifiAdapterModeRestore,
} from "../modules/wifi/wifi-adapter-mode-transition.ts";
import {
	admitWifiRequest,
	withWifiRequestBinding,
} from "../modules/wifi/wifi-binding.ts";
import * as capabilities from "../modules/wifi/wifi-capabilities.ts";
import { addWifiInterface } from "../modules/wifi/wifi-connections.ts";
import { defaultHotspotDeps } from "../modules/wifi/wifi-hotspot-activation.ts";
import {
	defaultHotspotConfigDeps,
	defaultHotspotStopDeps,
} from "../modules/wifi/wifi-hotspot-config.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import type {
	HotspotStartResult,
	WifiInterfaceWithHotspot,
} from "../modules/wifi/wifi-hotspot-types.ts";
import { getWifiIdToMacAddress } from "../modules/wifi/wifi-interfaces.ts";
import {
	radioIdentityReaders,
	wifiRadioIdentity,
} from "../modules/wifi/wifi-radio-identity.ts";
import { wifiRadioObservation } from "../modules/wifi/wifi-radio-observation.ts";
import { invalidateWifiRadioRow } from "../modules/wifi/wifi-radio-publication.ts";
import * as compat from "../rpc/compat.ts";
import { addClient, broadcast, removeClient } from "../rpc/events.ts";
import { wifiRequestAdmissionMiddleware } from "../rpc/middleware/wifi-admission.middleware.ts";
import {
	hotspotPrepareProcedure,
	hotspotStopProcedure,
	setWifiAdapterModeProcedure,
} from "../rpc/procedures/wifi.procedure.ts";
import { appRouter } from "../rpc/router.ts";
import { statusClient } from "./helpers/status-client.ts";
import { fixture, guarded, request } from "./helpers/wifi-entry-fixture.ts";
import { wifiProtocolContext } from "./helpers/wifi-protocol-context.ts";

for (const mocked of [false, true]) {
	for (const kind of guarded) {
		for (const refusal of [
			"binding-required",
			"radio-changed",
			"radio-unverified",
		] as const) {
			test(`${mocked ? "mock" : "real"} ${kind} refuses ${refusal} without effects`, async () => {
				const state = await fixture();
				if (mocked) {
					state.mocked(true);
					initMockService(
						refusal === "radio-unverified"
							? "wifi-limited"
							: "multi-modem-wifi",
					);
				} else if (refusal === "radio-unverified") {
					state.row.degradedReason = "permanent-mac-unresolved";
				}
				const before = mocked
					? structuredClone(getMockState())
					: structuredClone(state.row.hotspot);
				const expected =
					refusal === "binding-required"
						? undefined
						: refusal === "radio-changed"
							? "stale-entry-token"
							: mocked
								? getMockWifiIncarnation("wlan0")
								: state.before;
				try {
					expect(await request(kind, state.context, expected)).toEqual({
						success: false,
						error: refusal,
					});
					expect(state.effects).toEqual([]);
					expect(mocked ? getMockState() : state.row.hotspot).toEqual(before);
					if (kind !== "prepare-load" && kind !== "prepare-save") {
						const frames = state.frames.map((raw) => JSON.parse(raw).wifi);
						const terminal =
							kind === "start"
								? frames.at(-1)?.hotspot?.start
								: kind === "configure"
									? frames.at(-1)?.hotspot?.config
									: frames.at(-1)?.adapter_mode;
						expect(terminal?.error).toBe(refusal);
					}
				} finally {
					await state.restore();
				}
			});
		}
	}
	for (const limited of [false, true]) {
		for (const incarnation of [undefined, "stale-entry-token"]) {
			test(`${mocked ? "mock" : "real"} Stop and station remain available, limited=${limited}, token=${incarnation}`, async () => {
				const state = await fixture();
				if (mocked) {
					state.mocked(true);
					initMockService(limited ? "wifi-limited" : "multi-modem-wifi");
				} else if (limited)
					state.row.degradedReason = "permanent-mac-unresolved";
				const input = {
					device: "0",
					...(incarnation === undefined ? {} : { incarnation }),
				};
				try {
					expect(
						await call(hotspotStopProcedure, input, { context: state.context }),
					).toEqual({ success: true });
					expect(
						await call(
							setWifiAdapterModeProcedure,
							{ ...input, mode: "station" },
							{ context: state.context },
						),
					).toEqual({ success: true, applied: "station" });
				} finally {
					await state.restore();
				}
			});
		}
	}
}

for (const lands of [false, true]) {
	test(`pending identity ${lands ? "lands inside" : "exceeds"} the bounded admission wait`, async () => {
		const state = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let first = true;
		spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) => {
			if (first && path.endsWith("/ifindex")) {
				first = false;
				entered.resolve();
				await release.promise;
			}
			return path.endsWith("/ifindex")
				? "10"
				: path.endsWith("/index")
					? "1"
					: "dc:a6:32:aa:bb:c0";
		});
		const sequence = wifiRadioIdentity.captureObservation();
		invalidateWifiRadioRow(state.row, sequence);
		wifiRadioObservation.enqueue(
			[{ ifname: state.row.ifname, row: state.row }],
			sequence,
		);
		jest.advanceTimersByTime(0);
		const sampling = wifiRadioObservation.settled;
		try {
			await entered.promise;
			const pending = call(
				hotspotPrepareProcedure,
				{ device: "0", incarnation: state.before },
				{ context: state.context },
			);
			let completed = false;
			void pending.then(() => {
				completed = true;
			});
			for (let turn = 0; turn < 20; turn++) await Promise.resolve();
			expect(completed).toBe(false);
			if (lands) {
				release.resolve();
				await sampling;
				expect(await pending).toEqual({
					success: true,
					name: "Original AP",
					password: "original-password",
				});
			} else {
				jest.advanceTimersByTime(2000);
				expect(await pending).toEqual({
					success: false,
					error: "radio-changed",
					reason: "current-unobserved",
				});
				expect(state.effects).toEqual([]);
			}
		} finally {
			release.resolve();
			await sampling;
			wifiRadioObservation.stop();
			await state.restore();
		}
	});
}

for (const kind of guarded) {
	test(`a rotation between RPC entry and transaction lock refuses ${kind} before effects or an active shortcut`, async () => {
		const state = await fixture();
		const original = locks.withWifiAdapterLock;
		let calls = 0;
		spyOn(locks, "withWifiAdapterLock").mockImplementation(
			async (key, operation) => {
				if (++calls === 2) await state.rotate();
				return original(key, operation);
			},
		);
		try {
			const result = await request(kind, state.context, state.before);
			if (kind === "configure") {
				expect(result).toEqual({ success: true });
				await state.configReceived;
				expect(
					JSON.parse(state.frames.at(-1) ?? "{}").wifi.hotspot.config.error,
				).toBe("radio-changed");
			} else expect(result).toEqual({ success: false, error: "radio-changed" });
			expect(state.effects).toEqual([]);
		} finally {
			await state.restore();
		}
	});
}

test("an admitted mode transition does not re-admit its start after the AP teardown", async () => {
	const state = await fixture();
	spyOn(capabilities, "getWifiCapabilitiesForInterface").mockReturnValue({
		phy: "phy1",
		generation: "wifi6",
		bands: ["2.4", "5"],
		maxWidthMhz: { "2.4": 40, "5": 80 },
		apModes: ["2.4", "5"],
		staApCombo: { supported: true, sameChannelOnly: true },
		wpa3Sae: "unknown",
		regulatory: { country: "ES", is6GhzLegal: false, self_managed: false },
	});
	spyOn(defaultAdapterModeDeps, "restoreMode").mockImplementation(() => {
		state.effects.push("mode-restore");
	});
	spyOn(defaultHotspotStopDeps, "nmDisconnect").mockImplementation(async () => {
		state.effects.push("ap-teardown");
		await state.rotate();
		return true;
	});
	try {
		expect(await request("hybrid", state.context, state.before)).toEqual({
			success: true,
			accepted: true,
			applied: "hybrid",
		});
		expect(state.effects).toContain("ap-teardown");
		expect(state.effects).not.toContain("mode-restore");
		const modes = state.frames
			.map((raw) => JSON.parse(raw).wifi?.adapter_mode)
			.filter(Boolean);
		expect(modes.at(-1)).toMatchObject({ success: true, mode: "hybrid" });
	} finally {
		await state.restore();
	}
});

/**
 * Reads through the real lock-entry boundary: a request admission in scope
 * refuses a copy of the row it resolves, while internal work runs unchecked.
 */
function admitted(row: WifiInterfaceWithHotspot): Promise<boolean> {
	return admitWifiRequest(
		{ ...row },
		async () => false,
		() => true,
	);
}

/** Probe a callback's own scope, and a timer and a promise it schedules. */
function probeScopes(
	seen: Promise<string>[],
	where: string,
	row: WifiInterfaceWithHotspot,
): void {
	const read = (label: string) =>
		admitted(row).then(
			(inScope) => `${label}:${inScope ? "admitted" : "absent"}`,
		);
	seen.push(read(where));
	seen.push(
		new Promise((resolve) => {
			setTimeout(() => resolve(read(`${where} timer`)), 0);
		}),
	);
	seen.push(Promise.resolve().then(() => read(`${where} promise`)));
}

for (const kind of guarded) {
	test(`the admitted ${kind} transaction and the work it schedules run without the request admission`, async () => {
		const state = await fixture();
		jest.useRealTimers();
		const seen: Promise<string>[] = [];
		const fired = new Set<string>();
		const probe = (where: string) => {
			fired.add(where);
			probeScopes(seen, where, state.row);
		};
		spyOn(defaultHotspotDeps.credentials, "get").mockImplementation(() => {
			probe("credentials");
			return undefined;
		});
		spyOn(defaultHotspotDeps, "publishOutcome").mockImplementation(() =>
			probe("start outcome"),
		);
		spyOn(defaultHotspotConfigDeps, "nmConnSetFields").mockImplementation(
			async () => {
				probe("config write");
				return true;
			},
		);
		spyOn(defaultAdapterModeDeps, "publishOutcome").mockImplementation(() =>
			probe("mode outcome"),
		);
		try {
			await request(kind, state.context, state.before);
			const results = await Promise.all(seen);
			expect(fired.size).toBeGreaterThan(0);
			expect(results.filter((result) => result.endsWith(":admitted"))).toEqual(
				[],
			);
		} finally {
			await state.restore();
		}
	});
}

test("an admitted transition's teardown, prune, poll and terminal timer run without the request admission", async () => {
	const state = await fixture();
	jest.useRealTimers();
	spyOn(capabilities, "getWifiCapabilitiesForInterface").mockReturnValue({
		phy: "phy1",
		generation: "wifi6",
		bands: ["2.4", "5"],
		maxWidthMhz: { "2.4": 40, "5": 80 },
		apModes: ["2.4", "5"],
		staApCombo: { supported: true, sameChannelOnly: true },
		wpa3Sae: "unknown",
		regulatory: { country: "ES", is6GhzLegal: false, self_managed: false },
	});
	const seen: Promise<string>[] = [];
	const fired = new Set<string>();
	const probe = (where: string) => {
		fired.add(where);
		probeScopes(seen, where, state.row);
	};
	spyOn(defaultHotspotStopDeps, "rescan").mockImplementation(async () => {
		probe("stop rescan");
	});
	spyOn(defaultHotspotDeps, "pruneHotspotConns").mockImplementation(
		async () => {
			probe("profile prune");
		},
	);
	spyOn(defaultHotspotDeps, "nmConnect").mockResolvedValue(true);
	spyOn(defaultHotspotDeps, "setDupIpSuppression").mockImplementation(
		() => undefined,
	);
	spyOn(defaultHotspotDeps, "pollHotspotActive").mockImplementation(
		async () => {
			probe("confirmation poll");
			return true;
		},
	);
	spyOn(defaultAdapterModeDeps, "armTerminalTimeout").mockImplementation(() => {
		probe("terminal timer");
		return () => undefined;
	});
	try {
		expect(await request("hybrid", state.context, state.before)).toEqual({
			success: true,
			accepted: true,
			applied: "hybrid",
		});
		const results = await Promise.all(seen);
		expect([...fired].sort()).toEqual([
			"confirmation poll",
			"profile prune",
			"stop rescan",
			"terminal timer",
		]);
		expect(results.filter((result) => result.endsWith(":admitted"))).toEqual(
			[],
		);
	} finally {
		await settlePending(state.row.ifname, false);
		await state.restore();
	}
});

/**
 * A real local broadcast client. Its delivery runs inside the fan-out in
 * `events.broadcast`, so the probe's promise and timer are scheduled from the
 * same frame as the fan-out's own settlement continuation.
 */
function probeBroadcasts(probe: (where: string) => void): {
	readonly delivered: Promise<void>;
	readonly stop: () => void;
} {
	const delivered = Promise.withResolvers<void>();
	spyOn(compat, "broadcastMsg").mockImplementation((type, data) =>
		broadcast(type, data),
	);
	const client = statusClient(() => {
		probe("broadcast delivery");
		delivered.resolve();
	});
	addClient(client);
	return { delivered: delivered.promise, stop: () => removeClient(client) };
}

test("an admitted Configure publishes its terminal frame without the request admission", async () => {
	const state = await fixture();
	jest.useRealTimers();
	const seen: Promise<string>[] = [];
	const fired = new Set<string>();
	const terminal = Promise.withResolvers<void>();
	const context = wifiProtocolContext((frame) => {
		if (!JSON.parse(frame).wifi?.hotspot?.config) return;
		fired.add("config terminal frame");
		probeScopes(seen, "config terminal frame", state.row);
		terminal.resolve();
	});
	try {
		expect(await request("configure", context, state.before)).toEqual({
			success: true,
		});
		await terminal.promise;
		const results = await Promise.all(seen);
		expect([...fired]).toEqual(["config terminal frame"]);
		expect(results.filter((result) => result.endsWith(":admitted"))).toEqual(
			[],
		);
	} finally {
		await state.restore();
	}
});

test("an admitted Start that fails publishes its refusal broadcast without the request admission", async () => {
	const state = await fixture();
	jest.useRealTimers();
	state.row.conn = null;
	state.row.activeMode = "infrastructure";
	spyOn(defaultHotspotDeps, "nmConnect").mockResolvedValue(false);
	spyOn(defaultHotspotDeps, "setDupIpSuppression").mockImplementation(
		() => undefined,
	);
	const seen: Promise<string>[] = [];
	const fired = new Set<string>();
	const broadcasts = probeBroadcasts((where) => {
		fired.add(where);
		probeScopes(seen, where, state.row);
	});
	try {
		expect(await request("start", state.context, state.before)).toEqual({
			success: false,
			error: "activation-failed",
		});
		await broadcasts.delivered;
		const results = await Promise.all(seen);
		expect([...fired]).toEqual(["broadcast delivery"]);
		expect(results.filter((result) => result.endsWith(":admitted"))).toEqual(
			[],
		);
	} finally {
		broadcasts.stop();
		await state.restore();
	}
});

for (const kind of ["start", "configure"] as const) {
	test(`a ${kind} refused at lock entry leaves its admission consumed`, async () => {
		const state = await fixture();
		jest.useRealTimers();
		const original = locks.withWifiAdapterLock;
		let calls = 0;
		spyOn(locks, "withWifiAdapterLock").mockImplementation(
			async (key, operation) => {
				if (++calls === 2) await state.rotate();
				return original(key, operation);
			},
		);
		const seen: Promise<string>[] = [];
		const fired = new Set<string>();
		const probe = (where: string) => {
			fired.add(where);
			probeScopes(seen, where, state.row);
		};
		const terminal = Promise.withResolvers<void>();
		const context = wifiProtocolContext((frame) => {
			if (!JSON.parse(frame).wifi?.hotspot?.config) return;
			probe("config refusal frame");
			terminal.resolve();
		});
		const broadcasts = probeBroadcasts(probe);
		try {
			const result = await request(kind, context, state.before);
			if (kind === "configure") {
				expect(result).toEqual({ success: true });
				await terminal.promise;
			} else {
				expect(result).toEqual({ success: false, error: "radio-changed" });
				await broadcasts.delivered;
			}
			const results = await Promise.all(seen);
			expect([...fired].sort()).toEqual(
				kind === "configure"
					? ["config refusal frame"]
					: ["broadcast delivery"],
			);
			expect(results.filter((r) => r.endsWith(":admitted"))).toEqual([]);
			expect(state.effects).toEqual([]);
		} finally {
			broadcasts.stop();
			await state.restore();
		}
	});
}

test("a confirmation poll's discovery restores another radio's pending hotspot normally", async () => {
	const state = await fixture();
	const MAC_B = "dc:a6:32:aa:bb:c1";
	const rowB: WifiInterfaceWithHotspot = {
		id: 1,
		ifname: "wlan1",
		hw: "Restore radio",
		conn: "station-b",
		activeConn: "station-b",
		activeMode: "infrastructure",
		available: new Map(),
		saved: {},
		savedAll: {},
		hotspot: {
			conn: "b-ap",
			name: "Restore AP",
			password: "restore-password",
			channel: "auto",
			availableChannels: ["auto"],
			warnings: {},
		},
	};
	state.row.conn = null;
	state.row.activeMode = "infrastructure";
	addWifiInterface(MAC_B, rowB);
	getWifiIdToMacAddress()[1] = MAC_B;
	const modes = config.getConfig().wifi_modes;
	config.getConfig().wifi_modes = { [MAC_B]: "hotspot" };
	const wifiState = getWifiState();
	const streamingNow = spyOn(streaming, "getIsStreaming").mockReturnValue(true);
	spyOn(defaultHotspotDeps, "nmConnect").mockImplementation(async (uuid) => {
		state.effects.push(`up:${uuid}`);
		return true;
	});
	spyOn(defaultHotspotDeps, "setDupIpSuppression").mockImplementation(
		() => undefined,
	);
	spyOn(defaultHotspotDeps, "pruneHotspotConns").mockResolvedValue(undefined);
	spyOn(defaultHotspotDeps, "pollHotspotActive").mockImplementation(
		async (iface) => {
			if (iface.ifname === state.row.ifname)
				await notifyWifiAdapterModeDiscovery();
			return true;
		},
	);
	const original = defaultAdapterModeDeps.startHotspot;
	const restored = Promise.withResolvers<{
		readonly admitted: boolean;
		readonly result: HotspotStartResult;
	}>();
	spyOn(defaultAdapterModeDeps, "startHotspot").mockImplementation(
		async (device, publish) => {
			const underRequest = await admitted(rowB);
			const result = await original(device, publish);
			restored.resolve({ admitted: underRequest, result });
			return result;
		},
	);
	const stop = startWifiAdapterModeRestore();
	try {
		for (let turn = 0; turn < 50; turn++) await Promise.resolve();
		streamingNow.mockReturnValue(false);
		expect(await request("start", state.context, state.before)).toEqual({
			success: true,
			accepted: true,
		});
		expect(await restored.promise).toEqual({
			admitted: false,
			result: { success: true },
		});
		expect(state.effects).toContain("up:b-ap");
		const starts = state.frames
			.map((raw) => JSON.parse(raw).wifi?.hotspot?.start)
			.filter(Boolean);
		expect(starts.some((frame) => frame.error !== undefined)).toBe(false);
	} finally {
		stop();
		await settlePending(rowB.ifname, false);
		await settlePending(state.row.ifname, false);
		config.getConfig().wifi_modes = modes;
		setWifiState(wifiState);
		await state.restore();
	}
});

test("a restore edge published inside an admitted request is delivered without its admission", async () => {
	const state = await fixture();
	const wifiState = getWifiState();
	const modes = config.getConfig().wifi_modes;
	config.getConfig().wifi_modes = { "dc:a6:32:aa:bb:c0": "hotspot" };
	const seen: string[] = [];
	const delivered = Promise.withResolvers<void>();
	let armed = false;
	const stop = startWifiAdapterModeRestore({
		...defaultAdapterModeDeps,
		resolveInterfaces: () => {
			if (armed) {
				armed = false;
				void admitted(state.row).then((leaked) => {
					seen.push(`restore:${leaked}`);
					delivered.resolve();
				});
			}
			return {};
		},
	});
	try {
		for (let turn = 0; turn < 50; turn++) await Promise.resolve();
		await withWifiRequestBinding(
			{ device: "0", expected: state.before, kind: "config" },
			async () => {
				armed = true;
				await notifyWifiAdapterModeDiscovery();
				// A probe consumes the admission, so the request reads it after delivery.
				seen.push(`request:${await admitted(state.row)}`);
			},
		);
		await delivered.promise;
		expect(seen.sort()).toEqual(["request:true", "restore:false"]);
	} finally {
		stop();
		config.getConfig().wifi_modes = modes;
		setWifiState(wifiState);
		await state.restore();
	}
});

test("fresh sysfs evidence refuses a replacement before another status broadcast", async () => {
	const state = await fixture();
	spyOn(radioIdentityReaders, "readText").mockImplementation((path) =>
		Promise.resolve(
			path.endsWith("/ifindex")
				? "90"
				: path.endsWith("/index")
					? "1"
					: "dc:a6:32:aa:bb:c0",
		),
	);
	try {
		expect(await request("start", state.context, state.before)).toEqual({
			success: false,
			error: "radio-changed",
		});
		expect(state.effects).toEqual([]);
	} finally {
		await state.restore();
	}
});

test("publication proof lost during the fresh sample returns current-unobserved without effects", async () => {
	const state = await fixture();
	spyOn(radioIdentityReaders, "readText").mockImplementation((path) => {
		invalidateWifiRadioRow(state.row, undefined);
		return Promise.resolve(
			path.endsWith("/ifindex")
				? "10"
				: path.endsWith("/index")
					? "1"
					: "dc:a6:32:aa:bb:c0",
		);
	});
	try {
		expect(
			await call(
				hotspotPrepareProcedure,
				{
					device: "0",
					incarnation: state.before,
				},
				{ context: state.context },
			),
		).toEqual({
			success: false,
			error: "radio-changed",
			reason: "current-unobserved",
		});
		expect(state.effects).toEqual([]);
	} finally {
		await state.restore();
	}
});

test("every guarded Wi-Fi router procedure uses the shared admission path exactly once", () => {
	const guardedProcedures = Object.entries(appRouter.wifi).filter(
		([name]) =>
			(name.startsWith("hotspot") && name !== "hotspotStop") ||
			name === "setAdapterMode",
	);
	expect(guardedProcedures.map(([name]) => name).sort()).toEqual([
		"hotspotConfigure",
		"hotspotPrepare",
		"hotspotStart",
		"setAdapterMode",
	]);
	for (const [, procedure] of guardedProcedures) {
		const admission = procedure["~orpc"].orderedMiddlewares.filter(
			({ middleware }) =>
				middleware.name === wifiRequestAdmissionMiddleware.name,
		);
		expect(admission).toHaveLength(1);
		expect(admission[0]?.inputSchemasLengthAtUse).toBe(1);
	}
	expect(
		appRouter.wifi.hotspotStop["~orpc"].orderedMiddlewares.some(
			({ middleware }) =>
				middleware.name === wifiRequestAdmissionMiddleware.name,
		),
	).toBe(false);
});

for (const exit of ["refusal", "busy", "throw", "return"] as const) {
	test(`request admission expires after a middleware ${exit} exit`, async () => {
		const state = await fixture();
		const release = Promise.withResolvers<void>();
		const original = locks.withWifiAdapterLock;
		let leaked: Promise<boolean> | undefined;
		const error = new Error("admission probe failed");
		spyOn(locks, "withWifiAdapterLock").mockImplementation(
			async (key, operation) => {
				leaked ??= release.promise.then(() => admitted(state.row));
				if (exit === "throw") throw error;
				if (exit === "busy") return { success: false, error: "DEVICE_BUSY" };
				return original(key, operation);
			},
		);
		try {
			const result = request(
				"start",
				state.context,
				exit === "refusal" ? "stale-entry-token" : state.before,
			);
			if (exit === "throw") await expect(result).rejects.toThrow(error);
			else
				expect(await result).toEqual(
					exit === "return"
						? { success: true, accepted: true }
						: {
								success: false,
								error: exit === "busy" ? "DEVICE_BUSY" : "radio-changed",
							},
				);
			release.resolve();
			expect(await leaked).toBe(false);
		} finally {
			release.resolve();
			await leaked;
			await state.restore();
		}
	});
}

test("Start DEVICE_BUSY before lock entry publishes without readable admission", async () => {
	const state = await fixture();
	jest.useRealTimers();
	const original = locks.withWifiAdapterLock;
	let calls = 0;
	spyOn(locks, "withWifiAdapterLock").mockImplementation(
		async (key, operation) =>
			++calls === 2
				? { success: false, error: "DEVICE_BUSY" }
				: original(key, operation),
	);
	const seen: Promise<string>[] = [];
	const broadcasts = probeBroadcasts((where) =>
		probeScopes(seen, where, state.row),
	);
	try {
		expect(await request("start", state.context, state.before)).toEqual({
			success: false,
			error: "DEVICE_BUSY",
		});
		await broadcasts.delivered;
		expect(await Promise.all(seen)).toEqual([
			"broadcast delivery:absent",
			"broadcast delivery timer:absent",
			"broadcast delivery promise:absent",
		]);
		expect(state.effects).toEqual([]);
	} finally {
		broadcasts.stop();
		await state.restore();
	}
});

test("a leaked admission for adapter A cannot refuse adapter B's internal restore", async () => {
	const state = await fixture();
	const mac = "dc:a6:32:aa:bb:c1";
	const rowB: WifiInterfaceWithHotspot = {
		...state.row,
		id: 1,
		ifname: "wlan1",
		hotspot: { ...state.row.hotspot },
	};
	addWifiInterface(mac, rowB);
	getWifiIdToMacAddress()[1] = mac;
	try {
		expect(
			await withWifiRequestBinding(
				{ device: "0", expected: "leaked-adapter-A-token", kind: "config" },
				() => setWifiAdapterMode("1", "hotspot"),
			),
		).toEqual({ success: true, applied: "hotspot" });
	} finally {
		await state.restore();
	}
});

for (const refusal of [
	"radio-unverified",
	"radio-changed",
	"current-unobserved",
] as const) {
	test(`Configure preserves its acknowledgement and captured ${refusal} terminal without effects`, async () => {
		const state = await fixture();
		const held = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const originalLock = locks.withWifiAdapterLock;
		let calls = 0;
		spyOn(locks, "withWifiAdapterLock").mockImplementation((key, operation) => {
			if (++calls === 2) {
				if (refusal === "radio-unverified") {
					state.row.degradedReason = "permanent-mac-unresolved";
				} else {
					spyOn(radioIdentityReaders, "readText").mockImplementation(
						async (path) => {
							if (path.endsWith("/ifindex")) {
								entered.resolve();
								await held.promise;
								if (refusal === "radio-changed") return "20";
							}
							return path.endsWith("/ifindex")
								? "10"
								: path.endsWith("/index")
									? "1"
									: "dc:a6:32:aa:bb:c0";
						},
					);
				}
			}
			return originalLock(key, operation);
		});
		try {
			expect(await request("configure", state.context, state.before)).toEqual({
				success: true,
			});
			if (refusal !== "radio-unverified") {
				await entered.promise;
				expect(state.frames).toEqual([]);
				if (refusal === "current-unobserved")
					invalidateWifiRadioRow(
						state.row,
						wifiRadioIdentity.captureObservation(),
					);
				held.resolve();
			}
			await state.configReceived;
			expect(
				JSON.parse(state.frames.at(-1) ?? "{}").wifi.hotspot.config,
			).toEqual({
				device: 0,
				error: refusal === "current-unobserved" ? "radio-changed" : refusal,
				...(refusal === "current-unobserved" ? { reason: refusal } : {}),
				incarnation: state.before,
			});
			expect(state.effects).toEqual([]);
		} finally {
			held.resolve();
			await state.restore();
		}
	});
}
