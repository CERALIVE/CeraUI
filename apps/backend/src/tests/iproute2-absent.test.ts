import { expect, test } from "bun:test";
import { isFibTableAbsent } from "../helpers/iproute2-absent.ts";
import type { run } from "../helpers/run.ts";
import { readRouteTable } from "../modules/network/uplink-steering/route-planner.ts";
import { createAptRoutingOwnership } from "../modules/system/apt-routing-ownership.ts";
import captured from "./fixtures/iproute2-7.2-absent.json";
import { absentTableError } from "./uplink-steering-route-test-fixtures.ts";

const jsonAbsentStderr =
	"Error: ipv4: FIB table does not exist.\nDump terminated";

test.each([
	["JSON empty array stdout", "[]\n", jsonAbsentStderr, 2, true],
	["empty stdout", "", jsonAbsentStderr, 2, true],
	[
		"extra routing diagnostic",
		"[]\n",
		`${jsonAbsentStderr}\nRTNETLINK answers: Operation not permitted`,
		2,
		false,
	],
	["nonempty route array", '[{"dst":"default"}]', jsonAbsentStderr, 2, false],
	["wrong exit code", "[]\n", jsonAbsentStderr, 1, false],
] as const)(
	"json-read accepts only an empty JSON route result and exact absence: %s",
	(_name, stdout, stderr, code, absent) => {
		const error = Object.assign(new Error("ip -j route show failed"), {
			code,
			stdout,
			stderr,
		});
		expect(isFibTableAbsent(error, "json-read")).toBe(absent);
	},
);

test.each([
	[captured.ipv4, "read", true],
	[captured.ipv6, "read", true],
	[captured.delete, "read", false],
	["Error: ipv4: FIB table does not exist.\nFlush terminated\n", "flush", true],
	["Error: ipv6: FIB table does not exist.\nFlush terminated\n", "flush", true],
	[captured.ipv4, "flush", false],
	["Error: ipv4: FIB table does not exist.\nFlush terminated\n", "read", false],
	["Error: ipv5: FIB table does not exist.\nDump terminated\n", "read", false],
	[`${captured.ipv4}Permission denied\n`, "read", false],
	["prefix FIB table does not exist", "read", false],
	["FIB table does not exist unexpectedly", "read", false],
	["Flush terminated\n", "flush", false],
	["RTNETLINK answers: Operation not permitted\n", "read", false],
] as const)(
	"recognizes only the operation's complete absent-FIB diagnostic %#",
	(stderr, operation, absent) => {
		expect(isFibTableAbsent(absentTableError(stderr), operation)).toBe(absent);
	},
);

test.each([1, 0, "2", undefined])(
	"rejects absent-FIB text with a present non-2 exit code %#",
	(code) => {
		expect(
			isFibTableAbsent(Object.assign(absentTableError(), { code }), "read"),
		).toBe(false);
	},
);

test("rejects code-free errors at the steering boundary", () => {
	expect(
		isFibTableAbsent(
			Object.assign(new Error("kernel reply"), {
				stderr: captured.ipv4,
			}),
			"read",
		),
	).toBe(false);
});

test.each([
	new Error(captured.ipv4),
	{ code: 2, stdout: "", stderr: captured.ipv4 },
	null,
])("does not infer absence from a message or non-runner error %#", (error) => {
	expect(isFibTableAbsent(error, "read")).toBe(false);
});

test.each([
	Object.assign(absentTableError(), { stdout: "default dev ww9\n" }),
	Object.assign(new Error("kernel reply"), { code: 2, stderr: captured.ipv4 }),
	Object.assign(absentTableError(), {
		stderr: "Error: Operation not permitted\n",
	}),
	Object.assign(new Error("kernel reply"), {
		stdout: "",
		stderr: captured.ipv4,
	}),
	Object.assign(absentTableError(), { code: "2" }),
	absentTableError(
		"Error: ipv4: FIB table does not exist.\nFlush terminated\n",
	),
	absentTableError(captured.delete),
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

test.each([captured.ipv4, captured.ipv6])(
	"reads proven absent tables with CRLF and whitespace-only stdout %#",
	async (stderr) => {
		const error = Object.assign(absentTableError(), {
			stdout: " \t\r\n",
			stderr: ` \t${stderr.replaceAll("\n", "\r\n")} \t`,
		});
		await expect(
			readRouteTable(
				{
					run: async () => {
						throw error;
					},
				},
				"30001",
			),
		).resolves.toBe("");
	},
);

test.each([
	["FIB dump without code", { stderr: captured.ipv4 }, true],
	["FIB dump with code 2", { stderr: captured.ipv4, code: 2 }, true],
	["FIB dump with code 1", { stderr: captured.ipv4, code: 1 }, true],
	["FIB dump with string code", { stderr: captured.ipv4, code: "2" }, true],
	[
		"FIB flush with code 2",
		{
			stderr: "Error: ipv4: FIB table does not exist.\nFlush terminated\n",
			code: 2,
		},
		false,
	],
	[
		"FIB dump with partial stdout",
		{
			stderr: captured.ipv4,
			code: 2,
			stdout: "default via 10.64.0.1 dev ww0\n",
		},
		true,
	],
	[
		"RTNETLINK missing file with code 1",
		{
			stderr: "RTNETLINK answers: No such file or directory\n",
			code: 1,
		},
		true,
	],
	[
		"permission error",
		{ stderr: "Error: Operation not permitted\n", code: 2 },
		false,
	],
] as const)(
	"preserves main's APT admission outcome: %s",
	async (_name, fields, admitted) => {
		const error = Object.assign(new Error("kernel reply"), fields);
		const owner = createAptRoutingOwnership({
			read: async () => [],
			save: () => {},
		});
		const runner: typeof run = async (_bin, args) => {
			if (args.includes("route")) throw error;
			return "";
		};
		const admission = owner
			.acquire(runner, 42042)
			.then((lease) => lease.release());
		if (admitted) {
			await expect(admission).resolves.toBeUndefined();
		} else {
			await expect(admission).rejects.toHaveProperty(
				"reason",
				"journal-unavailable",
			);
		}
	},
);
