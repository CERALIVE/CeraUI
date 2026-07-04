import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
	refreshNetworkIngestInfo,
	resetNetworkIngestState,
} from "../modules/network/network-ingest.ts";
import { setup } from "../modules/setup.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";

const LAN = "192.168.1.100";

describe("buildInitialStatus — network_ingest snapshot completeness", () => {
	// buildInitialStatus() fires getSshStatus(), which rejects on a malformed
	// setup.ssh_user a sibling test file may have left in the shared setup object.
	// Clear it so the snapshot build is not derailed by unrelated cross-file state.
	let savedSshUser: string | undefined;
	beforeAll(() => {
		savedSshUser = setup.ssh_user;
		setup.ssh_user = undefined;
	});
	afterAll(() => {
		setup.ssh_user = savedSshUser;
		resetNetworkIngestState();
	});

	test("the post-login snapshot carries network_ingest with the active gateways", async () => {
		// Fully-explicit deps so the cached snapshot is deterministic regardless of
		// any global MOCK_MODE / mock-state a sibling test file left behind.
		await refreshNetworkIngestInfo({
			isRealDevice: async () => true,
			shouldUseMocks: () => false,
			resolveMockSignals: () => ({
				rtmpUnitActive: true,
				srtUnitActive: true,
				mediamtxSrt: false,
			}),
			probeServiceActive: async () => true,
			probeMediamtxSrt: async () => false,
			getNetif: () => ({ eth0: { ip: LAN, enabled: true } }),
			getSourceKinds: () => new Set(["rtmp", "srt"]),
		});

		const snapshot = buildInitialStatus();
		expect(snapshot.status).toHaveProperty("network_ingest");
		expect(snapshot.status.network_ingest).toEqual({
			rtmp: {
				service_active: true,
				url: "rtmp://192.168.1.100:1935/publish/live",
			},
			srt: {
				service_active: true,
				url: "srt://192.168.1.100:4001",
				gateway: "srt-live-transmit",
			},
		});
	});
});
