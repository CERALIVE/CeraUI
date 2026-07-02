import { afterEach, describe, expect, mock, test } from "bun:test";

import {
	initMockService,
	resetMockState,
	stopMockService,
} from "../mocks/mock-service.ts";
import { setMockNetworkIngestActive } from "../mocks/providers/network-ingest.ts";
import { withDeviceType } from "../modules/system/device-detection.ts";
import {
	buildGatewayProbe,
	buildRtmpUrl,
	buildSrtUrl,
	capabilitySourceKinds,
	defaultNetworkIngestDeps,
	deriveNetworkIngestInfo,
	getNetworkIngestInfo,
	type NetworkIngestDeps,
	refreshNetworkIngestInfo,
	resetNetworkIngestState,
	resolvePrimaryLanIp,
	RTMP_GATEWAY_UNIT,
	SRT_GATEWAY_UNIT,
} from "../modules/network/network-ingest.ts";

const LAN = "192.168.1.100";

function deps(overrides: Partial<NetworkIngestDeps> = {}): NetworkIngestDeps {
	return { ...defaultNetworkIngestDeps, ...overrides };
}

afterEach(() => {
	resetNetworkIngestState();
});

describe("network-ingest — URL derivation (pure)", () => {
	test("buildRtmpUrl targets the MediaMTX publish/live path on :1935", () => {
		expect(buildRtmpUrl(LAN)).toBe("rtmp://192.168.1.100:1935/publish/live");
	});

	test("buildSrtUrl targets the srt-live-transmit listener on :4001", () => {
		expect(buildSrtUrl(LAN)).toBe("srt://192.168.1.100:4001");
	});

	test("the exact baked-in unit names are pinned", () => {
		expect(RTMP_GATEWAY_UNIT).toBe("ceralive-rtmp-gateway.service");
		expect(SRT_GATEWAY_UNIT).toBe("ceralive-srt-gateway.service");
	});
});

describe("network-ingest — primary LAN IP resolution (pure)", () => {
	test("prefers a wired ethernet interface over modems/wifi", () => {
		const ip = resolvePrimaryLanIp({
			usb0: { ip: "10.0.0.2", enabled: true },
			wlan0: { ip: "192.168.2.100", enabled: true },
			eth0: { ip: "192.168.1.100", enabled: true },
		});
		expect(ip).toBe("192.168.1.100");
	});

	test("falls back to a non-modem, non-wifi interface when no ethernet", () => {
		const ip = resolvePrimaryLanIp({
			usb0: { ip: "10.0.0.2", enabled: true },
			br0: { ip: "192.168.9.1", enabled: true },
		});
		expect(ip).toBe("192.168.9.1");
	});

	test("ignores disabled, addressless, loopback, modem and wifi interfaces", () => {
		expect(
			resolvePrimaryLanIp({
				lo: { ip: "127.0.0.1", enabled: true },
				eth1: { ip: undefined, enabled: true },
				eth2: { ip: "192.168.1.50", enabled: false },
				usb0: { ip: "10.0.0.2", enabled: true },
				wlan0: { ip: "192.168.2.100", enabled: true },
			}),
		).toBeUndefined();
	});
});

describe("network-ingest — capability filtering (pure)", () => {
	test("capabilitySourceKinds reads the source ids from a caps snapshot", () => {
		const kinds = capabilitySourceKinds({
			sources: [{ id: "hdmi" }, { id: "rtmp" }, { id: "srt" }],
		});
		expect([...kinds].sort()).toEqual(["hdmi", "rtmp", "srt"]);
	});

	test("both offered → both protocols carry service_active + LAN url", () => {
		const info = deriveNetworkIngestInfo({
			lanIp: LAN,
			rtmpActive: true,
			srtActive: true,
			sourceKinds: new Set(["hdmi", "rtmp", "srt"]),
		});
		expect(info).toEqual({
			rtmp: { service_active: true, url: "rtmp://192.168.1.100:1935/publish/live" },
			srt: { service_active: true, url: "srt://192.168.1.100:4001" },
		});
	});

	test("a board profile without the srt source → srt: null (N100 case)", () => {
		const info = deriveNetworkIngestInfo({
			lanIp: LAN,
			rtmpActive: true,
			srtActive: false,
			sourceKinds: new Set(["hdmi", "rtmp"]),
		});
		expect(info.rtmp).toEqual({
			service_active: true,
			url: "rtmp://192.168.1.100:1935/publish/live",
		});
		expect(info.srt).toBeNull();
	});

	test("no resolvable LAN IP → both null (no advertisable url)", () => {
		const info = deriveNetworkIngestInfo({
			lanIp: undefined,
			rtmpActive: true,
			srtActive: true,
			sourceKinds: new Set(["rtmp", "srt"]),
		});
		expect(info).toEqual({ rtmp: null, srt: null });
	});
});

describe("network-ingest — refresh gate (isRealDevice-gated probe)", () => {
	test("real device probes BOTH exact unit names and caches the result", async () => {
		const probed: string[] = [];
		const probe = mock(async (unit: string) => {
			probed.push(unit);
			return unit === RTMP_GATEWAY_UNIT;
		});
		const info = await refreshNetworkIngestInfo(
			deps({
				isRealDevice: async () => true,
				shouldUseMocks: () => false,
				probeServiceActive: probe,
				getNetif: () => ({ eth0: { ip: LAN, enabled: true } }),
				getSourceKinds: () => new Set(["rtmp", "srt"]),
			}),
		);
		expect(probed.sort()).toEqual(
			[RTMP_GATEWAY_UNIT, SRT_GATEWAY_UNIT].sort(),
		);
		expect(info.rtmp?.service_active).toBe(true);
		expect(info.srt?.service_active).toBe(false);
		expect(getNetworkIngestInfo()).toEqual(info);
	});

	test("withDeviceType('emulated') → probe is a no-op, snapshot stays null", async () => {
		await withDeviceType("emulated", async () => {
			const probe = mock(async () => true);
			const info = await refreshNetworkIngestInfo(
				deps({
					shouldUseMocks: () => false,
					probeServiceActive: probe,
					getNetif: () => ({ eth0: { ip: LAN, enabled: true } }),
					getSourceKinds: () => new Set(["rtmp", "srt"]),
				}),
			);
			expect(probe).not.toHaveBeenCalled();
			expect(info).toEqual({ rtmp: null, srt: null });
		});
	});

	test("mock mode drives service_active from the mock provider (no probe spawn)", async () => {
		const probe = mock(async () => true);
		const info = await refreshNetworkIngestInfo(
			deps({
				shouldUseMocks: () => true,
				resolveMockActive: () => ({ rtmp: true, srt: false }),
				probeServiceActive: probe,
				getNetif: () => ({ eth0: { ip: LAN, enabled: true } }),
				getSourceKinds: () => new Set(["rtmp", "srt"]),
			}),
		);
		expect(probe).not.toHaveBeenCalled();
		expect(info.rtmp).toEqual({
			service_active: true,
			url: "rtmp://192.168.1.100:1935/publish/live",
		});
		expect(info.srt).toEqual({
			service_active: false,
			url: "srt://192.168.1.100:4001",
		});
	});
});

describe("network-ingest — GatewayProbe (Todo 17 seam, synchronous)", () => {
	test("isActive reads the cached snapshot per kind", async () => {
		await refreshNetworkIngestInfo(
			deps({
				isRealDevice: async () => true,
				shouldUseMocks: () => false,
				probeServiceActive: async (unit) => unit === RTMP_GATEWAY_UNIT,
				getNetif: () => ({ eth0: { ip: LAN, enabled: true } }),
				getSourceKinds: () => new Set(["rtmp", "srt"]),
			}),
		);
		const probe = buildGatewayProbe();
		expect(probe.isActive("rtmp")).toBe(true);
		expect(probe.isActive("srt")).toBe(false);
	});

	test("a null (capability-excluded) protocol reports inactive", async () => {
		await refreshNetworkIngestInfo(
			deps({
				isRealDevice: async () => true,
				shouldUseMocks: () => false,
				probeServiceActive: async () => true,
				getNetif: () => ({ eth0: { ip: LAN, enabled: true } }),
				getSourceKinds: () => new Set(["rtmp"]),
			}),
		);
		expect(buildGatewayProbe().isActive("srt")).toBe(false);
	});
});

describe("network-ingest — live mock provider + state slot", () => {
	const savedMockMode = process.env.MOCK_MODE;
	const savedNodeEnv = process.env.NODE_ENV;

	afterEach(() => {
		resetMockState();
		stopMockService();
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
		if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = savedNodeEnv;
	});

	test("dev scenarios expose active gateways by default; the setter flips one", async () => {
		process.env.MOCK_MODE = "true";
		initMockService("multi-modem-wifi");

		const liveMockDeps = deps({
			getNetif: () => ({ eth0: { ip: LAN, enabled: true } }),
			getSourceKinds: () => new Set(["rtmp", "srt"]),
		});

		const base = await refreshNetworkIngestInfo(liveMockDeps);
		expect(base.rtmp).toEqual({
			service_active: true,
			url: "rtmp://192.168.1.100:1935/publish/live",
		});
		expect(base.srt?.service_active).toBe(true);

		setMockNetworkIngestActive("srt", false);
		const flipped = await refreshNetworkIngestInfo(liveMockDeps);
		expect(flipped.rtmp?.service_active).toBe(true);
		expect(flipped.srt?.service_active).toBe(false);
	});
});
