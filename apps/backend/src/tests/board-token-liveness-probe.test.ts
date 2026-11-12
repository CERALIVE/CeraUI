import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	evaluateLiveness,
	parsePassFile,
	publishEvidence,
	serializeEvidence,
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
		name: "a late poll whose only row is degraded fails",
		polls: [
			{
				atS: 45,
				rows: [{ ...ready, hasToken: false, degraded_reason: "unavailable" }],
			},
		],
		early: 0,
		pass: false,
	},
	{
		name: "a late poll whose only row lost hotspot support fails",
		polls: [{ atS: 45, rows: [{ ...ready, supports_hotspot: false }] }],
		early: 0,
		pass: false,
	},
	{
		name: "losing the last eligible row at one late poll fails",
		polls: [
			{ atS: 30, rows: [ready] },
			{ atS: 35, rows: [{ ...ready, degraded_reason: "unavailable" }] },
			{ atS: 40, rows: [ready] },
		],
		early: 0,
		pass: false,
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
		noEligibleRowPolls: 0,
	});
});

test("counts late polls without an eligible row", () => {
	const degraded = { ...ready, degraded_reason: "unavailable" };
	const polls: TokenPoll[] = [
		{ atS: 0, rows: [degraded] },
		{ atS: 30, rows: [degraded] },
		{ atS: 35, rows: [ready] },
	];

	expect(evaluateLiveness(polls, 0)).toMatchObject({
		pass: false,
		tokenAbsentPolls: 0,
		noEligibleRowPolls: 1,
	});
});

const stringValues = (value: unknown): string[] =>
	typeof value === "string"
		? [value]
		: value && typeof value === "object"
			? Object.values(value).flatMap(stringValues)
			: [];

const evidence = {
	recordedAt: "2026-11-12T00:00:00.000Z",
	windowS: 480,
	packageBefore: "ceralive-device 2026.11.2 true pass",
	packageAfter: "ceralive-device 2026.11.2 true pass",
	iwReg: "country 00: DFS-UNSET",
	cycles: [
		{
			kind: "cold",
			bootIdChanged: true,
			polls: [
				{ atS: 0, rows: [ready], error: "sudo rejected ssh pass  for admin" },
			],
			earlyClientTokenS: 0,
			pass: true,
			tokenFirstSeenS: 0,
			tokenAbsentPolls: 0,
			noEligibleRowPolls: 0,
			error: "login refused for pass Ui-Secret-91 at 192.0.2.10",
		},
	],
	pass: true,
};

test.each([
	{ name: "a credential equal to true", secrets: ["true"] },
	{ name: "a credential equal to 0", secrets: ["0"] },
	{ name: "a credential equal to a verdict key", secrets: ["pass"] },
	{
		name: "realistic credentials and address",
		secrets: ["Ui-Secret-91", "ssh pass ", "192.0.2.10"],
	},
])("redaction keeps verdicts intact with $name", ({ secrets }) => {
	for (const secret of secrets)
		expect(stringValues(evidence).some((value) => value.includes(secret))).toBe(
			true,
		);
	const parsed = JSON.parse(serializeEvidence(evidence, secrets));

	expect(Object.keys(parsed)).toEqual(Object.keys(evidence));
	expect(parsed.pass).toBe(true);
	expect(parsed.cycles).toHaveLength(1);
	expect(parsed.cycles[0]).toMatchObject({
		pass: true,
		tokenAbsentPolls: 0,
		noEligibleRowPolls: 0,
		bootIdChanged: true,
	});
	expect(parsed.windowS).toBe(480);
	for (const value of stringValues(parsed))
		for (const secret of secrets) expect(value).not.toContain(secret);
});

test("the result file is published owner-only and leaves no temporary file", async () => {
	const root = await mkdtemp(join(tmpdir(), "board-probe-publish-"));
	const previousUmask = process.umask(0o022);
	const signal = new AbortController().signal;
	try {
		const out = join(root, "nested", "result.json");
		await publishEvidence(out, `${out}.1.tmp`, '{"pass":true}\n', signal);
		expect((await stat(out)).mode & 0o777).toBe(0o600);
		expect(await Bun.file(out).text()).toBe('{"pass":true}\n');
		expect(await readdir(dirname(out))).toEqual(["result.json"]);

		const staleOut = join(root, "stale.json");
		const staleTemporary = `${staleOut}.2.tmp`;
		await writeFile(staleTemporary, "stale", { mode: 0o644 });
		await publishEvidence(staleOut, staleTemporary, "{}\n", signal);
		expect((await stat(staleOut)).mode & 0o777).toBe(0o600);
		expect(await Bun.file(staleOut).text()).toBe("{}\n");
		expect((await readdir(root)).sort()).toEqual(["nested", "stale.json"]);
	} finally {
		process.umask(previousUmask);
		await rm(root, { recursive: true, force: true });
	}
});

test("the SSH pass file keeps trailing spaces and drops one line ending", () => {
	expect(parsePassFile("secret \n")).toBe("secret ");
	expect(parsePassFile("secret\t\r\n")).toBe("secret\t");
	expect(parsePassFile("secret")).toBe("secret");
	expect(() => parsePassFile("\n")).toThrow();
	expect(() => parsePassFile("one\ntwo\n")).toThrow();
});
