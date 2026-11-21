/// <reference types="bun" />
/*
 * The update that the "CeraLive update is available" notice offers restarts the
 * backend twice, and a tab can be offline for both. Each session below is a real
 * fresh backend process (helpers/ceralive-update-session.ts) sharing only the
 * files a device keeps; the frames it prints are what an authenticating tab
 * receives, applied here to a current tab, a pre-#183 tab and a fresh tab.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notificationsMessageSchema } from "@ceraui/rpc/schemas";
import { z } from "zod";

import {
	type AptScript,
	FRAMES_PREFIX,
	RECOVERY_FAILED_MARKER,
	RECOVERY_RESTART_MARKER,
	RESTART_EXIT_CODE,
} from "./helpers/ceralive-update-apt.ts";
import type { SessionStep } from "./helpers/ceralive-update-session.ts";

const NOTICE = "ceralive_update";
const SESSION_TIMEOUT_MS = 45_000;
const SEQUENCE_TIMEOUT_MS = 8 * SESSION_TIMEOUT_MS;
const SESSION = new URL("./helpers/ceralive-update-session.ts", import.meta.url)
	.pathname;
const SETUP = new URL("../../setup.json", import.meta.url).pathname;

let root: string;
let record: string;
let dismissals: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ceralive-update-restart-"));
	record = join(root, "ceralive_update_offer.json");
	dismissals = join(root, "dismissals.json");
	await mkdir(join(root, "cwd"));
	await copyFile(SETUP, join(root, "cwd", "setup.json"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

type Step = Omit<SessionStep, "record" | "scratch">;

async function session(step: Step = {}) {
	const input: SessionStep = { ...step, record, scratch: root };
	await using child = Bun.spawn(
		[process.execPath, SESSION, JSON.stringify(input)],
		{
			cwd: join(root, "cwd"),
			timeout: SESSION_TIMEOUT_MS,
			killSignal: "SIGKILL",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				CERALIVE_DISMISSALS_FILE: dismissals,
				CERALIVE_STREAMING_MARKER: join(root, "streaming"),
				CERALIVE_EVENTS_DIR: join(root, "events"),
				DOCKER_HOST: "unix:///nonexistent/docker.sock",
			},
		},
	);
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const line = stdout
		.split("\n")
		.find((entry) => entry.startsWith(FRAMES_PREFIX));
	if (line === undefined)
		throw new Error(`no frames (exit ${exit}): ${stderr}`);
	if (!step.recoverInstall && exit !== 0)
		throw new Error(`session exited ${exit}: ${stderr}`);
	return {
		exit,
		stdout,
		stderr,
		frames: z
			.array(z.unknown())
			.parse(JSON.parse(line.slice(FRAMES_PREFIX.length))),
	};
}

// What a tab holds: each notice name and the release its copy offers (none for
// copies from producers that predate release-scoped notices).
type Tab = ReadonlyMap<string, string | undefined>;
const copy = (release?: string): Tab => new Map([[NOTICE, release]]);
const RELEASE_2 = "update:cerastream=2";
const RELEASE_3 = "update:cerastream=3";

// The current frontend: typed frames only; `withdraw` drops only the named release.
function tabOf(frames: readonly unknown[], start: Tab = new Map()): Tab {
	const held = new Map(start);
	for (const frame of frames) {
		const parsed = notificationsMessageSchema.safeParse(frame);
		if (!parsed.success) continue;
		for (const { name, release } of parsed.data.show ?? [])
			held.set(name, release);
		for (const { id } of parsed.data.remove ?? []) held.delete(id);
		for (const { id, release } of parsed.data.withdraw ?? [])
			if (held.has(id) && held.get(id) === release) held.delete(id);
	}
	return held;
}

function currentTab(frames: readonly unknown[], start: Tab = new Map()) {
	return [...tabOf(frames, start).keys()];
}

// The v2026.7.2 frontend: no validation, `remove` entries go straight to the store.
function legacyTab(frames: readonly unknown[], start: string[] = []) {
	const shown = new Set<unknown>(start);
	for (const frame of frames) {
		const message = frame as { show?: { name: string }[]; remove?: unknown[] };
		for (const { name } of message.show ?? []) shown.add(name);
		for (const entry of message.remove ?? []) shown.delete(entry);
	}
	return [...shown].map(String);
}

// Every copy a session's frames show, as [name, release].
function shows(frames: readonly unknown[]) {
	return frames.flatMap((frame) =>
		(notificationsMessageSchema.safeParse(frame).data?.show ?? []).map(
			({ name, release }) => [name, release],
		),
	);
}

// Every removal a session's frames carry, in each wire form.
function removals(frames: readonly unknown[]) {
	return frames.flatMap((frame) => {
		const message = frame as {
			remove?: unknown[];
			withdraw?: { id: string; release: string }[];
		};
		return [
			...(message.remove ?? []).map((entry) =>
				typeof entry === "string"
					? ["string", entry]
					: ["typed", (entry as { id: string }).id],
			),
			...(message.withdraw ?? []).map(({ id, release }) => [
				"withdraw",
				id,
				release,
			]),
		];
	});
}

const pending = (version: string): AptScript => ({
	upgradable: [{ name: "cerastream", installed: "1", candidate: version }],
});
const NOTHING_PENDING: AptScript = {};
const REFRESH_FAILS: AptScript = {
	refresh: { exitCode: 100, stderr: "E: Could not get lock\n" },
};

test(
	"install, package-script restart, completion restart and reconnect clear the offer in open and fresh tabs",
	async () => {
		// Given a tab of each frontend generation showing the offer before the install.
		const before = await session({ check: pending("2") });
		const open = tabOf(before.frames);
		const legacy = legacyTab(before.frames);
		expect([...open]).toEqual([[NOTICE, RELEASE_2]]);
		expect(legacy).toEqual([NOTICE]);
		// When the package script restarts the backend: it recovers the finished
		// install and exits through exactly the update's own restart, with no check run.
		const packageRestart = await session({ recoverInstall: true });
		expect(packageRestart.exit).toBe(RESTART_EXIT_CODE);
		expect(packageRestart.stdout).toContain(RECOVERY_RESTART_MARKER);
		expect(packageRestart.stderr).not.toContain(RECOVERY_FAILED_MARKER);
		// An install result is not evidence: a tab reconnecting now keeps its copy.
		expect(removals(packageRestart.frames)).toEqual([]);
		expect(currentTab(packageRestart.frames, open)).toEqual([NOTICE]);
		expect(legacyTab(packageRestart.frames, legacy)).toEqual([NOTICE]);
		// When the completion restart's conclusive check finds nothing pending
		// and that process exits before either tab reconnects.
		await session({ check: NOTHING_PENDING });
		// Then a later process whose own refresh fails retracts exactly that release.
		const reconnect = await session({ check: REFRESH_FAILS });
		expect(removals(reconnect.frames)).toEqual([
			["withdraw", NOTICE, RELEASE_2],
		]);
		expect(currentTab(reconnect.frames, open)).toEqual([]);
		// A pre-#183 tab cannot tell releases apart, so it waits for current evidence.
		expect(legacyTab(reconnect.frames, legacy)).toEqual([NOTICE]);
		// And a freshly opened tab never shows it.
		expect(currentTab(reconnect.frames)).toEqual([]);
		// When the next process's own check proves nothing pending, every tab drops it.
		const proven = await session({ check: NOTHING_PENDING });
		expect(currentTab(proven.frames, open)).toEqual([]);
		expect(legacyTab(proven.frames, legacy)).toEqual([]);
		// When a later process finds a newer release, it shows it and removes nothing.
		const newer = await session({ check: pending("3") });
		expect(shows(newer.frames)).toEqual([[NOTICE, RELEASE_3]]);
		expect(removals(newer.frames)).toEqual([]);
		// And a restart that runs no check shows nothing and leaves release 3 alone.
		const idle = await session();
		expect(shows(idle.frames)).toEqual([]);
		expect(removals(idle.frames)).toEqual([["withdraw", NOTICE, RELEASE_2]]);
		expect(currentTab(idle.frames, copy(RELEASE_3))).toEqual([NOTICE]);
		expect(legacyTab(idle.frames, [NOTICE])).toEqual([NOTICE]);
	},
	SEQUENCE_TIMEOUT_MS,
);

test(
	"a recovery that fails is never taken for the update's restart",
	async () => {
		const failed = await session({ recoverInstall: true, recoverFails: true });
		expect(failed.exit).not.toBe(RESTART_EXIT_CODE);
		expect(failed.stdout).not.toContain(RECOVERY_RESTART_MARKER);
		expect(failed.stderr).toContain(RECOVERY_FAILED_MARKER);
	},
	SEQUENCE_TIMEOUT_MS,
);

test(
	"an older backend's offer survives the restored backend's replay of an earlier withdrawal",
	async () => {
		// Given offer 2 shown in two tabs, then proven obsolete and recorded.
		const shown = await session({ check: pending("2") });
		const offline = tabOf(shown.frames);
		await session({ check: NOTHING_PENDING });
		// When a rollback runs an older backend: it shows its offer the way main
		// did and never touches the record.
		const older = await session({ olderBackend: true });
		const holding = tabOf(older.frames, tabOf(shown.frames));
		const legacy = legacyTab(older.frames);
		expect([...holding]).toEqual([[NOTICE, undefined]]);
		// When the original backend is restored and replays before any check.
		const restored = await session();
		// Then only the exact withdrawn release is named, never the name alone.
		expect(removals(restored.frames)).toEqual([
			["withdraw", NOTICE, RELEASE_2],
		]);
		// So the older backend's offer survives in both frontend generations.
		expect(currentTab(restored.frames, holding)).toEqual([NOTICE]);
		expect(legacyTab(restored.frames, legacy)).toEqual([NOTICE]);
		// While a tab that still holds the withdrawn release 2 drops it.
		expect(currentTab(restored.frames, offline)).toEqual([]);
	},
	SEQUENCE_TIMEOUT_MS,
);

test(
	"a fresh backend that finds an already-dismissed successor withdraws the predecessor",
	async () => {
		const before = await session({ check: pending("2") });
		const open = tabOf(before.frames);
		// Given the operator dismissed release 3 elsewhere.
		await writeFile(
			dismissals,
			JSON.stringify({
				version: 1,
				entries: [{ key: RELEASE_3, dismissedAt: 1 }],
			}),
		);
		// When a fresh process conclusively finds release 3.
		const successor = await session({ check: pending("3") });
		expect(currentTab(successor.frames, open)).toEqual([]);
		// Then the withdrawal also survives into the next process, for either release.
		const next = await session();
		expect(currentTab(next.frames, open)).toEqual([]);
		expect(currentTab(next.frames, copy(RELEASE_3))).toEqual([]);
		// And a release that was never dismissed is offered again.
		expect(currentTab((await session({ check: pending("4") })).frames)).toEqual(
			[NOTICE],
		);
	},
	SEQUENCE_TIMEOUT_MS,
);

test(
	"a dismissal reaches other tabs after a restart and covers that release only",
	async () => {
		const dismissed = await session({ check: pending("2"), dismiss: true });
		expect(currentTab(dismissed.frames, copy(RELEASE_2))).toEqual([]);
		expect(currentTab((await session()).frames, copy(RELEASE_2))).toEqual([]);
		expect(
			currentTab(
				(await session({ check: pending("2") })).frames,
				copy(RELEASE_2),
			),
		).toEqual([]);
		expect(currentTab((await session({ check: pending("3") })).frames)).toEqual(
			[NOTICE],
		);
	},
	SEQUENCE_TIMEOUT_MS,
);

test(
	"a restored withdrawal retracts only the release it proved obsolete, however many restarts later",
	async () => {
		await session({ check: pending("2") });
		await session({ check: NOTHING_PENDING });
		for (let restart = 0; restart < 2; restart++) {
			const replay = (await session()).frames;
			expect(currentTab(replay, copy(RELEASE_2))).toEqual([]);
			// A different release, or a copy from an older producer, is left alone.
			expect(currentTab(replay, copy(RELEASE_3))).toEqual([NOTICE]);
			expect(currentTab(replay, copy())).toEqual([NOTICE]);
		}
		// Until a process's own conclusive check proves nothing is pending at all.
		const proven = await session({ check: NOTHING_PENDING });
		expect(currentTab(proven.frames, copy())).toEqual([]);
		expect(legacyTab(proven.frames, [NOTICE])).toEqual([]);
	},
	SEQUENCE_TIMEOUT_MS,
);

test(
	"startup derives nothing without a readable, current-schema record and acknowledgement store",
	async () => {
		// Given no record at all.
		expect(currentTab((await session()).frames, copy(RELEASE_2))).toEqual([
			NOTICE,
		]);
		// Given an acknowledgement for release 2, so an accepted record would act.
		await writeFile(
			dismissals,
			JSON.stringify({
				version: 1,
				entries: [
					{ key: RELEASE_2, dismissedAt: 1 },
					{ key: "update:cerastream=2,srtla=3", dismissedAt: 1 },
				],
			}),
		);
		const row = { name: "cerastream", version: "2" };
		const refused: Record<string, string> = {
			corrupt: "{",
			prior: JSON.stringify({ version: 1, boot: "b", build: "x", offer: [] }),
			future: JSON.stringify({ version: 3, offer: [row], withdrawn: [] }),
			duplicate: `{"version":2,"offer":[],"withdrawn":[],"withdrawn":[[${JSON.stringify(row)}]]}`,
			oversized: JSON.stringify({
				version: 2,
				offer: [row],
				withdrawn: [],
			}).padEnd(5000, " "),
			// A forged multi-package key cannot be smuggled into one row's version.
			forged: JSON.stringify({
				version: 2,
				offer: [{ name: "cerastream", version: "2,srtla=3" }],
				withdrawn: [],
			}),
		};
		for (const [kind, text] of Object.entries(refused)) {
			await writeFile(record, text);
			const tab =
				kind === "forged"
					? copy("update:cerastream=2,srtla=3")
					: copy(RELEASE_2);
			expect([kind, currentTab((await session()).frames, tab)]).toEqual([
				kind,
				[NOTICE],
			]);
		}
		// Control: the same acknowledgement under a valid record does retract release 2.
		await writeFile(
			record,
			JSON.stringify({ version: 2, offer: [row], withdrawn: [] }),
		);
		expect(currentTab((await session()).frames, copy(RELEASE_2))).toEqual([]);
		await rm(record);
		await rm(dismissals);
		// Given a directory where the record should be.
		await mkdir(record);
		expect(currentTab((await session()).frames, copy(RELEASE_2))).toEqual([
			NOTICE,
		]);
		await rm(record, { recursive: true });
		// Given an offer whose dismissal state cannot be read.
		const shown = await session({ check: pending("2") });
		const open = tabOf(shown.frames);
		await mkdir(dismissals);
		expect(currentTab((await session()).frames, open)).toEqual([NOTICE]);
		// A proven absence needs no acknowledgement store, live and on later replay.
		const absent = await session({ check: NOTHING_PENDING });
		expect(currentTab(absent.frames, open)).toEqual([]);
		expect(legacyTab(absent.frames, [NOTICE])).toEqual([]);
		expect(currentTab((await session()).frames, open)).toEqual([]);
	},
	SEQUENCE_TIMEOUT_MS,
);

test(
	"a verdict that cannot be written changes nothing, in either direction",
	async () => {
		// Given a durable "nothing pending" and no offer anywhere.
		await session({ check: NOTHING_PENDING });
		// When a newer offer is found but cannot be persisted.
		const unwritten = await session({ check: pending("2"), failWrites: true });
		// Then it is not shown, so no older verdict can later contradict a tab.
		expect(shows(unwritten.frames)).toEqual([]);
		expect(removals(unwritten.frames)).toEqual([]);
		// Given the offer is durable and shown.
		const shown = await session({ check: pending("2") });
		const open = tabOf(shown.frames);
		expect([...open]).toEqual([[NOTICE, RELEASE_2]]);
		// When "nothing pending" cannot be persisted, the offer is not withdrawn.
		const kept = await session({ check: NOTHING_PENDING, failWrites: true });
		expect(removals(kept.frames)).toEqual([]);
		expect(currentTab(kept.frames, open)).toEqual([NOTICE]);
		// And the next process still trusts the durable offer, not the lost verdict.
		expect(currentTab((await session()).frames, open)).toEqual([NOTICE]);
	},
	SEQUENCE_TIMEOUT_MS,
);
