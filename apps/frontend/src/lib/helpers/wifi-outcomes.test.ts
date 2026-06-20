import { describe, expect, it } from "vitest";

import {
	deriveWifiDisconnectOutcome,
	deriveWifiForgetOutcome,
} from "./wifi-outcomes";

describe("deriveWifiDisconnectOutcome", () => {
	it("confirms when the interface is gone entirely", () => {
		expect(deriveWifiDisconnectOutcome(undefined, "uuid-1")).toBe("confirmed");
	});

	it("confirms when the active connection is no longer the target", () => {
		expect(
			deriveWifiDisconnectOutcome(
				{ conn: "uuid-other", available: [{ active: true }] },
				"uuid-1",
			),
		).toBe("confirmed");
	});

	it("stays pending while the target is still the active connection", () => {
		expect(
			deriveWifiDisconnectOutcome(
				{ conn: "uuid-1", available: [{ active: true }, { active: false }] },
				"uuid-1",
			),
		).toBe("pending");
	});

	it("confirms when the target connection has no active network", () => {
		expect(
			deriveWifiDisconnectOutcome(
				{ conn: "uuid-1", available: [{ active: false }] },
				"uuid-1",
			),
		).toBe("confirmed");
	});

	it("confirms when there are no scanned networks at all", () => {
		expect(
			deriveWifiDisconnectOutcome({ conn: "uuid-1", available: [] }, "uuid-1"),
		).toBe("confirmed");
	});

	it("confirms when the available list is absent", () => {
		expect(deriveWifiDisconnectOutcome({ conn: "uuid-1" }, "uuid-1")).toBe(
			"confirmed",
		);
	});
});

describe("deriveWifiForgetOutcome", () => {
	it("confirms when there is no saved map", () => {
		expect(deriveWifiForgetOutcome(undefined, "uuid-1")).toBe("confirmed");
	});

	it("confirms when the saved map is empty", () => {
		expect(deriveWifiForgetOutcome({}, "uuid-1")).toBe("confirmed");
	});

	it("stays pending while the uuid is still saved", () => {
		expect(
			deriveWifiForgetOutcome({ HomeNet: "uuid-1", Cafe: "uuid-2" }, "uuid-1"),
		).toBe("pending");
	});

	it("confirms once the uuid is no longer among the saved values", () => {
		expect(deriveWifiForgetOutcome({ Cafe: "uuid-2" }, "uuid-1")).toBe(
			"confirmed",
		);
	});
});
