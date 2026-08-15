import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import { defaultFetchEngineDevices } from "../modules/streaming/capabilities.ts";
import {
	createDeviceRegistry,
	type DeviceRegistryDeps,
} from "../modules/streaming/devices.ts";

/**
 * `main.ts` injects the scenario's `list-devices` into the capability fold and
 * the boot `sources` seed, and for a long while that was the ONLY wiring. Every
 * other reader — the device registry's own poll, the hotplug refresh it fires,
 * the 5 s signal recheck — took DEFAULT deps, i.e. a real engine socket that
 * cannot exist under `MOCK_SCENARIO`. Each of those falls back to the dev HOST's
 * hardware, which is not what the scenario describes, so the first poll after
 * boot reported the scenario's cameras as removed and emptied `sources` for the
 * rest of the process. Nothing failed loudly: `sources` is on-change only, so
 * the coarse-only list simply stood.
 */

const ENV_KEYS = ["MOCK_MODE", "MOCK_SCENARIO", "NODE_ENV"] as const;
const savedEnv: Record<string, string | undefined> = {};

// A dev host with no capture hardware of its own, so anything the registry
// reports has to have come from the scenario.
function hostlessDeps(
	overrides: Partial<DeviceRegistryDeps> = {},
): Partial<DeviceRegistryDeps> {
	return {
		listVideoCards: async () => [],
		readCardName: async () => undefined,
		getAudioSources: () => ({ "Host mic": "hostmic" }),
		getEngine: () => "cerastream",
		isStreaming: () => false,
		engineSwitch: async () => undefined,
		getSelectedVideoInput: () => undefined,
		clearSelectedVideoInput: () => undefined,
		getRememberedDeviceKind: () => undefined,
		notify: () => undefined,
		broadcast: () => undefined,
		reportActiveVideoSource: () => undefined,
		now: () => 0,
		logger: { debug() {}, warn() {}, error() {} },
		...overrides,
	};
}

beforeEach(() => {
	for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
	process.env.MOCK_MODE = "true";
	process.env.MOCK_SCENARIO = "multi-modem-wifi";
	initMockService("multi-modem-wifi");
});

afterEach(() => {
	stopMockService();
	for (const k of ENV_KEYS) {
		const v = savedEnv[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("mock scenario devices reach the DEFAULT-deps readers", () => {
	test("defaultFetchEngineDevices serves the scenario instead of probing a socket that cannot exist", async () => {
		const ids = (await defaultFetchEngineDevices()).devices.map(
			(d) => d.input_id,
		);
		expect(ids).toContain("hdmi");
		expect(ids).toContain("usb");
	});

	test("the device registry observes the scenario, not the dev host", async () => {
		const registry = createDeviceRegistry(hostlessDeps());
		const ids = (await registry.scan()).map((d) => d.input_id);
		expect(ids).toContain("hdmi");
		expect(ids).toContain("usb");
		expect(ids).not.toContain("audio:hostmic");
	});

	test("a steady scenario never fires a hotplug transition", async () => {
		const onDevicesChanged = mock(() => undefined);
		const registry = createDeviceRegistry(hostlessDeps({ onDevicesChanged }));
		await registry.rescan();
		await registry.rescan();
		await registry.rescan();
		expect(onDevicesChanged).toHaveBeenCalledTimes(0);
	});
});
