import { describe, expect, test } from "bun:test";

import {
	buildShaperPlan,
	SHAPER_CONFIG,
	type ShaperPlanInput,
} from "../modules/network/uplink-shaper/index.ts";
import { stableUplinkMark } from "../modules/network/uplink-steering/ruleset.ts";

const streaming = (cakeAvailable: boolean): ShaperPlanInput => ({
	mode: "streaming",
	cakeAvailable,
	uplinks: [
		{ ifname: "wwan0", mark: stableUplinkMark("modem-a"), capBps: 4_000_000 },
	],
});

describe("buildShaperPlan", () => {
	test("CAKE hierarchy leaves the local band uncapped and caps only marked clients", () => {
		const commands = buildShaperPlan(streaming(true)).map((command) =>
			command.argv.join(" "),
		);
		const localBand = commands.filter((line) =>
			line.includes(`parent ${SHAPER_CONFIG.rootHandle}1`),
		);

		expect(commands).toMatchSnapshot();
		expect(localBand).toHaveLength(1);
		expect(localBand[0]).not.toMatch(/\b(?:rate|ceil|police|bandwidth)\b/);
		expect(
			commands.some(
				(line) => line.includes(" fw ") && line.includes("flowid ca00:2"),
			),
		).toBe(true);
		expect(
			commands.filter((line) => line.includes("bandwidth 4000000bit")),
		).toHaveLength(1);
	});

	test("HTB fallback attaches rate and ceil only beneath the client band", () => {
		const commands = buildShaperPlan(streaming(false)).map((command) =>
			command.argv.join(" "),
		);
		const capped = commands.filter((line) =>
			/\b(?:rate|ceil|police|bandwidth)\b/.test(line),
		);

		expect(commands).toMatchSnapshot();
		expect(capped).toEqual([
			expect.stringContaining(
				"parent ca20: classid ca20:1 htb rate 4000000bit ceil 4000000bit",
			),
		]);
		expect(commands.find((line) => line.includes("parent ca00:1"))).not.toMatch(
			/\b(?:rate|ceil|police|bandwidth)\b/,
		);
	});

	test("idle installs fair queuing without a ceiling", () => {
		const commands = buildShaperPlan({
			mode: "idle",
			cakeAvailable: false,
			uplinks: [
				{
					ifname: "wwan0",
					mark: stableUplinkMark("modem-a"),
					capBps: 4_000_000,
				},
			],
		});

		expect(commands.map((command) => command.argv.join(" "))).toMatchSnapshot();
		expect(
			commands.every(
				(command) =>
					!/\b(?:rate|ceil|police|bandwidth)\b/.test(command.argv.join(" ")),
			),
		).toBe(true);
	});
});
