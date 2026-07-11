import { describe, expect, it } from "vitest";

import { requireAppliedConfig } from "./host-contract";

describe("requireAppliedConfig", () => {
	it("accepts an applied host command", () => {
		expect(() =>
			requireAppliedConfig({ success: true, applied: {} }),
		).not.toThrow();
	});

	it("surfaces the host error from a refused command", () => {
		expect(() =>
			requireAppliedConfig({ success: false, error: "device_offline" }),
		).toThrow("device_offline");
	});
});
