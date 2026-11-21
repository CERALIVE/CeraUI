/// <reference types="bun" />
/*
 * The update that the "CeraLive update is available" notice offers restarts the
 * backend twice, and a tab can be offline for both. Each session below is a real
 * fresh backend process (helpers/ceralive-update-session.ts) sharing only the
 * files a device keeps; the frames it prints are what an authenticating tab
 * receives, applied here to a current tab, a pre-#183 tab and a fresh tab.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notificationsMessageSchema } from "@ceraui/rpc/schemas";
import { z } from "zod";
import { OFFER_VERSION_LIMIT } from "../modules/system/ceralive-update-notice.ts";
import { ceralivePackageList } from "../modules/system/package-layer.ts";
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
// A sequence's deadline covers every child it starts, plus one.
const budget = (children: number) => (children + 1) * SESSION_TIMEOUT_MS;
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

type Issuance = { lineage: string; generation: number };
// What a current tab holds: each notice name and the issuance its copy carries
// (none for copies from producers that predate issuances).
type Tab = ReadonlyMap<string, Issuance | undefined>;
const copy = (issuance?: Issuance): Tab => new Map([[NOTICE, issuance]]);

// The current frontend: a scoped removal retires only this lineage's issuances
// up to its generation; an unscoped one removes by name.
function tabOf(frames: readonly unknown[], start: Tab = new Map()): Tab {
	const held = new Map(start);
	for (const frame of frames) {
		const parsed = notificationsMessageSchema.safeParse(frame);
		if (!parsed.success) continue;
		for (const { name, issuance } of parsed.data.show ?? [])
			held.set(name, issuance);
		for (const { id, issuance: scope } of parsed.data.remove ?? []) {
			const copyHeld = held.get(id);
			if (
				!scope ||
				(copyHeld?.lineage === scope.lineage &&
					copyHeld.generation <= scope.generation)
			)
				held.delete(id);
		}
	}
	return held;
}

function currentTab(frames: readonly unknown[], start: Tab = new Map()) {
	return [...tabOf(frames, start).keys()];
}

// A bundle from main (after #183): typed frames, `remove` drops by id, no scope.
function mainTab(frames: readonly unknown[], start: string[] = []) {
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

// Every copy a session's frames show, as [name, issuance].
function shows(frames: readonly unknown[]) {
	return frames.flatMap((frame) =>
		(notificationsMessageSchema.safeParse(frame).data?.show ?? []).map(
			({ name, issuance }) => [name, issuance],
		),
	);
}

// Every removal a session's frames carry, in each wire form.
function removals(frames: readonly unknown[]) {
	return frames.flatMap((frame) =>
		((frame as { remove?: unknown[] }).remove ?? []).map((entry) =>
			typeof entry === "string"
				? ["string", entry]
				: [
						"typed",
						(entry as { id: string }).id,
						(entry as { issuance?: Issuance }).issuance,
					],
		),
	);
}

async function lineage(): Promise<string> {
	return z
		.object({ lineage: z.string() })
		.parse(JSON.parse(await readFile(record, "utf8"))).lineage;
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
		// Given tabs of each frontend generation showing issuance 1 before the install.
		const before = await session({ check: pending("2") });
		const issued = { lineage: await lineage(), generation: 1 };
		expect(shows(before.frames)).toEqual([[NOTICE, issued]]);
		const open = tabOf(before.frames);
		const main = mainTab(before.frames);
		const legacy = legacyTab(before.frames);
		// When the package script restarts the backend: it recovers the finished
		// install and exits through exactly the update's own restart, with no check run.
		const packageRestart = await session({ recoverInstall: true });
		expect(packageRestart.exit).toBe(RESTART_EXIT_CODE);
		expect(packageRestart.stdout).toContain(RECOVERY_RESTART_MARKER);
		expect(packageRestart.stderr).not.toContain(RECOVERY_FAILED_MARKER);
		// An install result is not evidence: a tab reconnecting now keeps its copy.
		expect(removals(packageRestart.frames)).toEqual([]);
		// When the completion restart's conclusive check finds nothing pending,
		// a tab connected to it drops the offer in every frontend generation.
		const completion = await session({ check: NOTHING_PENDING });
		expect(currentTab(completion.frames, open)).toEqual([]);
		expect(mainTab(completion.frames, main)).toEqual([]);
		expect(legacyTab(completion.frames, legacy)).toEqual([]);
		// Then a tab that missed that process still drops it on reconnect, even
		// though this process's own refresh fails.
		const reconnect = await session({ check: REFRESH_FAILS });
		expect(removals(reconnect.frames)).toEqual([
			["typed", NOTICE, issued],
			["string", NOTICE],
		]);
		expect(currentTab(reconnect.frames, open)).toEqual([]);
		expect(mainTab(reconnect.frames, main)).toEqual([]);
		expect(legacyTab(reconnect.frames, legacy)).toEqual([]);
		// And a freshly opened tab never shows it.
		expect(currentTab(reconnect.frames)).toEqual([]);
		// When a later process finds a newer release, it shows a new issuance and removes nothing.
		const newer = await session({ check: pending("3") });
		expect(shows(newer.frames)).toEqual([
			[NOTICE, { lineage: issued.lineage, generation: 2 }],
		]);
		expect(removals(newer.frames)).toEqual([]);
		// And a restart that runs no check shows nothing and removes nothing.
		const idle = await session();
		expect(shows(idle.frames)).toEqual([]);
		expect(removals(idle.frames)).toEqual([]);
	},
	budget(7),
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

for (const capable of [false, true])
	test(
		`an update from a backend before this notice clears tabs that missed the proving process (${capable ? "capable" : "legacy"} image)`,
		async () => {
			// Given main's backend showing its offer (no issuance) in a main-era and a v2026.7.2 tab.
			const older = await session({ olderBackend: true });
			const main = mainTab(older.frames);
			const legacy = legacyTab(older.frames);
			expect([main, legacy]).toEqual([[NOTICE], [NOTICE]]);
			// When the package script restarts into this backend, which recovers the install.
			const packageRestart = await session({ recoverInstall: true, capable });
			expect(packageRestart.exit).toBe(RESTART_EXIT_CODE);
			expect(packageRestart.stdout).toContain(RECOVERY_RESTART_MARKER);
			expect(removals(packageRestart.frames)).toEqual([]);
			expect([
				mainTab(packageRestart.frames, main),
				legacyTab(packageRestart.frames, legacy),
			]).toEqual([[NOTICE], [NOTICE]]);
			// When the completion process proves nothing pending while both tabs are offline.
			await session({ check: NOTHING_PENDING, capable });
			// Then the next process, whose own refresh fails, clears both on reconnect.
			const reconnect = await session({ check: REFRESH_FAILS, capable });
			expect(mainTab(reconnect.frames, main)).toEqual([]);
			expect(legacyTab(reconnect.frames, legacy)).toEqual([]);
			// And every later conclusive check repeats it for tabs that stayed connected.
			const again = await session({ check: NOTHING_PENDING, capable });
			expect(legacyTab(again.frames, [NOTICE])).toEqual([]);
			expect(mainTab(again.frames, [NOTICE])).toEqual([]);
		},
		budget(5),
	);

test(
	"an older backend's offer survives in a current tab across the restored backend's replay",
	async () => {
		// Given issuance 1 shown, then proven obsolete and recorded.
		const shown = await session({ check: pending("2") });
		const offline = tabOf(shown.frames);
		await session({ check: NOTHING_PENDING });
		const issued = { lineage: await lineage(), generation: 1 };
		// When a rollback runs an older backend: it shows its offer the way main
		// did and never touches the record.
		const older = await session({ olderBackend: true });
		const holding = tabOf(older.frames, tabOf(shown.frames));
		expect([...holding]).toEqual([[NOTICE, undefined]]);
		// When the original backend is restored and replays before any check.
		const restored = await session();
		expect(removals(restored.frames)).toEqual([
			["typed", NOTICE, issued],
			["string", NOTICE],
		]);
		// Then a current tab keeps the older backend's offer and drops issuance 1.
		expect(currentTab(restored.frames, holding)).toEqual([NOTICE]);
		expect(currentTab(restored.frames, offline)).toEqual([]);
		// Older bundles cannot tell the two copies apart, so they clear (the
		// accepted trade-off); the restored backend's first conclusive check re-shows a real offer.
		expect(mainTab(restored.frames, mainTab(older.frames))).toEqual([]);
		expect(legacyTab(restored.frames, legacyTab(older.frames))).toEqual([]);
		const rechecked = await session({ check: pending("4") });
		expect(currentTab(rechecked.frames)).toEqual([NOTICE]);
	},
	budget(5),
);

test(
	"an old record's replay never retires a newer issuance, even of the same packages",
	async () => {
		await session({ check: pending("2") });
		await session({ check: NOTHING_PENDING });
		const line = await lineage();
		const stale = await readFile(record, "utf8");
		// Given the same packages offered again (issuance 2), then a different release (issuance 3).
		const again = await session({ check: pending("2") });
		expect(shows(again.frames)).toEqual([
			[NOTICE, { lineage: line, generation: 2 }],
		]);
		const reissued = tabOf(again.frames);
		const next = await session({ check: pending("3") });
		expect(shows(next.frames)).toEqual([
			[NOTICE, { lineage: line, generation: 3 }],
		]);
		const successor = tabOf(next.frames);
		// When the earlier record is restored (state recovery) and a backend replays it.
		await writeFile(record, stale);
		const restored = await session();
		expect(removals(restored.frames)).toEqual([
			["typed", NOTICE, { lineage: line, generation: 1 }],
			["string", NOTICE],
		]);
		// Then only issuance 1 is retired in a current tab.
		expect(currentTab(restored.frames, reissued)).toEqual([NOTICE]);
		expect(currentTab(restored.frames, successor)).toEqual([NOTICE]);
		expect(
			currentTab(restored.frames, copy({ lineage: line, generation: 1 })),
		).toEqual([]);
		expect(
			currentTab(restored.frames, copy({ lineage: "other", generation: 1 })),
		).toEqual([NOTICE]);
	},
	budget(5),
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
				entries: [{ key: "update:cerastream=3", dismissedAt: 1 }],
			}),
		);
		// When a fresh process conclusively finds release 3.
		const successor = await session({ check: pending("3") });
		expect(currentTab(successor.frames, open)).toEqual([]);
		// Then the withdrawal also survives into the next process, for either issuance.
		const line = await lineage();
		const next = await session();
		expect(currentTab(next.frames, open)).toEqual([]);
		expect(
			currentTab(next.frames, copy({ lineage: line, generation: 2 })),
		).toEqual([]);
		expect(legacyTab(next.frames, [NOTICE])).toEqual([]);
		// And a release that was never dismissed is offered again.
		expect(currentTab((await session({ check: pending("4") })).frames)).toEqual(
			[NOTICE],
		);
	},
	budget(4),
);

test(
	"a dismissal reaches other tabs after a restart and covers that release only",
	async () => {
		const dismissed = await session({ check: pending("2"), dismiss: true });
		const first = { lineage: await lineage(), generation: 1 };
		expect(currentTab(dismissed.frames, copy(first))).toEqual([]);
		expect(currentTab((await session()).frames, copy(first))).toEqual([]);
		expect(
			currentTab((await session({ check: pending("2") })).frames, copy(first)),
		).toEqual([]);
		expect(currentTab((await session({ check: pending("3") })).frames)).toEqual(
			[NOTICE],
		);
	},
	budget(4),
);

test(
	"a restored withdrawal retires this lineage's issuances up to its generation, however many restarts later",
	async () => {
		await session({ check: pending("2") });
		await session({ check: NOTHING_PENDING });
		const line = await lineage();
		for (let restart = 0; restart < 2; restart++) {
			const replay = (await session()).frames;
			expect(
				currentTab(replay, copy({ lineage: line, generation: 1 })),
			).toEqual([]);
			// A newer issuance, another lineage, or a copy from an older producer is kept.
			expect(
				currentTab(replay, copy({ lineage: line, generation: 2 })),
			).toEqual([NOTICE]);
			expect(
				currentTab(replay, copy({ lineage: "other", generation: 1 })),
			).toEqual([NOTICE]);
			expect(currentTab(replay, copy())).toEqual([NOTICE]);
			// Older bundles hear it on every reconnect.
			expect(legacyTab(replay, [NOTICE])).toEqual([]);
			expect(mainTab(replay, [NOTICE])).toEqual([]);
		}
		// A process's own conclusive check proves nothing is pending at all: every copy goes.
		const proven = await session({ check: NOTHING_PENDING });
		expect(currentTab(proven.frames, copy())).toEqual([]);
		expect(legacyTab(proven.frames, [NOTICE])).toEqual([]);
	},
	budget(5),
);

test(
	"startup derives nothing without a readable, current-schema record and acknowledgement store",
	async () => {
		const L0 = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
		const first = { lineage: L0, generation: 1 };
		// Given no record at all.
		expect(removals((await session()).frames)).toEqual([]);
		// Given an acknowledgement for release 2, so an accepted record would act.
		await writeFile(
			dismissals,
			JSON.stringify({
				version: 1,
				entries: [
					{ key: "update:cerastream=2", dismissedAt: 1 },
					{ key: "update:cerastream=2,srtla=3", dismissedAt: 1 },
				],
			}),
		);
		const row = { name: "cerastream", version: "2" };
		const valid = { version: 3, lineage: L0, generation: 1, offer: [row] };
		const refused: Record<string, string> = {
			corrupt: "{",
			prior: JSON.stringify({ version: 2, offer: [row], withdrawn: [] }),
			future: JSON.stringify({ ...valid, version: 4 }),
			duplicate: `{"version":3,"lineage":"${L0}","generation":1,"offer":null,"offer":[${JSON.stringify(row)}]}`,
			oversized: JSON.stringify(valid).padEnd(5000, " "),
			impossible: JSON.stringify({ ...valid, generation: 0 }),
			lineage: JSON.stringify({ ...valid, lineage: "not-a-uuid" }),
			// A forged multi-package key cannot be smuggled into one row's version.
			forged: JSON.stringify({
				...valid,
				offer: [{ name: "cerastream", version: "2,srtla=3" }],
			}),
		};
		for (const [kind, text] of Object.entries(refused)) {
			await writeFile(record, text);
			expect([kind, removals((await session()).frames)]).toEqual([kind, []]);
		}
		// Control: the same acknowledgement under a valid record does retire issuance 1.
		await writeFile(record, JSON.stringify(valid));
		expect(currentTab((await session()).frames, copy(first))).toEqual([]);
		await rm(record);
		await rm(dismissals);
		// Given a directory where the record should be.
		await mkdir(record);
		expect(removals((await session()).frames)).toEqual([]);
		await rm(record, { recursive: true });
		// Given an offer whose dismissal state cannot be read.
		const shown = await session({ check: pending("2") });
		const open = tabOf(shown.frames);
		await mkdir(dismissals);
		expect(removals((await session()).frames)).toEqual([]);
		// A new release found then is recorded but neither shown nor used to retract.
		const unread = await session({ check: pending("3") });
		expect([shows(unread.frames), removals(unread.frames)]).toEqual([[], []]);
		expect(removals((await session()).frames)).toEqual([]);
		// A proven absence needs no acknowledgement store, live and on later replay.
		const absent = await session({ check: NOTHING_PENDING });
		expect(currentTab(absent.frames, open)).toEqual([]);
		expect(legacyTab(absent.frames, [NOTICE])).toEqual([]);
		const later = await session();
		expect(currentTab(later.frames, open)).toEqual([]);
		expect(legacyTab(later.frames, [NOTICE])).toEqual([]);
	},
	budget(19),
);

test(
	"a record too large for the reader is ignored and the next conclusive check replaces it",
	async () => {
		// Given a round-4-shaped history larger than the reader accepts.
		const rows = ceralivePackageList.map((name) => ({
			name,
			version: "2026.11.9-1~trixie1",
		}));
		const history = JSON.stringify({
			version: 2,
			offer: [],
			withdrawn: Array.from({ length: 8 }, () => rows),
		});
		expect(Buffer.byteLength(history)).toBeGreaterThan(4096);
		await writeFile(record, history);
		expect(removals((await session()).frames)).toEqual([]);
		// When a conclusive check proves none, the record is rewritten and replayed.
		await session({ check: NOTHING_PENDING });
		const replay = (await session({ check: REFRESH_FAILS })).frames;
		expect(legacyTab(replay, [NOTICE])).toEqual([]);
		expect(mainTab(replay, [NOTICE])).toEqual([]);
	},
	budget(3),
);

test(
	"the largest record a check can commit is read back at restart",
	async () => {
		const longest = (extra: number) =>
			`2026.${"1".repeat(OFFER_VERSION_LIMIT - 5 + extra)}`;
		const every = (version: string): AptScript => ({
			upgradable: ceralivePackageList.map((name) => ({
				name,
				installed: "1",
				candidate: version,
			})),
		});
		// Given every roster package offered at the longest admitted version, then dismissed.
		const shown = await session({ check: every(longest(0)), dismiss: true });
		const issued = { lineage: await lineage(), generation: 1 };
		const bytes = (await readFile(record)).byteLength;
		expect(bytes).toBeLessThanOrEqual(4096);
		expect(bytes).toBeGreaterThan(2800);
		expect(currentTab(shown.frames, copy(issued))).toEqual([]);
		// Then a restart reads it back and still retires that issuance.
		expect(removals((await session()).frames)).toEqual([
			["typed", NOTICE, issued],
			["string", NOTICE],
		]);
		// A version past the limit is not committed, so it is neither shown nor recorded.
		await rm(record);
		const refused = await session({ check: every(longest(1)) });
		expect([shows(refused.frames), removals(refused.frames)]).toEqual([[], []]);
		expect(await Bun.file(record).exists()).toBe(false);
	},
	budget(3),
);

test(
	"a verdict that cannot be written changes nothing, in either direction",
	async () => {
		// Given a durable "nothing pending" and no offer anywhere.
		await session({ check: NOTHING_PENDING });
		const none = { lineage: await lineage(), generation: 0 };
		// When a newer offer is found but cannot be persisted.
		const unwritten = await session({ check: pending("2"), failWrites: true });
		// Then it is not shown; the frames carry only the durable none's replay.
		expect(shows(unwritten.frames)).toEqual([]);
		expect(removals(unwritten.frames)).toEqual([
			["typed", NOTICE, none],
			["string", NOTICE],
		]);
		// Given the offer is durable and shown.
		const shown = await session({ check: pending("2") });
		const open = tabOf(shown.frames);
		expect([...open]).toEqual([[NOTICE, { ...none, generation: 1 }]]);
		// When "nothing pending" cannot be persisted, the offer is not withdrawn.
		const kept = await session({ check: NOTHING_PENDING, failWrites: true });
		expect(removals(kept.frames)).toEqual([]);
		expect(currentTab(kept.frames, open)).toEqual([NOTICE]);
		// And the next process still trusts the durable offer, not the lost verdict.
		expect(currentTab((await session()).frames, open)).toEqual([NOTICE]);
	},
	budget(5),
);
