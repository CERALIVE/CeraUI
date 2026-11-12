import { expect, test } from "bun:test";
import {
	evaluateLiveness,
	type TokenPoll,
} from "../../test-harness/board-gates/token-liveness.ts";

const ready = {
	ifname: "wlan0",
	hasToken: true,
	degraded_reason: null,
	supports_hotspot: true,
};

test.each([
	{
		name: "a token-less hotspot-capable row at 45 seconds fails",
		polls: [{ atS: 45, rows: [{ ...ready, hasToken: false }] }],
		early: 0,
		pass: false,
	},
	{
		name: "one missing token fails even when another radio is ready",
		polls: [
			{
				atS: 45,
				rows: [ready, { ...ready, ifname: "wlan1", hasToken: false }],
			},
		],
		early: 0,
		pass: false,
	},
	{
		name: "the 30 second deadline is inclusive",
		polls: [{ atS: 30, rows: [{ ...ready, hasToken: false }] }],
		early: 0,
		pass: false,
	},
	{
		name: "a missing token before the deadline may recover",
		polls: [
			{ atS: 25, rows: [{ ...ready, hasToken: false }] },
			{ atS: 30, rows: [ready] },
		],
		early: 28,
		pass: true,
	},
	{
		name: "degraded and non-hotspot rows do not require tokens",
		polls: [
			{
				atS: 45,
				rows: [
					ready,
					{
						...ready,
						ifname: "wlan1",
						hasToken: false,
						degraded_reason: "unavailable",
					},
					{
						...ready,
						ifname: "wlan2",
						hasToken: false,
						supports_hotspot: false,
					},
				],
			},
		],
		early: 0,
		pass: true,
	},
	{
		name: "fresh clients cannot substitute for the early client",
		polls: [{ atS: 45, rows: [ready] }],
		early: null,
		pass: false,
	},
	{
		name: "no polls cannot pass",
		polls: [],
		early: 0,
		pass: false,
	},
	{
		name: "an empty late snapshot cannot prove radio liveness",
		polls: [{ atS: 45, rows: [] }],
		early: 0,
		pass: false,
	},
	{
		name: "a failed late poll cannot pass",
		polls: [{ atS: 45, rows: [], error: "socket-timeout" }],
		early: 0,
		pass: false,
	},
	{
		name: "a window ending before the deadline cannot pass",
		polls: [{ atS: 25, rows: [ready] }],
		early: 0,
		pass: false,
	},
] satisfies ReadonlyArray<{
	name: string;
	polls: readonly TokenPoll[];
	early: number | null;
	pass: boolean;
}>)("$name", ({ polls, early, pass }) => {
	expect(evaluateLiveness(polls, early).pass).toBe(pass);
});

test("counts absent polls after the deadline and records recovery time", () => {
	const polls: TokenPoll[] = [
		{ atS: 0, rows: [{ ...ready, hasToken: false }] },
		{ atS: 30, rows: [{ ...ready, hasToken: false }] },
		{ atS: 45, rows: [{ ...ready, hasToken: false }] },
		{ atS: 50, rows: [ready] },
	];

	expect(evaluateLiveness(polls, 50)).toEqual({
		pass: false,
		tokenFirstSeenS: 50,
		tokenAbsentPolls: 2,
	});
});
