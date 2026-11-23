/// <reference types="bun" />
/*
 * Each case runs the real withdrawal pass over a scripted device and a real
 * notification slot. A clean dpkg snapshot at the exact version can clear it;
 * APT policy cannot authorize withdrawal of a skipped version.
 */
import { afterEach, expect, test } from "bun:test";
import type { SpawnWithTimeoutResult } from "../helpers/spawn-policy.ts";
import { setAptCommandRunnerForTest } from "../modules/system/software-updates.ts";
import {
	noticeTargets,
	retireFulfilledPackageNotices,
} from "../modules/system/update-orchestrator/package-notice-retirement.ts";
import {
	notificationExists,
	notificationSend,
	notificationWithdraw,
} from "../modules/ui/notifications.ts";

type Read = "native" | "dpkg" | "compare" | "policy";
type Answer = Partial<SpawnWithTimeoutResult> | "throw";
type Device = {
	readonly rows?: string;
	readonly policy?: string;
	readonly answers?: Partial<Record<Read, Answer>>;
	readonly duringRead?: () => void;
};

const NAME = "update:updates-available:curl=2";
const ROWS = "curl\tarm64\tii \t2\n";
const NEWER_ROWS = "curl\tarm64\tii \t3\n";
const POLICY = "curl:\n  Installed: 3\n  Candidate: 3\n  Version table:\n";
const ok = (stdout: string): SpawnWithTimeoutResult => ({
	exitCode: 0,
	stdout,
	stderr: "",
});

const readOf = (argv: readonly string[]): Read =>
	argv[0] === "dpkg-query"
		? "dpkg"
		: argv[1] === "--print-architecture"
			? "native"
			: argv[0] === "dpkg"
				? "compare"
				: "policy";

let ran: Read[] = [];

function device({ rows = ROWS, policy = POLICY, answers, duringRead }: Device) {
	return async (argv: readonly string[]): Promise<SpawnWithTimeoutResult> => {
		const read = readOf(argv);
		ran.push(read);
		if (read === "dpkg") duringRead?.();
		const answer = answers?.[read];
		if (answer === "throw") throw new Error(`${read} did not answer`);
		const clean =
			read === "native"
				? ok("arm64\n")
				: read === "dpkg"
					? ok(rows)
					: read === "policy"
						? ok(policy)
						: {
								exitCode: Bun.spawnSync(["dpkg", ...argv.slice(1)]).exitCode,
								stdout: "",
								stderr: "",
							};
		return { ...clean, ...answer };
	};
}

async function withdrawn(
	scripted: Device,
	current: readonly string[] = [],
	name = NAME,
): Promise<boolean> {
	notificationSend(undefined, name, "info", "updates", 0, true);
	setAptCommandRunnerForTest(device(scripted));
	ran = [];
	await retireFulfilledPackageNotices(current, () => true);
	return notificationExists(name) === undefined;
}

afterEach(() => {
	setAptCommandRunnerForTest(null);
	notificationWithdraw(NAME);
});

test("the id grammar accepts only versioned package lists, each instance once", () => {
	expect(noticeTargets("curl=2,libc6:armhf=1:2.36-9+deb13u1")).toEqual([
		{ pkg: "curl", arch: null, version: "2" },
		{ pkg: "libc6", arch: "armhf", version: "1:2.36-9+deb13u1" },
	]);
	for (const id of [
		"",
		"os:2026.11.4",
		"2026.11.4",
		"cerastream=unknown",
		"curl=2,cerastream=unknown",
		"curl=2,curl=3",
		"a:b:c=1",
		"curl:=2",
		"curl:ARM=2",
		"=1",
		"curl=",
		"curl==2",
		"curl=2,",
	])
		expect([id, noticeTargets(id)]).toEqual([id, null]);
});

test("a newer installed version keeps the notice even when APT matches it", async () => {
	expect(await withdrawn({ rows: NEWER_ROWS })).toBe(false);
	expect(ran).toEqual(["native", "dpkg"]);
});

test("an exact installed version needs no comparison or policy read", async () => {
	expect(await withdrawn({ rows: "curl\tarm64\tii \t2\n" })).toBe(true);
	expect(ran).toEqual(["native", "dpkg"]);
});

test("every proper prefix of a proof read keeps the notice; APT prefixes cannot prove a newer version", async () => {
	const answers: Record<Exclude<Read, "compare">, string> = {
		native: "arm64\n",
		dpkg: ROWS,
		policy: POLICY,
	};
	for (const [read, full] of Object.entries(answers))
		for (let end = 0; end < full.length; end++) {
			const stdout = full.slice(0, end);
			expect([
				read,
				end,
				await withdrawn({
					rows: read === "policy" ? NEWER_ROWS : ROWS,
					answers: { [read]: { stdout } },
				}),
			]).toEqual([read, end, false]);
		}
});

test("a failed, noisy or unanswered read keeps the notice", async () => {
	const faults: readonly Answer[] = [
		{ exitCode: 1 },
		{ exitCode: 100 },
		{ stderr: "W: something\n" },
		"throw",
	];
	for (const read of ["native", "dpkg", "compare", "policy"] as const)
		for (const fault of faults)
			expect([
				read,
				fault,
				await withdrawn({
					rows: read === "compare" || read === "policy" ? NEWER_ROWS : ROWS,
					answers: { [read]: fault },
				}),
			]).toEqual([read, fault, false]);
	expect(
		await withdrawn({
			rows: NEWER_ROWS,
			answers: { compare: { stdout: "x\n" } },
		}),
	).toBe(false);
});

test("only one installed, configured, unheld instance at the exact version counts", async () => {
	const rows: readonly [string, boolean][] = [
		["curl\tarm64\thi \t2\n", false],
		["curl\tarm64\tiU \t2\n", false],
		["curl\tarm64\tiF \t2\n", false],
		["curl\tarm64\trc \t2\n", false],
		["curl\tarm64\tun \t\n", false],
		["curl\tarm64\tii \t1\n", false],
		["curl\tarmhf\tii \t2\n", false],
		["curl\tall\tii \t3\n", false],
		["curl\tall\tii \t2\n", true],
		["curl\tarm64\tii \t2\ncurl\tall\tii \t2\n", false],
		["curl\tarm64\tii \t2\ncurl\tarm64\tii \t2\n", false],
		["curl\tarm64\tii \t2\nzlib1g\tarm64\tii \t1\n", false],
		["curl arm64 ii 2\n", false],
	];
	for (const [listed, expected] of rows)
		expect([listed, await withdrawn({ rows: listed })]).toEqual([
			listed,
			expected,
		]);
});

test("a newer installed version keeps the notice regardless of APT policy", async () => {
	const policies: readonly string[] = [
		"curl:\n  Installed: 3\n  Candidate: 2\n",
		"curl:\n  Installed: 2\n  Candidate: 3\n",
		"curl:\n  Installed: 3\n  Candidate: 3\n  Candidate: 2\n",
		"curl:\n  Installed: 3\n  Installed: 3\n  Candidate: 3\n",
		"curl:armhf:\n  Installed: 3\n  Candidate: 3\n",
		"  Installed: 3\n  Candidate: 3\n",
	];
	for (const policy of policies)
		expect([
			policy,
			await withdrawn({ rows: NEWER_ROWS, policy }),
			ran,
		]).toEqual([policy, false, ["native", "dpkg"]]);
});

test("a name sharing a row with the current check is not read", async () => {
	expect(await withdrawn({}, ["curl=2"])).toBe(false);
	expect(ran).toEqual([]);
});

test("a notice shown again while dpkg is read is kept", async () => {
	const reshow = () =>
		notificationSend(undefined, NAME, "info", "updates", 0, true);
	expect(await withdrawn({ duringRead: reshow })).toBe(false);
	expect(await withdrawn({})).toBe(true);
});

test("a foreign instance needs that architecture's own row", async () => {
	const name = "update:updates-available:libc6:armhf=2";
	try {
		for (const [rows, expected] of [
			["libc6\tarm64\tii \t2\n", false],
			["libc6\tarmhf\tii \t2\n", true],
		] as const)
			expect([rows, await withdrawn({ rows }, [], name)]).toEqual([
				rows,
				expected,
			]);
	} finally {
		notificationWithdraw(name);
	}
});
