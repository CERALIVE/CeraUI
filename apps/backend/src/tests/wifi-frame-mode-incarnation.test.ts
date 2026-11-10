import { expect, spyOn, test } from "bun:test";
import { wifiMessageSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import { initMockService } from "../mocks/mock-service.ts";
import { getMockWifiIncarnation } from "../mocks/providers/wifi-incarnation.ts";
import {
	type AdapterModeTransitionDeps,
	defaultAdapterModeDeps,
	setWifiAdapterMode,
} from "../modules/wifi/wifi-adapter-mode-transition.ts";
import { getWifiInterfacesByMacAddress } from "../modules/wifi/wifi-connections.ts";
import type { HotspotOutcomePublisher } from "../modules/wifi/wifi-hotspot-outcome.ts";
import { setWifiAdapterModeProcedure } from "../rpc/procedures/wifi.procedure.ts";
import {
	frameTranscript,
	wifiFrameFixture,
} from "./helpers/wifi-frame-fixture.ts";

for (const active of [false, true]) {
	for (const proven of [false, true]) {
		for (const timeout of [false, true]) {
			test(`mode pending and late terminal keep dispatch binding, active=${active}, proven=${proven}, timeout=${timeout}`, async () => {
				const fixture = await wifiFrameFixture(active, proven);
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				let complete: HotspotOutcomePublisher | undefined;
				let expire: (() => void) | undefined;
				const target = active ? "station" : "hotspot";
				const delegate = async (
					device: number,
					publish: HotspotOutcomePublisher,
				): Promise<{ success: true }> => {
					fixture.effects.push(["dispatch", device]);
					complete = publish;
					return { success: true };
				};
				const deps: AdapterModeTransitionDeps = {
					...defaultAdapterModeDeps,
					resolveInterfaces: getWifiInterfacesByMacAddress,
					isAdapterBusy: async () => {
						entered.resolve();
						await release.promise;
						return false;
					},
					startHotspot: delegate,
					stopHotspot: delegate,
					persistMode: (mac, mode) =>
						fixture.effects.push(["persist", mac, mode]),
					readPersistedMode: () => undefined,
					armTerminalTimeout: (callback) => {
						expire = callback;
						return () => fixture.effects.push("cancel-timeout");
					},
				};
				try {
					const pending = setWifiAdapterMode("0", target, deps);
					await entered.promise;
					const replacement = await fixture.rotate();
					release.resolve();
					const result = await pending;
					if (!complete || !expire)
						throw new Error("missing terminal callbacks");
					if (timeout) expire();
					complete(active ? "stop" : "start", 0, { success: true });
					const legacy = frameTranscript(
						`mode:${active}:${proven}:${timeout}`,
						fixture,
						result,
					);
					const kind = active ? "stop" : "start";
					const pendingFrame = {
						wifi: { adapter_mode: { device: 0, mode: target, pending: true } },
					};
					const hotspotFrame = {
						wifi: { hotspot: { [kind]: { device: 0, success: true } } },
					};
					const terminal = timeout
						? { wifi: { adapter_mode: { device: 0, error: "not-confirmed" } } }
						: {
								wifi: {
									adapter_mode: { device: 0, mode: target, success: true },
								},
							};
					expect(legacy).toEqual(
						(timeout
							? [pendingFrame, terminal, hotspotFrame]
							: [pendingFrame, hotspotFrame, terminal]
						).map((value) => JSON.stringify(value)),
					);
					expect(result).toEqual(
						active
							? { success: true, applied: target }
							: { success: true, accepted: true, applied: target },
					);
					expect(replacement).not.toBe(fixture.before);
					const modes = fixture.frames
						.map(
							(raw) =>
								wifiMessageSchema.parse(JSON.parse(raw).wifi).adapter_mode,
						)
						.filter((mode) => mode !== undefined);
					expect(modes).toHaveLength(2);
					for (const mode of modes) {
						if (proven) expect(mode.incarnation).toBe(fixture.before);
						else expect(mode).not.toHaveProperty("incarnation");
					}
					const hotspot = fixture.frames
						.map((raw) => wifiMessageSchema.parse(JSON.parse(raw).wifi).hotspot)
						.find((value) => value !== undefined);
					expect(hotspot?.[kind]).not.toHaveProperty("incarnation");
				} finally {
					release.resolve();
					await fixture.restore();
				}
			});
		}
	}
}

test("real mode RPC echoes the validated expected token only on asynchronous frames", async () => {
	const fixture = await wifiFrameFixture(false);
	let complete: HotspotOutcomePublisher | undefined;
	spyOn(defaultAdapterModeDeps, "isAdapterBusy").mockResolvedValue(false);
	spyOn(defaultAdapterModeDeps, "persistMode").mockImplementation(
		() => undefined,
	);
	spyOn(defaultAdapterModeDeps, "readPersistedMode").mockReturnValue(undefined);
	spyOn(defaultAdapterModeDeps, "startHotspot").mockImplementation(
		async (_device, publish) => {
			complete = publish;
			return { success: true };
		},
	);
	spyOn(defaultAdapterModeDeps, "armTerminalTimeout").mockImplementation(
		() => () => undefined,
	);
	try {
		const result = await call(
			setWifiAdapterModeProcedure,
			{
				device: "0",
				mode: "hotspot",
				incarnation: "request-A",
			},
			{ context: fixture.context },
		);
		await fixture.rotate();
		if (!complete) throw new Error("missing terminal callback");
		complete("start", 0, { success: true });
		frameTranscript("rpc-mode:real", fixture, result);
		expect(result).toEqual({
			success: true,
			accepted: true,
			applied: "hotspot",
		});
		const modes = fixture.frames
			.map((raw) => wifiMessageSchema.parse(JSON.parse(raw).wifi).adapter_mode)
			.filter((mode) => mode !== undefined);
		expect(modes).toHaveLength(2);
		for (const mode of modes) expect(mode.incarnation).toBe("request-A");
	} finally {
		await fixture.restore();
	}
});

for (const expected of [undefined, "request-A"]) {
	for (const mode of ["hotspot", "hybrid"] as const) {
		test(`mock mode frame parity, mode=${mode}, expected=${expected}`, async () => {
			const fixture = await wifiFrameFixture(false);
			fixture.mocked(true);
			initMockService("multi-modem-wifi");
			const captured = expected ?? getMockWifiIncarnation("wlan0");
			try {
				const result = await call(
					setWifiAdapterModeProcedure,
					{
						device: "0",
						mode,
						...(expected === undefined ? {} : { incarnation: expected }),
					},
					{ context: fixture.context },
				);
				const legacy = frameTranscript(
					`rpc-mode:mock:${mode}:${expected}`,
					fixture,
					result,
				);
				const outcome =
					mode === "hotspot"
						? { device: "0", mode, success: true }
						: { device: "0", error: "capability-unproven" };
				expect(legacy).toEqual([
					JSON.stringify({ wifi: { adapter_mode: outcome } }),
				]);
				expect(result).toEqual(
					mode === "hotspot"
						? { success: true, applied: mode }
						: { success: false, error: "capability-unproven" },
				);
				const frame = wifiMessageSchema.parse(
					JSON.parse(fixture.frames[0] ?? "{}").wifi,
				);
				expect(frame.adapter_mode?.incarnation).toBe(captured);
			} finally {
				await fixture.restore();
			}
		});
	}
}
