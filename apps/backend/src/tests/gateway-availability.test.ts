import { afterEach, describe, expect, it } from "bun:test";

import {
	buildGatewayProbe,
	type NetworkIngestDeps,
	refreshNetworkIngestInfo,
	resetNetworkIngestState,
} from "../modules/network/network-ingest.ts";
import {
	isGatewayActive,
	resetGatewayProbe,
	setGatewayProbe,
} from "../modules/streaming/gateway-availability.ts";

// A real-device (non-mock) deps set with BOTH gateway units reporting active, a
// LAN IP present, and rtmp/srt offered — so the ONLY variable under test is the
// operator desired-state (`getOperatorDisabled`).
function realDeviceDeps(
	over: Partial<NetworkIngestDeps> = {},
): NetworkIngestDeps {
	return {
		isRealDevice: async () => true,
		shouldUseMocks: () => false,
		resolveMockSignals: () => ({
			rtmpUnitActive: false,
			srtUnitActive: false,
			mediamtxSrt: false,
		}),
		probeServiceActive: async () => true,
		probeMediamtxSrt: async () => false,
		getNetif: () => ({ eth0: { ip: "10.0.0.5", enabled: true } }),
		getSourceKinds: () => new Set(["rtmp", "srt"]),
		getOperatorDisabled: () => ({ rtmp: false, srt: false }),
		...over,
	};
}

describe("gateway-availability — start-eligible = unit-active AND desired-enabled (Task 7)", () => {
	afterEach(() => {
		resetNetworkIngestState();
		resetGatewayProbe();
	});

	it("active unit + operator-disabled → isActive false; the sibling (enabled) stays true", async () => {
		await refreshNetworkIngestInfo(
			realDeviceDeps({
				getOperatorDisabled: () => ({ rtmp: true, srt: false }),
			}),
		);
		const probe = buildGatewayProbe();
		// rtmp: unit active but disabled in Settings → NOT start-eligible.
		expect(probe.isActive("rtmp")).toBe(false);
		// srt: unit active + enabled → start-eligible (no regression).
		expect(probe.isActive("srt")).toBe(true);
	});

	it("active unit + enabled → isActive true (baseline, unchanged)", async () => {
		await refreshNetworkIngestInfo(realDeviceDeps());
		expect(buildGatewayProbe().isActive("rtmp")).toBe(true);
		expect(buildGatewayProbe().isActive("srt")).toBe(true);
	});

	it("isGatewayActive routes through the wired probe and honors desired-state", async () => {
		await refreshNetworkIngestInfo(
			realDeviceDeps({
				getOperatorDisabled: () => ({ rtmp: true, srt: false }),
			}),
		);
		setGatewayProbe(buildGatewayProbe());
		expect(isGatewayActive("rtmp")).toBe(false);
		expect(isGatewayActive("srt")).toBe(true);
	});
});
