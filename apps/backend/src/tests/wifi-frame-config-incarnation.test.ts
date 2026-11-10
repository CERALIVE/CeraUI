import { expect, spyOn, test } from "bun:test";
import { wifiMessageSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import { initMockService } from "../mocks/mock-service.ts";
import {
	getMockWifiIncarnation,
	rebindMockWifi,
} from "../mocks/providers/wifi-incarnation.ts";
import { handleWifi } from "../modules/wifi/wifi.ts";
import * as locks from "../modules/wifi/wifi-adapter-lock.ts";
import {
	defaultHotspotConfigDeps,
	wifiHotspotConfig,
} from "../modules/wifi/wifi-hotspot-config.ts";
import { hotspotConfigureProcedure } from "../rpc/procedures/wifi.procedure.ts";
import {
	frameTranscript,
	wifiFrameFixture,
} from "./helpers/wifi-frame-fixture.ts";

const request = {
	device: 0,
	name: "Updated AP",
	password: "updated-password",
	channel: "auto",
};

for (const proven of [false, true]) {
	for (const outcome of ["ok", "saving", "throw"] as const) {
		test(`config ${outcome} keeps dispatch binding across replacement, proven=${proven}`, async () => {
			const fixture = await wifiFrameFixture(true, proven);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			spyOn(defaultHotspotConfigDeps, "getCapabilities").mockReturnValue(
				undefined,
			);
			spyOn(defaultHotspotConfigDeps, "nmConnSetFields").mockImplementation(
				async (...args) => {
					fixture.effects.push(args);
					entered.resolve();
					await release.promise;
					if (outcome === "throw") throw new Error("synthetic config failure");
					return outcome === "ok";
				},
			);
			spyOn(defaultHotspotConfigDeps, "nmConnect").mockResolvedValue(true);
			spyOn(
				defaultHotspotConfigDeps,
				"wifiUpdateSavedConns",
			).mockResolvedValue();
			spyOn(defaultHotspotConfigDeps, "rememberCredentials").mockImplementation(
				() => undefined,
			);
			spyOn(defaultHotspotConfigDeps, "broadcastState").mockImplementation(() =>
				fixture.effects.push("broadcast"),
			);
			try {
				handleWifi(fixture.context.ws, { hotspot: { config: request } });
				await entered.promise;
				const replacement = await fixture.rotate();
				release.resolve();
				await fixture.configReceived;
				const legacy = frameTranscript(
					`config:${outcome}:${proven}`,
					fixture,
					undefined,
				);
				const expected =
					outcome === "ok"
						? { device: 0, success: true }
						: {
								device: 0,
								error: outcome === "throw" ? "unavailable" : "saving",
							};
				expect(legacy).toEqual([
					JSON.stringify({ wifi: { hotspot: { config: expected } } }),
				]);
				expect(replacement).toEqual(expect.any(String));
				expect(replacement).not.toBe(fixture.before);
				const frame = wifiMessageSchema.parse(
					JSON.parse(fixture.frames[0] ?? "{}").wifi,
				);
				if (proven)
					expect(frame.hotspot?.config?.incarnation).toBe(fixture.before);
				else expect(frame.hotspot?.config).not.toHaveProperty("incarnation");
			} finally {
				release.resolve();
				await fixture.restore();
			}
		});
	}
}

for (const mocked of [false, true]) {
	for (const expected of [undefined, "caller-A_0"]) {
		test(`RPC config echoes captured frame metadata without changing its ack, mock=${mocked}, expected=${expected}`, async () => {
			const fixture = await wifiFrameFixture();
			if (mocked) {
				fixture.mocked(true);
				initMockService("multi-modem-wifi");
			}
			const captured =
				expected ?? (mocked ? getMockWifiIncarnation("wlan0") : fixture.before);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const original = locks.withWifiAdapterLock;
			let probe = true;
			spyOn(locks, "withWifiAdapterLock").mockImplementation(
				async <T>(
					key: locks.WifiAdapterLockKey,
					operation: () => Promise<T>,
				) => {
					if (probe) {
						probe = false;
						entered.resolve();
						await release.promise;
					}
					return original(key, operation);
				},
			);
			spyOn(defaultHotspotConfigDeps, "getCapabilities").mockReturnValue(
				undefined,
			);
			spyOn(defaultHotspotConfigDeps, "nmConnSetFields").mockImplementation(
				async (...args) => {
					fixture.effects.push(args);
					return false;
				},
			);
			try {
				const pending = call(
					hotspotConfigureProcedure,
					{
						...request,
						device: "0",
						...(expected === undefined ? {} : { incarnation: expected }),
					},
					{ context: fixture.context },
				);
				await entered.promise;
				await fixture.rotate();
				if (mocked) rebindMockWifi("wlan0");
				release.resolve();
				const result = await pending;
				await fixture.configReceived;
				const legacy = frameTranscript(
					`rpc-config:${mocked}:${expected}`,
					fixture,
					result,
				);
				expect(result).toEqual({ success: true });
				expect(legacy).toEqual([
					JSON.stringify({
						wifi: { hotspot: { config: { device: 0, error: "saving" } } },
					}),
				]);
				const frame = wifiMessageSchema.parse(
					JSON.parse(fixture.frames[0] ?? "{}").wifi,
				);
				expect(frame.hotspot?.config?.incarnation).toBe(captured);
			} finally {
				release.resolve();
				await fixture.restore();
			}
		});
	}
}

for (const [change, error] of [
	[{ name: "" }, "name"],
	[{ password: "" }, "password"],
	[{ channel: "invalid" }, "channel"],
	[{ security: "invalid" }, "security"],
] as const) {
	test(`config ${error} validation refusal carries the accepted row token`, async () => {
		const fixture = await wifiFrameFixture();
		spyOn(defaultHotspotConfigDeps, "getCapabilities").mockReturnValue(
			undefined,
		);
		try {
			await wifiHotspotConfig(fixture.context.ws, { ...request, ...change });
			const legacy = frameTranscript(
				`config-validation:${error}`,
				fixture,
				undefined,
			);
			expect(legacy).toEqual([
				JSON.stringify({ wifi: { hotspot: { config: { device: 0, error } } } }),
			]);
			const frame = wifiMessageSchema.parse(
				JSON.parse(fixture.frames[0] ?? "{}").wifi,
			);
			expect(frame.hotspot?.config?.incarnation).toBe(fixture.before);
		} finally {
			await fixture.restore();
		}
	});
}
