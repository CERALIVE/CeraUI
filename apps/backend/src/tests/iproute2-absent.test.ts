import { expect, test } from "bun:test";
import { isFibTableAbsent } from "../helpers/iproute2-absent.ts";
import { readRouteTable } from "../modules/network/uplink-steering/route-planner.ts";
import captured from "./fixtures/iproute2-7.2-absent.json";
import { absentTableError } from "./uplink-steering-route-test-fixtures.ts";

test.each([
	[captured.ipv4, true],
	[captured.ipv6, true],
	[captured.delete, true],
	["Error: ipv4: FIB table does not exist.\nFlush terminated\n", true],
	["Error: ipv6: FIB table does not exist.\nFlush terminated\n", true],
	["Error: ipv5: FIB table does not exist.\nDump terminated\n", false],
	[`${captured.ipv4}Permission denied\n`, false],
	["prefix FIB table does not exist", false],
	["FIB table does not exist unexpectedly", false],
	["Flush terminated\n", false],
	["RTNETLINK answers: Operation not permitted\n", false],
] as const)(
	"recognizes only complete absent-FIB diagnostics %#",
	(stderr, absent) => {
		expect(isFibTableAbsent(absentTableError(stderr))).toBe(absent);
	},
);

test.each([1, 0, "2", undefined])(
	"rejects absent-FIB text with a present non-2 exit code %#",
	(code) => {
		expect(isFibTableAbsent(Object.assign(absentTableError(), { code }))).toBe(
			false,
		);
	},
);

test("retains the code-free APT error contract", () => {
	expect(
		isFibTableAbsent(
			Object.assign(new Error("kernel reply"), {
				stderr: captured.ipv4,
			}),
		),
	).toBe(true);
});

test.each([
	new Error(captured.ipv4),
	{ code: 2, stdout: "", stderr: captured.ipv4 },
	null,
])("does not infer absence from a message or non-runner error %#", (error) => {
	expect(isFibTableAbsent(error)).toBe(false);
});

test.each([
	Object.assign(absentTableError(), { stdout: "default dev ww9\n" }),
	Object.assign(new Error("kernel reply"), { code: 2, stderr: captured.ipv4 }),
	Object.assign(absentTableError(), {
		stderr: "Error: Operation not permitted\n",
	}),
])(
	"rethrows the original read failure without proven empty stdout %#",
	async (error) => {
		await expect(
			readRouteTable(
				{
					run: async () => {
						throw error;
					},
				},
				"30001",
			),
		).rejects.toBe(error);
	},
);
