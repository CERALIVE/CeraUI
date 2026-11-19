/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import {
	LOG_LEVELS,
	LOG_SOURCES,
	type LogFilter,
	type LogLevel,
	logFilterSchema,
	logQueryInputSchema,
} from "@ceraui/rpc/schemas";
import { compileFilter } from "../modules/device-logs/filter.ts";
import units from "./fixtures/device-log-sources.json";

const notice = "MESSAGE_ID=a596d6fe7bfa4994828e72309e95d61e";
const levelPriorities: Record<LogLevel, number[]> = {
	error: [0, 1, 2, 3],
	warning: [4],
	info: [5, 6],
	debug: [7],
};
const networkAndKernel = {
	sources: ["network", "kernel"],
	levels: ["error", "warning"],
} satisfies LogFilter;
// The golden is JSONL: each row carries its inputs and the matches placed after "--".
const goldenCases: {
	name: string;
	filter: LogFilter;
	bootId: string | null;
}[] = [
	{ name: "defaults", filter: {}, bootId: "b" },
	{ name: "all boots", filter: {}, bootId: null },
	{
		name: "network or kernel warnings",
		filter: networkAndKernel,
		bootId: "b",
	},
	...LOG_SOURCES.map((source) => ({
		name: source,
		filter: { sources: [source] },
		bootId: "b",
	})),
	...LOG_LEVELS.map((level) => ({
		name: level,
		filter: { levels: [level] },
		bootId: null,
	})),
];

describe("journal field group algebra", () => {
	test("default scope is only the boot term", () => {
		expect(compileFilter({}, { bootId: "b" })).toStrictEqual({
			matches: ["_BOOT_ID=b"],
			residual: {},
		});
		expect(compileFilter({}, { bootId: null })).toStrictEqual({
			matches: [],
			residual: {},
		});
	});

	test("network and kernel repeat priorities and boot; suppression bypasses severity", () => {
		expect(compileFilter(networkAndKernel, { bootId: "b" })).toStrictEqual({
			matches: [
				"_BOOT_ID=b",
				"PRIORITY=0",
				"PRIORITY=1",
				"PRIORITY=2",
				"PRIORITY=3",
				"PRIORITY=4",
				"_SYSTEMD_UNIT=NetworkManager.service",
				"_SYSTEMD_UNIT=wpa_supplicant.service",
				"_SYSTEMD_UNIT=ceralive-share.service",
				"_SYSTEMD_UNIT=ceralive-ingest-firewall.service",
				"_SYSTEMD_UNIT=ceralive-rtmp-gateway.service",
				"+",
				"_BOOT_ID=b",
				"PRIORITY=0",
				"PRIORITY=1",
				"PRIORITY=2",
				"PRIORITY=3",
				"PRIORITY=4",
				"_TRANSPORT=kernel",
				"+",
				"_BOOT_ID=b",
				notice,
			],
			residual: {},
		});
	});

	test("every source subset and nonempty level subset has the required OR groups", () => {
		for (let sourceMask = 0; sourceMask < 256; sourceMask++) {
			const sources = LOG_SOURCES.filter(
				(_, index) => sourceMask & (1 << index),
			);
			for (let levelMask = 1; levelMask < 16; levelMask++) {
				const levels = LOG_LEVELS.filter(
					(_, index) => levelMask & (1 << index),
				);
				for (const bootId of [null, "b"]) {
					const boot = bootId === null ? [] : [`_BOOT_ID=${bootId}`];
					const priorities =
						levelMask === 15
							? []
							: levels.flatMap((level) =>
									levelPriorities[level].map((n) => `PRIORITY=${n}`),
								);
					const common = [...boot, ...priorities];
					const selectedUnits = [
						...new Set(
							sources.flatMap((source) =>
								source === "bonding"
									? ["ceralive.service", ...units.bonding]
									: units[source],
							),
						),
					];
					const groups: string[][] = [];
					if (sourceMask === 0) groups.push(common);
					if (selectedUnits.length)
						groups.push([
							...common,
							...selectedUnits.map((unit) => `_SYSTEMD_UNIT=${unit}`),
						]);
					if (sources.includes("kernel"))
						groups.push([...common, "_TRANSPORT=kernel"]);
					if (sourceMask !== 0 || levelMask !== 15)
						groups.push([...boot, notice]);
					expect(compileFilter({ sources, levels }, { bootId })).toStrictEqual({
						matches: groups.flatMap((group, index) =>
							index ? ["+", ...group] : group,
						),
						residual: {},
					});
				}
			}
		}
	});

	test("duplicates and input order cannot widen severity or grow journal argv", () => {
		const input = logFilterSchema.parse({
			sources: Array(10_000).fill("network"),
			levels: Array(10_000).fill("error"),
		});
		expect(compileFilter(input, { bootId: null })).toStrictEqual(
			compileFilter(
				{ sources: ["network"], levels: ["error"] },
				{ bootId: null },
			),
		);
		expect(
			compileFilter(
				{
					sources: ["kernel", "app", "kernel"],
					levels: ["debug", "info", "warning", "error", "error"],
				},
				{ bootId: null },
			),
		).toStrictEqual({
			matches: [
				"_SYSTEMD_UNIT=ceralive.service",
				"+",
				"_TRANSPORT=kernel",
				"+",
				notice,
			],
			residual: {},
		});
	});

	test.each([
		"--file=/etc/shadow",
		"-k",
		"USB.[*]\n--output=json",
		"é".repeat(128),
		"x",
	])("search %j remains an unchanged literal residual", (text) => {
		const query = logQueryInputSchema.parse({ text, since: 0, until: 1 });
		expect(compileFilter(query, { bootId: "b" })).toStrictEqual({
			matches: ["_BOOT_ID=b"],
			residual: { text },
		});
	});

	test.each(["", "--file=/etc/shadow", "b\n--root=/"])(
		"context %j can only become one fixed boot field match",
		(bootId) => {
			expect(compileFilter({}, { bootId })).toStrictEqual({
				matches: [`_BOOT_ID=${bootId}`],
				residual: {},
			});
		},
	);

	test("compilation owns fresh results and never changes filter or catalog state", () => {
		const input = {
			sources: ["app"],
			levels: ["error"],
			text: "MiXeD",
		} satisfies LogFilter;
		const before = structuredClone(input);
		const compiled = compileFilter(input, { bootId: "b" });
		compiled.matches.push("--file=hostile");
		compiled.residual.text = "changed";
		expect(input).toEqual(before);
		expect(compileFilter(input, { bootId: "b" })).toStrictEqual({
			matches: [
				"_BOOT_ID=b",
				"PRIORITY=0",
				"PRIORITY=1",
				"PRIORITY=2",
				"PRIORITY=3",
				"_SYSTEMD_UNIT=ceralive.service",
				"+",
				"_BOOT_ID=b",
				notice,
			],
			residual: { text: "MiXeD" },
		});
	});

	test.each([
		{ sources: ["--file=/etc/shadow"] },
		{ sources: ["network\n--root=/"] },
		{ sources: ["_SYSTEMD_UNIT=ssh.service"] },
		{ levels: [] },
		{ levels: ["--all"] },
		{ units: ["ssh.service"] },
		{ field: "_PID" },
		{ options: ["--root=/"] },
		{ text: "\0" },
		{ text: "x".repeat(257) },
	])(
		"the wire boundary rejects hostile filter %j before compilation",
		(input) => {
			const parsed = logFilterSchema.safeParse(input);
			expect(parsed.success).toBe(false);
		},
	);

	test("golden token lists remain reviewable and change only on explicit update", () => {
		const rows = goldenCases.map(({ name, filter, bootId }) => ({
			name,
			filter,
			bootId,
			matches: compileFilter(filter, { bootId }).matches,
		}));
		const text = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
		const path = new URL(
			"../../test-harness/journal-conformance/golden-argv.txt",
			import.meta.url,
		);
		if (process.env.UPDATE_GOLDEN === "1") writeFileSync(path, text);
		expect(readFileSync(path, "utf8")).toBe(text);
		for (const row of rows) {
			expect(
				row.matches.every(
					(token) =>
						token === "+" ||
						/^(?:_BOOT_ID|PRIORITY|_SYSTEMD_UNIT|_TRANSPORT|MESSAGE_ID)=/.test(
							token,
						),
				),
			).toBe(true);
		}
	});
});
