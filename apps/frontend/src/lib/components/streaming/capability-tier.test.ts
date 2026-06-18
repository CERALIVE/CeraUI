/**
 * capability-tier — tier→UI-state mapping (Task 9).
 *
 * Locks the pure collapse of the three optional `capabilitiesMessageSchema` tier
 * flags onto ONE discriminated UI state, plus the presentation contract each
 * tier resolves to. This is the testable seam the banner + control-gating render
 * from, so the mapping (normal / engineStarting / engineUnavailable /
 * schemaVersionMismatch) is asserted here without a DOM or a locale.
 */
import type { CapabilitiesMessage } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	type CapabilityTier,
	capabilityTier,
	capabilityTierView,
	capabilityTierViewFor,
} from "./capability-tier";

// A minimal schema-valid caps snapshot; spread tier flags over it per case.
function caps(
	overrides: Partial<CapabilitiesMessage> = {},
): CapabilitiesMessage {
	return {
		platform: {
			supports_h265: true,
			hardware_accelerated: true,
			max_resolution: "2160p",
		},
		encoder: {
			codecs: ["video/x-h264"],
			bitrate_range: { min: 500, max: 50000, unit: "kbps" },
		},
		sources: [],
		...overrides,
	};
}

describe("capabilityTier", () => {
	it("maps an absent snapshot to normal", () => {
		expect(capabilityTier(undefined)).toBe("normal");
	});

	it("maps a clean snapshot (no tier flags) to normal", () => {
		expect(capabilityTier(caps())).toBe("normal");
	});

	it("maps engineUnavailable", () => {
		expect(capabilityTier(caps({ engineUnavailable: true }))).toBe(
			"engineUnavailable",
		);
	});

	it("maps engineStarting", () => {
		expect(capabilityTier(caps({ engineStarting: true }))).toBe(
			"engineStarting",
		);
	});

	it("maps schemaVersionMismatch", () => {
		expect(capabilityTier(caps({ schemaVersionMismatch: true }))).toBe(
			"schemaVersionMismatch",
		);
	});

	it("ignores tier flags explicitly set to false (back-compat default)", () => {
		expect(
			capabilityTier(
				caps({
					engineUnavailable: false,
					engineStarting: false,
					schemaVersionMismatch: false,
				}),
			),
		).toBe("normal");
	});

	it("prioritises engineUnavailable over the lower tiers", () => {
		expect(
			capabilityTier(
				caps({
					engineUnavailable: true,
					engineStarting: true,
					schemaVersionMismatch: true,
				}),
			),
		).toBe("engineUnavailable");
	});

	it("prioritises engineStarting over schemaVersionMismatch", () => {
		expect(
			capabilityTier(
				caps({ engineStarting: true, schemaVersionMismatch: true }),
			),
		).toBe("engineStarting");
	});
});

describe("capabilityTierView", () => {
	it("normal renders no banner and locks nothing", () => {
		const view = capabilityTierView("normal");
		expect(view.visible).toBe(false);
		expect(view.role).toBeNull();
		expect(view.disablesControls).toBe(false);
		expect(view.showsSkeleton).toBe(false);
	});

	it("engineUnavailable is a calm status banner that locks controls", () => {
		const view = capabilityTierView("engineUnavailable");
		expect(view.visible).toBe(true);
		expect(view.role).toBe("status");
		expect(view.disablesControls).toBe(true);
		expect(view.showsSkeleton).toBe(false);
		expect(view.testId).toBe("capability-engine-unavailable");
	});

	it("engineStarting shows a skeleton and locks controls", () => {
		const view = capabilityTierView("engineStarting");
		expect(view.visible).toBe(true);
		expect(view.role).toBe("status");
		expect(view.disablesControls).toBe(true);
		expect(view.showsSkeleton).toBe(true);
		expect(view.testId).toBe("capability-engine-starting");
	});

	it("schemaVersionMismatch is informational only (never locks controls)", () => {
		const view = capabilityTierView("schemaVersionMismatch");
		expect(view.visible).toBe(true);
		expect(view.role).toBe("status");
		expect(view.disablesControls).toBe(false);
		expect(view.showsSkeleton).toBe(false);
		expect(view.testId).toBe("capability-schema-mismatch");
	});

	it("no visible tier is ever an alert (calm, instrument-clarity tone)", () => {
		const tiers: CapabilityTier[] = [
			"engineUnavailable",
			"engineStarting",
			"schemaVersionMismatch",
		];
		for (const tier of tiers) {
			expect(capabilityTierView(tier).role).toBe("status");
		}
	});
});

describe("capabilityTierViewFor", () => {
	it("resolves a snapshot straight to its presentation contract", () => {
		expect(capabilityTierViewFor(caps({ engineStarting: true }))).toEqual(
			capabilityTierView("engineStarting"),
		);
		expect(capabilityTierViewFor(undefined)).toEqual(
			capabilityTierView("normal"),
		);
	});
});
