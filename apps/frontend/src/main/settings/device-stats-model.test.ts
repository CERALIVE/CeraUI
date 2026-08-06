/**
 * The device-stats signal model — the part that makes "add a signal" cheap.
 *
 * The point of the tier is that the CONTAINER stops caring how many signals
 * there are: a new one is one entry with a tier, and it lands in the right place
 * without touching the markup. These assertions pin that plus the placeholder
 * contract (`null` survives the partition untouched — the section, not the
 * model, decides what an unavailable value looks like).
 */
import type { Component } from "svelte";
import { describe, expect, it } from "vitest";

import { type DeviceStatSignal, partitionSignals } from "./device-stats-model";

const ICON = (() => null) as unknown as Component;

function signal(
	key: string,
	tier: DeviceStatSignal["tier"],
	extra: Partial<DeviceStatSignal> = {},
): DeviceStatSignal {
	return { key, icon: ICON, label: key, value: key, tier, ...extra };
}

describe("partitionSignals", () => {
	it("splits by tier", () => {
		const { primary, secondary } = partitionSignals([
			signal("socTemp", "primary"),
			signal("network", "secondary"),
			signal("fan", "primary"),
			signal("bootSlot", "secondary"),
		]);
		expect(primary.map((s) => s.key)).toEqual(["socTemp", "fan"]);
		expect(secondary.map((s) => s.key)).toEqual(["network", "bootSlot"]);
	});

	it("preserves declaration order within a tier — placement is pinned in the model, not the markup", () => {
		const { primary } = partitionSignals([
			signal("socTemp", "primary"),
			signal("cpuLoad", "primary"),
			signal("fan", "primary"),
			signal("disk", "primary"),
		]);
		expect(primary.map((s) => s.key)).toEqual([
			"socTemp",
			"cpuLoad",
			"fan",
			"disk",
		]);
	});

	it("passes a null value through untouched — the placeholder is the section's job", () => {
		const { primary } = partitionSignals([
			signal("socTemp", "primary", { value: null }),
		]);
		expect(primary[0]?.value).toBeNull();
	});

	it("carries the optional fraction and attrs verbatim", () => {
		const { primary } = partitionSignals([
			signal("fan", "primary", {
				fraction: 0.47,
				attrs: { "data-fan-state": "running" },
			}),
			signal("socTemp", "primary"),
		]);
		expect(primary[0]?.fraction).toBe(0.47);
		expect(primary[0]?.attrs).toEqual({ "data-fan-state": "running" });
		// A signal with no real 0-100 denominator carries none — a bar there
		// would fabricate a scale (SoC temp and a load average both qualify).
		expect(primary[1]?.fraction).toBeUndefined();
	});

	it("carries a body snippet and fullWidth verbatim — a signal that is not one figure", () => {
		const body = (() => null) as unknown as DeviceStatSignal["body"];
		const { primary } = partitionSignals([
			signal("encoder", "primary", { value: null, body, fullWidth: true }),
		]);
		expect(primary[0]?.body).toBe(body);
		expect(primary[0]?.fullWidth).toBe(true);
		// `value` stays null: the section renders the body INSTEAD, and must never
		// fall through to the placeholder for a signal that has its own rendering.
		expect(primary[0]?.value).toBeNull();
	});

	it("an empty input yields two empty tiers, never undefined", () => {
		expect(partitionSignals([])).toEqual({ primary: [], secondary: [] });
	});

	it("a single-tier input leaves the other tier empty so the disclosure can hide", () => {
		const { primary, secondary } = partitionSignals([
			signal("socTemp", "primary"),
		]);
		expect(primary).toHaveLength(1);
		expect(secondary).toHaveLength(0);
	});
});
