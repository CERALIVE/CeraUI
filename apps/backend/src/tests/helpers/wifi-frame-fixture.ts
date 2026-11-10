import { jest, mock, spyOn } from "bun:test";
import type { WifiMessage } from "@ceraui/rpc/schemas";
import * as mocks from "../../mocks/mock-service.ts";
import { resetHotspotCredentialsForTest } from "../../modules/wifi/hotspot-credentials.ts";
import { addWifiInterface } from "../../modules/wifi/wifi-connections.ts";
import type { WifiInterfaceWithHotspot } from "../../modules/wifi/wifi-hotspot-types.ts";
import { getWifiIdToMacAddress } from "../../modules/wifi/wifi-interfaces.ts";
import { wifiRadioIdentity } from "../../modules/wifi/wifi-radio-identity.ts";
import { projectWifiRadioIncarnation } from "../../modules/wifi/wifi-radio-publication.ts";
import * as compat from "../../rpc/compat.ts";
import { wifiProtocolContext } from "./wifi-protocol-context.ts";
import type { RadioFixture } from "./wifi-radio-equivalence.ts";
import { fakeShadowSysfs } from "./wifi-radio-equivalence-shadow.ts";
import { isolateWifiRegistry, restoreWifiRegistry } from "./wifi-registry.ts";

const MAC = "dc:a6:32:aa:bb:c0";

export async function wifiFrameFixture(active = true, proven = true) {
	jest.useFakeTimers();
	jest.setSystemTime(0);
	resetHotspotCredentialsForTest();
	const registry = isolateWifiRegistry();
	const ids = getWifiIdToMacAddress();
	const previousIds = { ...ids };
	for (const key of Object.keys(ids)) delete ids[Number(key)];
	ids[0] = MAC;
	const mocking = spyOn(mocks, "shouldUseMocks").mockReturnValue(false);
	let radio: RadioFixture = {
		ifname: "wlan0",
		operational: MAC,
		permanent: MAC,
		ifindex: 10,
		phy: 1,
		state: active ? "connected" : "disconnected",
	};
	const restoreShadow = await fakeShadowSysfs(() => [radio]);
	const makeRow = (): WifiInterfaceWithHotspot => ({
		id: 0,
		ifname: "wlan0",
		hw: "Frame test radio",
		conn: active ? "test-ap" : null,
		activeMode: active ? "ap" : "infrastructure",
		available: new Map(),
		saved: {},
		savedAll: {},
		hotspot: {
			conn: "test-ap",
			name: "Original AP",
			password: "original-password",
			channel: "auto",
			availableChannels: ["auto"],
			warnings: {},
		},
	});
	let row = makeRow();
	addWifiInterface(MAC, row);
	if (proven) await wifiRadioIdentity.discover([{ ifname: row.ifname, row }]);
	const token = () =>
		projectWifiRadioIncarnation(
			row,
			wifiRadioIdentity.state.rows.get(row.ifname),
		);
	const before = token();
	if (proven && before === undefined)
		throw new Error("missing proven fixture token");
	const frames: string[] = [];
	const effects: unknown[] = [];
	const configReceived = Promise.withResolvers<void>();
	const receive = (raw: string) => {
		frames.push(raw);
		const decoded: { wifi?: WifiMessage } = JSON.parse(raw);
		if (decoded.wifi?.hotspot?.config) configReceived.resolve();
	};
	const context = wifiProtocolContext(receive);
	spyOn(compat, "broadcastMsg").mockImplementation((type, data) =>
		receive(compat.buildMsg(type, data)),
	);
	return {
		row,
		context,
		frames,
		effects,
		before,
		mocked: (value: boolean) => mocking.mockReturnValue(value),
		configReceived: configReceived.promise,
		rotate: async () => {
			radio = { ...radio, ifindex: 20, phy: 2 };
			row = makeRow();
			addWifiInterface(MAC, row);
			await wifiRadioIdentity.discover([{ ifname: row.ifname, row }]);
			return token();
		},
		restore: async () => {
			await restoreShadow();
			restoreWifiRegistry(registry);
			for (const key of Object.keys(ids)) delete ids[Number(key)];
			Object.assign(ids, previousIds);
			resetHotspotCredentialsForTest();
			mocks.stopMockService();
			mocks.resetMockState();
			mock.restore();
			jest.useRealTimers();
		},
	};
}

export function legacyFrameBytes(frames: readonly string[]): string[] {
	return frames.map((raw) => {
		const frame: { wifi?: WifiMessage } = JSON.parse(raw);
		if (frame.wifi?.adapter_mode) delete frame.wifi.adapter_mode.incarnation;
		if (frame.wifi?.hotspot?.config)
			delete frame.wifi.hotspot.config.incarnation;
		return JSON.stringify(frame);
	});
}

export function frameTranscript(
	name: string,
	fixture: Awaited<ReturnType<typeof wifiFrameFixture>>,
	result: unknown,
): string[] {
	const frames = legacyFrameBytes(fixture.frames);
	if (process.env.WIFI_FRAME_TRANSCRIPT === "1") {
		process.stdout.write(
			"WIFI_FRAME_LEGACY " +
				JSON.stringify({ name, frames, effects: fixture.effects, result }) +
				"\n",
		);
	}
	return frames;
}
