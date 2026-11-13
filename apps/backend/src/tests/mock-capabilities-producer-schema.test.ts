import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getCapabilitiesResultSchema } from "@ceralive/cerastream";
import { capabilitiesMessageSchema } from "@ceraui/rpc/schemas";
import { scenarios } from "../mocks/mock-config.ts";
import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import {
	getMockEngineCapabilities,
	getMockEngineDevices,
} from "../mocks/providers/streaming.ts";
import {
	clearCapabilitiesCache,
	getCapabilities,
} from "../modules/streaming/capabilities.ts";

const envKeys = ["MOCK_MODE", "MOCK_SCENARIO", "NODE_ENV"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of envKeys) savedEnv[key] = process.env[key];
	process.env.MOCK_MODE = "true";
});

afterEach(() => {
	stopMockService();
	clearCapabilitiesCache();
	for (const key of envKeys) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

describe("mock capabilities producer schema", () => {
	for (const [scenario, config] of Object.entries(scenarios)) {
		test(`${scenario} retains its capabilities through producer and RPC parsing`, async () => {
			process.env.MOCK_SCENARIO = scenario;
			initMockService(scenario);
			clearCapabilitiesCache();

			const capabilities = await getCapabilities({
				fetchEngineCapabilities: async () => {
					const snapshot = getMockEngineCapabilities();
					return {
						...snapshot,
						caps: getCapabilitiesResultSchema.parse(snapshot.caps),
					};
				},
				fetchEngineDevices: async () => getMockEngineDevices(),
			});
			const producer = getCapabilitiesResultSchema.parse(capabilities);
			const wire = capabilitiesMessageSchema.parse(capabilities);

			if (config.capabilities?.fullProfile) {
				expect(producer.encoder).toMatchObject({ default_codec: "h265" });
				expect(wire.encoder).toMatchObject({ default_codec: "h265" });
			} else {
				expect(producer.encoder).not.toHaveProperty("default_codec");
				expect(wire.encoder).not.toHaveProperty("default_codec");
			}
			expect(wire.encoder.codecs).toEqual(
				config.capabilities?.fullProfile ? ["H264", "H265"] : ["H264"],
			);
		});
	}
});
