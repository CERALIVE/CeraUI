/**
 * Fan status — four states, and the two collapses that are never allowed.
 *
 * `absent` (this board provably has no controllable fan) must never read as
 * `unknown` (we could not find out), and a MEASURED zero must never read as
 * either. A snapshot that has not arrived is `unknown` — silence from an
 * `isRealDevice()`-gated collector says nothing about the hardware.
 */
import type { FanReading } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { deriveFanState, fanDutyFraction } from "./fan-status";

describe("deriveFanState", () => {
	it.each<[string, FanReading | undefined, string]>([
		["no snapshot yet (dev host, or pre-first-tick)", undefined, "unknown"],
		["present but unreadable this tick", { state: "unknown" }, "unknown"],
		[
			"a measured zero is a real reading",
			{ state: "off", dutyPercent: 0 },
			"off",
		],
		["driven above zero", { state: "running", dutyPercent: 47.1 }, "running"],
		["no pwm-fan cooling device on this board", { state: "absent" }, "absent"],
	])("%s", (_label, reading, expected) => {
		expect(deriveFanState(reading)).toBe(expected);
	});

	it("absent and unknown are never the same answer", () => {
		expect(deriveFanState({ state: "absent" })).not.toBe(
			deriveFanState(undefined),
		);
	});
});

describe("fanDutyFraction", () => {
	it.each<[string, FanReading | undefined, number | null]>([
		["no snapshot ⇒ no bar", undefined, null],
		["unknown ⇒ no bar", { state: "unknown" }, null],
		["absent ⇒ no bar (there is no denominator)", { state: "absent" }, null],
		[
			"off ⇒ an EMPTY bar, not an absent one",
			{ state: "off", dutyPercent: 0 },
			0,
		],
		["running", { state: "running", dutyPercent: 47.1 }, 0.471],
		["full scale", { state: "running", dutyPercent: 100 }, 1],
	])("%s", (_label, reading, expected) => {
		const fraction = fanDutyFraction(reading);
		if (expected === null) expect(fraction).toBeNull();
		else expect(fraction).toBeCloseTo(expected, 5);
	});

	it("clamps to 0-1 so a malformed reading cannot overdraw the track", () => {
		expect(fanDutyFraction({ state: "running", dutyPercent: 140 })).toBe(1);
	});
});

describe("no speed is ever derived", () => {
	it("exposes no helper that could name or infer one", () => {
		const surface = [deriveFanState.name, fanDutyFraction.name].join(" ");
		expect(surface).not.toMatch(/\br\.?p\.?m\b|speed|revolutions/i);
	});
});
