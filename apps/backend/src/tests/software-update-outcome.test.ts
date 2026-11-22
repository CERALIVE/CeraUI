/// <reference types="bun" />
/*
 * What an install a tab watched did, read once CeraUI restarted under it:
 * success iff every package the device offered is installed at its version or
 * later; below that, the unit's own non-zero exit as a hint; otherwise
 * unknown ("Outcome not confirmed"). The version order is dpkg's: the fake
 * below answers from an explicit order that has an epoch, a tilde and a plus,
 * as `dpkg --compare-versions` does on the device.
 */
import { describe, expect, test } from "bun:test";
import type { UpdatePackage } from "@ceraui/rpc/schemas";
import type { SpawnWithTimeoutResult } from "../helpers/spawn-policy.ts";
import { readUpdateOutcome } from "../modules/system/software-update-outcome.ts";
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
const offer = (...extra: UpdatePackage[]): UpdatePackage[] => [
	{ name: "ceralive-ui", version: TARGET, layer: "app", actionable: true },
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
	readonly queryExit?: number;
	readonly compareExit?: number;
	readonly unit?: DetachedAptServiceState | Error;
	readonly observed?: boolean;
}) {
	const calls: string[][] = [];
	let inspections = 0;
	const answer = (exitCode: number, stdout = ""): SpawnWithTimeoutResult => ({
		exitCode,
		stdout,
		stderr: "",
	});
	return {
		calls,
		inspections: () => inspections,
		deps: {
			inspect: async () => {
				inspections++;
				if (o.unit instanceof Error) throw o.unit;
				return o.unit ?? ABSENT;
			},
			observed: () => o.observed ?? false,
			run: async (argv: string[]) => {
				calls.push(argv);
				if (argv[0] === "dpkg-query") {
					if (o.queryExit !== undefined) return answer(o.queryExit);
					const names = argv.slice(argv.indexOf("--") + 1);
					const rows = names.flatMap((name) => {
						const version = o.installed?.[name];
						return version === undefined
							? []
							: [`${name}\t${o.status ?? "ii "}\t${version}\n`];
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
		["the offered version", TARGET],
		["a later build (+)", "2026.11.3+b1"],
		["a higher epoch", "1:2026.1.0"],
	])("installed at %s: success", async (_, installed) => {
		const d = device({
			installed: { "ceralive-ui": installed },
			unit: finished(100),
		});
		expect(await readUpdateOutcome(offer(), d.deps)).toEqual({
			kind: "success",
		});
	});

	test("a pre-release below the offer (~) is not success", async () => {
		const d = device({ installed: { "ceralive-ui": "2026.11.3~rc1" } });
		expect(await readUpdateOutcome(offer(), d.deps)).toEqual({
			kind: "unknown",
		});
	});

	test("every offered package must be reached, not only one", async () => {
		const packages = offer({
			name: "cerastream",
			version: "2026.11.3",
			layer: "app",
			actionable: true,
		});
		const d = device({
			installed: { "ceralive-ui": TARGET, cerastream: "2026.11.2" },
			unit: finished(100),
		});
		expect(await readUpdateOutcome(packages, d.deps)).toEqual({
			kind: "failed",
			reason: "apt-get exited with code 100",
		});
	});

	test("an unpacked but unconfigured package is not installed", async () => {
		const d = device({
			installed: { "ceralive-ui": TARGET },
			status: "iU ",
		});
		expect(await readUpdateOutcome(offer(), d.deps)).toEqual({
			kind: "unknown",
		});
	});

	test("a package dpkg does not list is below the offer", async () => {
		const d = device({ installed: {}, unit: finished(100) });
		expect(await readUpdateOutcome(offer(), d.deps)).toEqual({
			kind: "failed",
			reason: "apt-get exited with code 100",
		});
	});
});

describe("below the offer, the unit's exit is only a hint", () => {
	test("a non-zero exit is the failure hint", async () => {
		const d = device({
			installed: { "ceralive-ui": "2026.11.2" },
			unit: finished(100),
		});
		expect(await readUpdateOutcome(offer(), d.deps)).toEqual({
			kind: "failed",
			reason: "apt-get exited with code 100",
		});
	});

	test.each([
		["the unit is gone", ABSENT],
		["the unit exited zero", finished(0)],
	])("%s: not confirmed", async (_, unit) => {
		const d = device({ installed: { "ceralive-ui": "2026.11.2" }, unit });
		expect(await readUpdateOutcome(offer(), d.deps)).toEqual({
			kind: "unknown",
		});
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
		expect(await readUpdateOutcome(offer(), d.deps)).toEqual({
			kind: "unknown",
		});
	});

	test("a unit probe that throws is unknown", async () => {
		const d = device({
			installed: { "ceralive-ui": TARGET },
			unit: new Error("systemctl show timed out"),
		});
		expect(await readUpdateOutcome(offer(), d.deps)).toEqual({
			kind: "unknown",
		});
	});

	test("with no versioned target (a legacy offer names packages only), nothing is decided", async () => {
		const d = device({ installed: {}, unit: finished(100) });
		const legacy: UpdatePackage[] = [
			{ name: "ceralive-ui", layer: "app", actionable: true },
			{
				name: "linux-image",
				version: "6.1",
				layer: "platform",
				actionable: false,
			},
		];
		expect(await readUpdateOutcome(legacy, d.deps)).toEqual({
			kind: "unknown",
		});
		expect(d.calls).toEqual([]);
	});

	test("an option-shaped name or version never reaches dpkg", async () => {
		for (const bad of [
			{ name: "-x", version: TARGET },
			{ name: "ceralive-ui", version: "--force" },
		]) {
			const d = device({ installed: { "ceralive-ui": TARGET } });
			expect(
				await readUpdateOutcome([{ ...bad, actionable: true }], d.deps),
			).toEqual({ kind: "unknown" });
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
		expect(await readUpdateOutcome(offer(), d.deps)).toEqual({
			kind: "running",
		});
		expect(d.calls).toEqual([]);
	});

	test("a running unit no process will report is decided now: not confirmed", async () => {
		const d = device({
			installed: { "ceralive-ui": "2026.11.2" },
			unit: { kind: "running" },
		});
		expect(await readUpdateOutcome(offer(), d.deps)).toEqual({
			kind: "unknown",
		});
	});

	test("with no unit left, an observing process decides from the versions", async () => {
		const d = device({
			installed: { "ceralive-ui": TARGET },
			observed: true,
		});
		expect(await readUpdateOutcome(offer(), d.deps)).toEqual({
			kind: "success",
		});
	});
});

test("it only reads: one unit probe, one package query, one comparison per package", async () => {
	const d = device({
		installed: { "ceralive-ui": TARGET, cerastream: "2026.11.3" },
		unit: finished(0),
	});
	await readUpdateOutcome(
		offer({ name: "cerastream", version: "2026.11.3", actionable: true }),
		d.deps,
	);
	expect(d.inspections()).toBe(1);
	expect(d.calls).toEqual([
		[
			"dpkg-query",
			"-W",
			"-f=${Package}\\t${db:Status-Abbrev}\\t${Version}\\n",
			"--",
			"ceralive-ui",
			"cerastream",
		],
		["dpkg", "--compare-versions", TARGET, "ge", TARGET],
		["dpkg", "--compare-versions", "2026.11.3", "ge", "2026.11.3"],
	]);
});

// The record-and-claim tests this rule replaces, as their scenarios read now.
describe("ported: an older run never answers for a newer offer", () => {
	test("an older run's success is not the newer offer's success", async () => {
		// Was: a stale exit retry / an earlier attempt's receipt told for a newer admission.
		const d = device({
			installed: { "ceralive-ui": "2026.11.2" },
			unit: ABSENT,
		});
		expect(await readUpdateOutcome(offer(), d.deps)).toEqual({
			kind: "unknown",
		});
	});

	test("an older run's failure does not hide that the newer offer is installed", async () => {
		// Was: a newer attempt's terminal state is never overwritten by an older one.
		const d = device({
			installed: { "ceralive-ui": TARGET },
			unit: finished(100),
		});
		expect(await readUpdateOutcome(offer(), d.deps)).toEqual({
			kind: "success",
		});
	});
});
