import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import { defaultFetchEngineDevices } from "../modules/streaming/capabilities.ts";
import {
	createDeviceRegistry,
	type DeviceRegistryDeps,
} from "../modules/streaming/devices.ts";
import {
	getEngineDeviceCache,
	refreshEngineDeviceCache,
	refreshSourcesForHotplug,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";

/**
 * `main.ts` injects the scenario's `list-devices` into the capability fold and
 * the boot `sources` seed, and for a long while that was the ONLY wiring. The
 * readers that REBUILD `sources` afterwards — the hotplug refresh and the 5 s
 * signal recheck — took DEFAULT deps, i.e. a real engine socket that cannot
 * exist under `MOCK_SCENARIO`, and fell back to the registry's observation of
 * the dev HOST. So the first host-driven transition after boot reported the
 * scenario's cameras as removed and emptied `sources` for the rest of the
 * process. Nothing failed loudly: `sources` is on-change only, so the
 * coarse-only list simply stood.
 *
 * The scope of the repair is exactly that rebuild path. The device REGISTRY
 * keeps observing the host, because its scan is also `switchInput`'s
 * reachability gate: a scenario device is VISIBLE in the picker while still
 * having no engine or v4l2 node behind it, and a live switch to it must keep
 * answering SOURCE_LOST. The first attempt widened the registry too and erased
 * that divergence, which is what `tests/e2e/input-picker.spec.ts` exists to
 * prevent — hence the negative half of this lock.
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

	test("a host-driven transition rebuilds `sources` from the scenario, never from the host", async () => {
		resetEngineDeviceCache();
		await refreshEngineDeviceCache();
		expect(getEngineDeviceCache().map((d) => d.input_id)).toContain("usb");

		// What the registry sees on a dev host with no capture hardware: audio
		// cards only, and not one of the scenario's cameras.
		await refreshSourcesForHotplug([
			{
				input_id: "audio:hostmic",
				device_path: "alsa:hostmic",
				display_name: "Host mic",
				media_class: "audio",
				kind: "audio",
			},
		]);

		const ids = getEngineDeviceCache().map((d) => d.input_id);
		expect(ids).toContain("hdmi");
		expect(ids).toContain("usb");
	});
});

describe("the switch-reachability gate keeps the HOST's truth", () => {
	test("the registry scan does NOT adopt the scenario", async () => {
		const registry = createDeviceRegistry(hostlessDeps());
		const ids = (await registry.scan()).map((d) => d.input_id);
		expect(ids).not.toContain("hdmi");
		expect(ids).not.toContain("usb");
		expect(ids).toContain("audio:hostmic");
	});

	test("a live switch to a scenario-visible device with no node behind it answers SOURCE_LOST", async () => {
		const engineSwitch = mock(async () => undefined);
		const registry = createDeviceRegistry(
			// Streaming, so the engine WOULD be commanded if the gate let it through.
			hostlessDeps({ engineSwitch, isStreaming: () => true }),
		);
		expect(await registry.switchInput("usb")).toMatchObject({
			success: false,
			error: "SOURCE_LOST",
		});
		expect(engineSwitch).toHaveBeenCalledTimes(0);
	});
});
