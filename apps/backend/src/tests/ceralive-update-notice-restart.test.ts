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

type Step = Omit<SessionStep, "record" | "scratch" | "boot"> & {
	readonly boot?: string;
};

async function session(step: Step = {}) {
	const input: SessionStep = { boot: "boot-a", ...step, record, scratch: root };
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
		stderr,
		frames: z
			.array(z.unknown())
			.parse(JSON.parse(line.slice(FRAMES_PREFIX.length))),
	};
}

function currentTab(frames: readonly unknown[], start: string[] = []) {
	const shown = new Set(start);
	for (const frame of frames) {
		const parsed = notificationsMessageSchema.safeParse(frame);
		if (!parsed.success) continue;
		for (const { name } of parsed.data.show ?? []) shown.add(name);
		for (const { id } of parsed.data.remove ?? []) shown.delete(id);
	}
	return [...shown];
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
		const open = currentTab(before.frames);
		const legacy = legacyTab(before.frames);
		expect(open).toEqual([NOTICE]);
		expect(legacy).toEqual([NOTICE]);
		// When the package script restarts the backend: it recovers the finished
		// install and exits through the update's own restart, with no check run.
		const packageRestart = await session({ recoverInstall: true });
		expect(packageRestart.exit).toBe(RESTART_EXIT_CODE);
		// An install result is not evidence: a tab reconnecting now keeps its copy.
		expect(currentTab(packageRestart.frames, open)).toEqual([NOTICE]);
		expect(legacyTab(packageRestart.frames, legacy)).toEqual([NOTICE]);
		// When the completion restart's conclusive check finds nothing pending
		// and that process exits before either tab reconnects.
		await session({ check: NOTHING_PENDING });
		// Then a later process whose own refresh fails still withdraws it on reconnect.
		const reconnect = await session({ check: REFRESH_FAILS });
		expect(currentTab(reconnect.frames, open)).toEqual([]);
		expect(legacyTab(reconnect.frames, legacy)).toEqual([]);
		// And a freshly opened tab never shows it.
		expect(currentTab(reconnect.frames)).toEqual([]);
		// When a later process finds a newer release, a tab holding it is never told to drop it.
		const newer = await session({ check: pending("3") });
		expect(currentTab(newer.frames, [NOTICE])).toEqual([NOTICE]);
		expect(legacyTab(newer.frames, [NOTICE])).toEqual([NOTICE]);
		// And a restart that runs no check keeps it for every reconnecting tab.
		const idle = await session();
		expect(currentTab(idle.frames, [NOTICE])).toEqual([NOTICE]);
		expect(legacyTab(idle.frames, [NOTICE])).toEqual([NOTICE]);
	},
	SEQUENCE_TIMEOUT_MS,
);

test(
	"a same-boot downgrade and re-upgrade cannot replay an obsolete withdrawal",
	async () => {
		// Given this build recorded a withdrawal.
		await session({ check: pending("2"), build: "build-a" });
		await session({ check: NOTHING_PENDING, build: "build-a" });
		// When an older backend, which never writes the record, shows a new offer in the
		// same boot, and the re-upgraded build restarts before its first check.
		const upgraded = await session({ build: "build-b" });
		// Then tabs holding the older backend's offer keep it.
		expect(currentTab(upgraded.frames, [NOTICE])).toEqual([NOTICE]);
		expect(legacyTab(upgraded.frames, [NOTICE])).toEqual([NOTICE]);
		// Control: the build that wrote the record still restores its own withdrawal.
		const same = await session({ build: "build-a" });
		expect(currentTab(same.frames, [NOTICE])).toEqual([]);
		expect(legacyTab(same.frames, [NOTICE])).toEqual([]);
	},
	SEQUENCE_TIMEOUT_MS,
);

test(
	"a fresh backend that finds an already-dismissed successor withdraws the predecessor",
	async () => {
		const before = await session({ check: pending("2") });
		const open = currentTab(before.frames);
		// Given the operator dismissed release 3 elsewhere.
		await writeFile(
			dismissals,
			JSON.stringify({
				version: 1,
				entries: [{ key: "update:cerastream=3", dismissedAt: 1 }],
			}),
		);
		// When a fresh process conclusively finds release 3.
		const successor = await session({ check: pending("3") });
		expect(currentTab(successor.frames, open)).toEqual([]);
		// Then the withdrawal also survives into the next process.
		expect(currentTab((await session()).frames, open)).toEqual([]);
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
		expect(currentTab(dismissed.frames, [NOTICE])).toEqual([]);
		expect(currentTab((await session()).frames, [NOTICE])).toEqual([]);
		expect(
			currentTab((await session({ check: pending("2") })).frames, [NOTICE]),
		).toEqual([]);
		expect(currentTab((await session({ check: pending("3") })).frames)).toEqual(
			[NOTICE],
		);
	},
	SEQUENCE_TIMEOUT_MS,
);

test(
	"a record from an earlier boot cannot withdraw anything after a reboot",
	async () => {
		await session({ check: NOTHING_PENDING });
		expect(currentTab((await session()).frames, [NOTICE])).toEqual([]);
		// When the device rebooted (an older CeraUI may have run meanwhile).
		const rebooted = await session({ boot: "boot-b" });
		// Then the old verdict says nothing about what a tab now shows.
		expect(currentTab(rebooted.frames, [NOTICE])).toEqual([NOTICE]);
		// Until this boot's own conclusive check proves it.
		const proven = await session({ boot: "boot-b", check: NOTHING_PENDING });
		expect(currentTab(proven.frames, [NOTICE])).toEqual([]);
	},
	SEQUENCE_TIMEOUT_MS,
);

test(
	"startup derives nothing from a missing, corrupt or wrong-kind record, or unreadable dismissals",
	async () => {
		expect(currentTab((await session()).frames, [NOTICE])).toEqual([NOTICE]);
		await writeFile(record, "{");
		expect(currentTab((await session()).frames, [NOTICE])).toEqual([NOTICE]);
		await rm(record);
		await mkdir(record);
		expect(currentTab((await session()).frames, [NOTICE])).toEqual([NOTICE]);
		await rm(record, { recursive: true });
		// A forged multi-package key cannot be smuggled into one row's version.
		await writeFile(
			record,
			JSON.stringify({
				version: 1,
				boot: "boot-a",
				offer: [{ name: "cerastream", version: "2,srtla=3" }],
			}),
		);
		expect(currentTab((await session()).frames, [NOTICE])).toEqual([NOTICE]);
		await rm(record);
		// Given an offer whose dismissal state cannot be read.
		await session({ check: pending("2") });
		await mkdir(dismissals);
		expect(currentTab((await session()).frames, [NOTICE])).toEqual([NOTICE]);
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
		expect(currentTab(unwritten.frames)).toEqual([]);
		// Given the offer is durable and shown.
		const shown = await session({ check: pending("2") });
		const open = currentTab(shown.frames);
		expect(open).toEqual([NOTICE]);
		// When "nothing pending" cannot be persisted, the offer is not withdrawn.
		const kept = await session({ check: NOTHING_PENDING, failWrites: true });
		expect(currentTab(kept.frames, open)).toEqual([NOTICE]);
		// And the next process still trusts the durable offer, not the lost verdict.
		expect(currentTab((await session()).frames, open)).toEqual([NOTICE]);
	},
	SEQUENCE_TIMEOUT_MS,
);
