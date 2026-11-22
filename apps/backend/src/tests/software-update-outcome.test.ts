/// <reference types="bun" />
/*
 * What an install a tab watched did, read once CeraUI restarted under it:
 * success iff one complete dpkg read shows every target of the vector that
 * install was launched with installed, configured and at its version or
 * later; otherwise unknown ("Outcome not confirmed"), with the fixed-name
 * unit's non-zero exit only as an unattributed hint. The version order is
 * dpkg's: the fake below answers from an explicit order that has an epoch, a
 * tilde and a plus, as `dpkg --compare-versions` does on the device.
 */
import { describe, expect, test } from "bun:test";
import type { UpdateTarget } from "@ceraui/rpc/schemas";
import type { SpawnWithTimeoutResult } from "../helpers/spawn-policy.ts";
import {
	readUpdateOutcome,
	UPDATE_OUTCOME_DEADLINE_MS,
} from "../modules/system/software-update-outcome.ts";
import type { DetachedAptServiceState } from "../modules/system/software-update-service-state.ts";

// dpkg's order: ~ sorts before the release, + after it, and an epoch above all.
const ORDER = [
	"2026.11.2",
	"2026.11.3~rc1",
	"2026.11.3",
	"2026.11.3+b1",
	"1:2026.1.0",
];
const TARGET = "2026.11.3";
const QUERY = [
	"dpkg-query",
	"-W",
	`-f=\${Package}\\t\${Architecture}\\t\${db:Status-Abbrev}\\t\${Version}\\n`,
	"--",
];
const launched = (...extra: UpdateTarget[]): UpdateTarget[] => [
	{ name: "ceralive-ui", version: TARGET },
	...extra,
];
const finished = (exitCode: number): DetachedAptServiceState => ({
	kind: "finished",
	exitCode,
	cleanup: exitCode === 0 ? "stop" : "reset-failed",
});
const ABSENT: DetachedAptServiceState = { kind: "absent" };

function device(o: {
	readonly installed?: Readonly<Record<string, string>>;
	/** dpkg-query's status column for every installed row. */
	readonly status?: string;
	/** dpkg-query's whole stdout instead of rows from `installed`. */
	readonly rows?: string;
	readonly queryExit?: number;
	readonly compareExit?: number;
	readonly unit?: DetachedAptServiceState | Error;
	readonly observed?: boolean;
	/** Milliseconds each read takes on the test's clock. */
	readonly takes?: number;
}) {
	const calls: string[][] = [];
	const timeouts: number[] = [];
	let inspections = 0;
	let clock = 0;
	const answer = (exitCode: number, stdout = ""): SpawnWithTimeoutResult => ({
		exitCode,
		stdout,
		stderr: "",
	});
	return {
		calls,
		timeouts,
		inspections: () => inspections,
		deps: {
			now: () => clock,
			inspect: async () => {
				inspections++;
				if (o.unit instanceof Error) throw o.unit;
				return o.unit ?? ABSENT;
			},
			observed: () => o.observed ?? false,
			run: async (argv: string[], opts?: { timeoutMs?: number }) => {
				calls.push(argv);
				timeouts.push(opts?.timeoutMs ?? Number.NaN);
				clock += o.takes ?? 0;
				if (argv[0] === "dpkg-query") {
					if (o.queryExit !== undefined) return answer(o.queryExit);
					if (o.rows !== undefined) return answer(0, o.rows);
					const names = argv.slice(argv.indexOf("--") + 1);
					const rows = names.flatMap((name) => {
						const version = o.installed?.[name];
						return version === undefined
							? []
							: [`${name}\tarm64\t${o.status ?? "ii "}\t${version}\n`];
					});
					return answer(rows.length === names.length ? 0 : 1, rows.join(""));
				}
				if (o.compareExit !== undefined) return answer(o.compareExit);
				const [, , left = "", , right = ""] = argv;
				return answer(ORDER.indexOf(left) >= ORDER.indexOf(right) ? 0 : 1);
			},
		},
	};
}

describe("success is decided by the installed versions", () => {
	test.each([
		["the launched version", TARGET],
		["a later build (+)", "2026.11.3+b1"],
		["a higher epoch", "1:2026.1.0"],
	])("installed at %s: success", async (_, installed) => {
		const d = device({
			installed: { "ceralive-ui": installed },
			unit: finished(100),
		});
		expect(await readUpdateOutcome(launched(), d.deps)).toEqual({
			kind: "success",
		});
	});

	test("a pre-release below the target (~) is not success", async () => {
		const d = device({ installed: { "ceralive-ui": "2026.11.3~rc1" } });
		expect(await readUpdateOutcome(launched(), d.deps)).toEqual({
			kind: "unknown",
		});
	});

	test("every launched package must be reached, not only one", async () => {
		const targets = launched({ name: "cerastream", version: "2026.11.3" });
		const d = device({
			installed: { "ceralive-ui": TARGET, cerastream: "2026.11.2" },
			unit: finished(100),
		});
		expect(await readUpdateOutcome(targets, d.deps)).toEqual({
			kind: "unknown",
			exit: 100,
		});
	});

	test("an unpacked but unconfigured package is not installed", async () => {
		const d = device({
			installed: { "ceralive-ui": TARGET },
			status: "iU ",
		});
		expect(await readUpdateOutcome(launched(), d.deps)).toEqual({
			kind: "unknown",
		});
	});

	test("a package dpkg does not list is not reached", async () => {
		const d = device({ installed: {}, unit: finished(100) });
		expect(await readUpdateOutcome(launched(), d.deps)).toEqual({
			kind: "unknown",
			exit: 100,
		});
	});

	// db:Status-Abbrev: want, state, error. Only an installed, configured
	// instance with no reinstall required is the target reached; a hold
	// (want "h") stops apt from changing it, not dpkg from having installed it.
	test.each([
		["ii ", "installed", "success"],
		["hi ", "installed and held", "success"],
		["iiR", "installed, reinstall required", "unknown"],
		["iU ", "unpacked", "unknown"],
		["iF ", "half-configured", "unknown"],
		["iH ", "half-installed", "unknown"],
		["iW ", "awaiting triggers", "unknown"],
		["it ", "triggers pending", "unknown"],
		["ri ", "installed, marked for removal", "unknown"],
		["pi ", "installed, marked for purge", "unknown"],
		["rc ", "removed, config files left", "unknown"],
		["un ", "not installed", "unknown"],
	] as const)("status %j (%s): %s", async (status, _, kind) => {
		const d = device({ installed: { "ceralive-ui": TARGET }, status });
		expect(await readUpdateOutcome(launched(), d.deps)).toEqual({ kind });
	});
});

describe("only a complete, coherent read decides", () => {
	test("dpkg-query's exit 1 is no success even with every row matching", async () => {
		const d = device({
			rows: `ceralive-ui\tarm64\tii \t${TARGET}\n`,
			queryExit: 1,
		});
		expect(await readUpdateOutcome(launched(), d.deps)).toEqual({
			kind: "unknown",
		});
	});

	test.each([
		["no output", ""],
		["no final newline", `ceralive-ui\tarm64\tii \t${TARGET}`],
		["a field missing", `ceralive-ui\tii \t${TARGET}\n`],
		["an extra field", `ceralive-ui\tarm64\tii \t${TARGET}\tx\n`],
		["a stray line", `ceralive-ui\tarm64\tii \t${TARGET}\nnoise\n`],
		["a bad status", `ceralive-ui\tarm64\tok \t${TARGET}\n`],
		[
			"a duplicate row",
			`ceralive-ui\tarm64\tii \t${TARGET}\nceralive-ui\tarm64\tii \t${TARGET}\n`,
		],
		[
			"a row for a package not asked about",
			`ceralive-ui\tarm64\tii \t${TARGET}\nother\tarm64\tii \t1\n`,
		],
	])("a successful query with %s is unknown, not below", async (_, rows) => {
		const d = device({ rows, unit: ABSENT });
		expect(await readUpdateOutcome(launched(), d.deps)).toEqual({
			kind: "unknown",
		});
	});

	test("every installed architecture of an unqualified name must be reached", async () => {
		const both = (foreign: string) =>
			`ceralive-ui\tarm64\tii \t${TARGET}\nceralive-ui\tarmhf\tii \t${foreign}\n`;
		expect(
			await readUpdateOutcome(launched(), device({ rows: both(TARGET) }).deps),
		).toEqual({ kind: "success" });
		expect(
			await readUpdateOutcome(
				launched(),
				device({ rows: both("2026.11.2") }).deps,
			),
		).toEqual({ kind: "unknown" });
		// A removed foreign instance is no instance.
		const removed = `ceralive-ui\tarm64\tii \t${TARGET}\nceralive-ui\tarmhf\trc \t2026.11.2\n`;
		expect(
			await readUpdateOutcome(launched(), device({ rows: removed }).deps),
		).toEqual({ kind: "success" });
	});

	test("a qualified name is decided by its own architecture's row", async () => {
		const d = device({
			rows: `libfoo\tarmhf\tii \t${TARGET}\n`,
		});
		expect(
			await readUpdateOutcome(
				[{ name: "libfoo:armhf", version: TARGET }],
				d.deps,
			),
		).toEqual({ kind: "success" });
		const other = device({ rows: `libfoo\tarm64\tii \t${TARGET}\n` });
		expect(
			await readUpdateOutcome(
				[{ name: "libfoo:armhf", version: TARGET }],
				other.deps,
			),
		).toEqual({ kind: "unknown" });
	});

	test("the whole request has one deadline; past it, unknown", async () => {
		const many = Array.from({ length: 512 }, (_, i) => `p${i}`);
		const d = device({
			installed: Object.fromEntries(many.map((name) => [name, TARGET])),
			takes: 4_000,
		});
		expect(
			await readUpdateOutcome(
				many.map((name) => ({ name, version: TARGET })),
				d.deps,
			),
		).toEqual({ kind: "unknown" });
		// Each read gets at most what is left, and none starts after it is spent.
		expect(d.calls.length).toBe(UPDATE_OUTCOME_DEADLINE_MS / 4_000);
		expect(d.timeouts).toEqual([5_000, 5_000, 5_000, 5_000, 4_000]);
	});
});

describe("not reached, the unit's exit is only a hint", () => {
	test("a non-zero exit is attached as the hint", async () => {
		const d = device({
			installed: { "ceralive-ui": "2026.11.2" },
			unit: finished(100),
		});
		expect(await readUpdateOutcome(launched(), d.deps)).toEqual({
			kind: "unknown",
			exit: 100,
		});
	});

	test.each([
		["the unit is gone", ABSENT],
		["the unit exited zero", finished(0)],
	])("%s: not confirmed", async (_, unit) => {
		const d = device({ installed: { "ceralive-ui": "2026.11.2" }, unit });
		expect(await readUpdateOutcome(launched(), d.deps)).toEqual({
			kind: "unknown",
		});
	});

	test("the unit is read after the packages, so its exit is never older than them", async () => {
		const order: string[] = [];
		const d = device({ installed: {}, unit: finished(100) });
		await readUpdateOutcome(launched(), {
			...d.deps,
			inspect: () => {
				order.push("unit");
				return d.deps.inspect();
			},
			run: (argv, opts) => {
				order.push(argv[0] ?? "");
				return d.deps.run(argv, opts);
			},
		});
		expect(order).toEqual(["dpkg-query", "unit"]);
	});
});

describe("a read that gives no answer is unknown", () => {
	test.each([
		["dpkg-query fails", { queryExit: 2 }],
		["dpkg cannot compare", { compareExit: 2 }],
	])("%s, even beside a failed unit", async (_, o) => {
		const d = device({
			installed: { "ceralive-ui": "2026.11.2" },
			unit: finished(100),
			...o,
		});
		expect(await readUpdateOutcome(launched(), d.deps)).toEqual({
			kind: "unknown",
			exit: 100,
		});
	});

	test.each([
		[false, { kind: "success" }],
		[true, { kind: "unknown" }],
	] as const)(
		"a unit probe that throws (this process observes: %p) drops only what it could tell",
		async (observed, outcome) => {
			const d = device({
				installed: { "ceralive-ui": TARGET },
				unit: new Error("systemctl show timed out"),
				observed,
			});
			expect(await readUpdateOutcome(launched(), d.deps)).toEqual(outcome);
		},
	);

	test("a run launched without a vector (legacy mode) decides nothing", async () => {
		const d = device({ installed: {}, unit: finished(100) });
		expect(await readUpdateOutcome([], d.deps)).toEqual({
			kind: "unknown",
			exit: 100,
		});
		expect(d.calls).toEqual([]);
	});

	test("an option-shaped or empty name or version never reaches dpkg", async () => {
		for (const bad of [
			{ name: "-x", version: TARGET },
			{ name: "ceralive-ui", version: "--force" },
			{ name: "ceralive-ui", version: "" },
		]) {
			const d = device({ installed: { "ceralive-ui": TARGET } });
			expect(await readUpdateOutcome([bad], d.deps)).toEqual({
				kind: "unknown",
			});
			expect(d.calls).toEqual([]);
			expect(d.inspections()).toBe(0);
		}
	});
});

describe("a unit this process reports itself is still running", () => {
	test.each([
		["a running unit", { kind: "running" } as const],
		["a finished unit recovery has not read", finished(0)],
	])("%s that this process observes reads as running", async (_, unit) => {
		const d = device({
			installed: { "ceralive-ui": TARGET },
			unit,
			observed: true,
		});
		expect(await readUpdateOutcome(launched(), d.deps)).toEqual({
			kind: "running",
		});
		expect(d.calls.every((argv) => argv[0]?.startsWith("dpkg"))).toBe(true);
	});

	test("a running unit no process will report is decided now: not confirmed", async () => {
		const d = device({
			installed: { "ceralive-ui": "2026.11.2" },
			unit: { kind: "running" },
		});
		expect(await readUpdateOutcome(launched(), d.deps)).toEqual({
			kind: "unknown",
		});
	});

	test("with no unit left, an observing process decides from the versions", async () => {
		const d = device({
			installed: { "ceralive-ui": TARGET },
			observed: true,
		});
		expect(await readUpdateOutcome(launched(), d.deps)).toEqual({
			kind: "success",
		});
	});
});

test("it only reads: the query's ABI, then version comparisons, one unit probe", async () => {
	const d = device({
		installed: { "ceralive-ui": TARGET, cerastream: "2026.11.3" },
		unit: finished(0),
	});
	await readUpdateOutcome(
		launched({ name: "cerastream", version: "2026.11.3" }),
		d.deps,
	);
	expect(d.inspections()).toBe(1);
	expect(d.calls[0]).toEqual([...QUERY, "ceralive-ui", "cerastream"]);
	for (const argv of d.calls.slice(1))
		expect(argv).toEqual([
			"dpkg",
			"--compare-versions",
			expect.any(String),
			"ge",
			expect.any(String),
		]);
});

// The record-and-claim tests this rule replaces, as their scenarios read now.
describe("ported: an older run never answers for a newer vector", () => {
	test("an older run's success is not the newer vector's success", async () => {
		// Was: a stale exit retry / an earlier attempt's receipt told for a newer admission.
		const d = device({
			installed: { "ceralive-ui": "2026.11.2" },
			unit: ABSENT,
		});
		expect(await readUpdateOutcome(launched(), d.deps)).toEqual({
			kind: "unknown",
		});
	});

	test("an older run's failure does not hide that the newer vector is installed", async () => {
		// Was: a newer attempt's terminal state is never overwritten by an older one.
		const d = device({
			installed: { "ceralive-ui": TARGET },
			unit: finished(100),
		});
		expect(await readUpdateOutcome(launched(), d.deps)).toEqual({
			kind: "success",
		});
	});

	test("another run's failed exit is only ever a hint beside not confirmed", async () => {
		// The fixed-name unit's last occupant may be a run this tab never saw.
		const d = device({
			installed: { "ceralive-ui": "2026.11.2" },
			unit: finished(100),
		});
		const outcome = await readUpdateOutcome(launched(), d.deps);
		expect(outcome.kind).toBe("unknown");
		expect(outcome).not.toHaveProperty("reason");
	});
});
