import { expect, spyOn, test } from "bun:test";
import { acquireRuntimeOsStageControl } from "../modules/system/update-orchestrator/os-runtime-control.ts";
import * as control from "../modules/system/update-orchestrator/os-stage-control-lease.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";

const deviceTypes = [undefined, "emulated", "real", "unknown"] as const;
const nodeEnvs = [undefined, "development", "production", "test"] as const;
const mockModes = [undefined, "true", "false"] as const;

for (const deviceType of deviceTypes) {
	for (const nodeEnv of nodeEnvs) {
		for (const mockMode of mockModes) {
			test(`runtime acquires the production lease with device=${deviceType}, env=${nodeEnv}, mock=${mockMode}`, async () => {
				// Given each environment selector read by device detection, with a
				// spy at the kernel-lease boundary rather than a runtime override.
				const previous = {
					CERALIVE_DEVICE_TYPE: process.env.CERALIVE_DEVICE_TYPE,
					NODE_ENV: process.env.NODE_ENV,
					MOCK_MODE: process.env.MOCK_MODE,
				};
				const lease = await acquireTestOsStageControl();
				const acquire = spyOn(
					control,
					"acquireOsStageControlLease",
				).mockResolvedValue(lease);
				try {
					for (const [key, value] of Object.entries({
						CERALIVE_DEVICE_TYPE: deviceType,
						NODE_ENV: nodeEnv,
						MOCK_MODE: mockMode,
					})) {
						if (value === undefined) delete process.env[key];
						else process.env[key] = value;
					}
					// When production selection is used without injected runtime deps.
					await using selected = await acquireRuntimeOsStageControl();
					// Then environment classification cannot substitute a held no-op.
					expect(acquire).toHaveBeenCalledTimes(1);
					expect(selected).toBe(lease);
				} finally {
					acquire.mockRestore();
					for (const [key, value] of Object.entries(previous)) {
						if (value === undefined) delete process.env[key];
						else process.env[key] = value;
					}
				}
			});
		}
	}
}

test("runtime preserves explicitly injected lease ownership and disposal", async () => {
	// Given an explicitly injected hermetic lease.
	const lease = await acquireTestOsStageControl();
	// When the selected lease leaves its owning scope.
	{
		await using selected = await acquireRuntimeOsStageControl(
			async () => lease,
		);
		expect(selected).toBe(lease);
		expect(selected.held()).toBe(true);
	}
	// Then the fixture models release rather than a permanently held lease.
	expect(lease.held()).toBe(false);
});
