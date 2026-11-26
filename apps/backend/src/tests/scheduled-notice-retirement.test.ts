/// <reference types="bun" />
/*
 * Each case runs the real withdrawal pass over a scripted device and a real
 * notification slot. A clean dpkg-query read at the exact version can clear it;
 * APT policy cannot authorize withdrawal of a skipped version.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SpawnWithTimeoutResult } from "../helpers/spawn-policy.ts";
import { resolveEventsDir } from "../modules/events/store.ts";
import { setAptCommandRunnerForTest } from "../modules/system/software-updates.ts";
import { noticeTargets } from "../modules/system/update-orchestrator/package-notice-proofs.ts";
import {
	retireFulfilledPackageNotices,
	scheduledPackageNoticeIdentity,
} from "../modules/system/update-orchestrator/package-notice-retirement.ts";
import { setOrchestratorStateFilePathForTest } from "../modules/system/update-orchestrator/persistence.ts";
import {
	notificationExists,
	notificationSend,
	notificationWithdraw,
} from "../modules/ui/notifications.ts";

type Read = "native" | "dpkg";
type Answer = Partial<SpawnWithTimeoutResult> | "throw";
type Device = {
	readonly rows?: string;
	readonly answers?: Partial<Record<Read, Answer>>;
	readonly duringRead?: () => void;
};

const NAME = "update:updates-available:curl=2";
const ROWS = "curl\tarm64\tii \t2\n";
const NEWER_ROWS = "curl\tarm64\tii \t3\n";
const ok = (stdout: string): SpawnWithTimeoutResult => ({
	exitCode: 0,
	stdout,
	stderr: "",
});

const readOf = (argv: readonly string[]): Read | "unexpected" =>
	argv[0] === "dpkg-query" && argv[1] === "-W"
		? "dpkg"
		: argv[0] === "dpkg" && argv[1] === "--print-architecture"
			? "native"
			: "unexpected";

let ran: ReturnType<typeof readOf>[] = [];

function device({ rows = ROWS, answers, duringRead }: Device) {
	return async (argv: readonly string[]): Promise<SpawnWithTimeoutResult> => {
		const read = readOf(argv);
		ran.push(read);
		if (read === "unexpected")
			throw new Error(`unexpected retirement command: ${argv[0]}`);
		if (read === "dpkg") duringRead?.();
		const answer = answers?.[read];
		if (answer === "throw") throw new Error(`${read} did not answer`);
		const clean = ok(read === "native" ? "arm64\n" : rows);
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

test("a newer installed version keeps the notice without a fallback read", async () => {
	expect(await withdrawn({ rows: NEWER_ROWS })).toBe(false);
	expect(ran).toEqual(["native", "dpkg"]);
});

test("an exact installed version needs no comparison or policy read", async () => {
	expect(await withdrawn({ rows: "curl\tarm64\tii \t2\n" })).toBe(true);
	expect(ran).toEqual(["native", "dpkg"]);
});

test("every proper prefix of a native or installed-version read keeps the notice", async () => {
	for (const [read, full, commands] of [
		["native", "arm64\n", ["native"]],
		["dpkg", ROWS, ["native", "dpkg"]],
	] as const)
		for (let end = 0; end < full.length; end++) {
			const stdout = full.slice(0, end);
			expect([
				read,
				end,
				await withdrawn({ answers: { [read]: { stdout } } }),
			]).toEqual([read, end, false]);
			expect(ran).toEqual([...commands]);
		}
});

test("a multilined architecture answer cannot prove a bare all-architecture target", async () => {
	expect(
		await withdrawn({
			rows: "curl\tall\tii \t2\n",
			answers: { native: { stdout: "arm64\n\n" } },
		}),
	).toBe(false);
	expect(ran).toEqual(["native"]);
});

test("a failed, noisy or unanswered read keeps the notice", async () => {
	const faults: readonly Answer[] = [
		{ exitCode: 1 },
		{ exitCode: 100 },
		{ stderr: "W: something\n" },
		"throw",
	];
	for (const [read, commands] of [
		["native", ["native"]],
		["dpkg", ["native", "dpkg"]],
	] as const)
		for (const fault of faults) {
			expect([
				read,
				fault,
				await withdrawn({ answers: { [read]: fault } }),
			]).toEqual([read, fault, false]);
			expect(ran).toEqual([...commands]);
		}
	expect(await withdrawn({ answers: { dpkg: { stdout: "x\n" } } })).toBe(false);
	expect(ran).toEqual(["native", "dpkg"]);
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

test("other installed instances and malformed evidence never substitute for an exact match", async () => {
	const answers = [
		"curl\tarm64\tii \t3\ncurl\tarmhf\tii \t2\n",
		"curl\tall\tii \t3\ncurl\tarmhf\tii \t2\n",
		"curl\tarm64\tii \t2\ncurl\tarm64\tii \t3\n",
		"curl\tarm64\tii \t3\ncurl\tarm64\tii \t3\n",
		"curl\tarmhf\tii \t3\n",
		"\tarm64\tii \t3\n",
	];
	for (const rows of answers)
		expect([rows, await withdrawn({ rows }), ran]).toEqual([
			rows,
			false,
			["native", "dpkg"],
		]);
});

test("a compact live slot can use its exact offer without history, within the target budget", async () => {
	const state = join(resolveEventsDir(), "../update-state");
	mkdirSync(join(state, "scheduled-package-notices.json"), { recursive: true });
	setOrchestratorStateFilePathForTest(join(state, "agent.json"));
	try {
		for (const [count, expected] of [
			[42, true],
			[513, false],
		] as const) {
			const names = Array.from(
				{ length: count },
				(_, index) => `compact-live-fixture-package-${index}`,
			);
			const id = scheduledPackageNoticeIdentity(
				names
					.map((name) => `${name}=2`)
					.sort()
					.join(","),
			);
			const name = `update:updates-available:${id}`;
			try {
				const rows = names.map((pkg) => `${pkg}\tarm64\tii \t2\n`).join("");
				expect(await withdrawn({ rows }, [], name)).toBe(expected);
				expect(ran).toEqual(expected ? ["native", "dpkg"] : []);
			} finally {
				notificationWithdraw(name);
			}
		}
	} finally {
		setOrchestratorStateFilePathForTest(null);
	}
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

test("a qualified package named sha256 retains its plain notice identity", async () => {
	const name = "update:updates-available:sha256:arm64=2";
	try {
		expect(await withdrawn({ rows: "sha256\tarm64\tii \t2\n" }, [], name)).toBe(
			true,
		);
		expect(ran).toEqual(["native", "dpkg"]);
	} finally {
		notificationWithdraw(name);
	}
});

test.each([
	["arm64", "curl\tarm64\tii \t2\n", false],
	["all", "curl\tall\tii \t2\n", false],
	["armhf", "curl\tarm64\tii \t2\ncurl\tarmhf\tii \t2\n", true],
] as const)(
	"each offered target must use a distinct installed row (%s)",
	async (arch, rows, expected) => {
		const name = `update:updates-available:curl=2,curl:${arch}=2`;
		try {
			expect(await withdrawn({ rows }, [], name)).toBe(expected);
		} finally {
			notificationWithdraw(name);
		}
	},
);
