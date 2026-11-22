/*
 * The "A CeraLive update is available" notice (`ceralive_update`) used to be
 * raised by both discovery paths and never withdrawn: after a Rock was updated to
 * the candidate, an already-open tab kept the banner forever. These tests drive
 * the real check entry points (refresh + discovery) and the real install
 * completion over scripted APT and dpkg output, and pin when the notice may
 * change: a conclusive check with every first-party candidate verified (keyed by
 * the exact versions the Install control would take), or dpkg showing every
 * offered instance installed (read in the install's own result step, or at
 * startup for a stored offer). Logins run no command at all.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	jest,
	spyOn,
	test,
} from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notificationsMessageSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import { setup } from "../modules/setup.ts";
import {
	initCeraliveUpdateNotice,
	standingCeraliveOffer,
	withdrawCeraliveOfferIfInstalled,
} from "../modules/system/ceralive-update-notice.ts";
import {
	getUpdateState,
	isUpdating,
	periodicCheckForSoftwareUpdates,
	resetAptReachabilityProbeForTest,
	resetSoftwareUpdateCheckRunner,
	resetSoftwareUpdateState,
	runSoftwareUpdateCheck,
	type SoftwareUpdateError,
	setAptCommandRunnerForTest,
	setAptReachabilityProbeForTest,
	setSoftwareUpdateCheckRunner,
	startSoftwareUpdate,
	triggerManualUpdateCheck,
} from "../modules/system/software-updates.ts";
import { setStreamLivenessSourceForTest } from "../modules/system/stream-liveness-source.ts";
import { setCeraliveSourcesFileForTest } from "../modules/system/update-apt-channel.ts";
import { setUpdateCapabilityPathForTest } from "../modules/system/update-capabilities.ts";
import { setUpdateSettingsFilePathForTest } from "../modules/system/update-settings.ts";
import {
	isNotificationDismissed,
	recordNotificationDismissal,
	resetDismissalStoreForTests,
} from "../modules/ui/notification-dismissals.ts";
import {
	getPersistentNotifications,
	notificationBroadcast,
	notificationDismiss,
	notificationExists,
	notificationRemove,
	notificationSendPersistent,
} from "../modules/ui/notifications.ts";
import * as websocket from "../modules/ui/websocket-server.ts";
import { dismissNotificationProcedure } from "../rpc/procedures/notifications.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import {
	type AptPackage,
	type AptRead,
	type AptScript,
	DEBIAN_ONLY_INVENTORY,
	DEBIAN_ONLY_REFRESH,
	type FailedRead,
	REFRESH,
	scriptedApt,
} from "./helpers/ceralive-update-apt.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

useSessionOwnerForFile();

const NOTICE = "ceralive_update";
const OS_OFFER = "update:updates-available:os:2026.12.0";
const KERNEL = "update:kernel-staged:7.2.1";

const cerastream = (candidate: string, more: Partial<AptPackage> = {}) => ({
	name: "cerastream",
	installed: "1",
	candidate,
	...more,
});
const srtla = (candidate: string, more: Partial<AptPackage> = {}) => ({
	name: "srtla",
	installed: "1.0",
	candidate,
	...more,
});
// A roster package that is not installed; a plan that installs it is part of the offer.
const modemSupport = (candidate: string) => ({
	name: "ceralive-modem-support",
	installed: "(none)",
	candidate,
});
const curl = {
	name: "curl",
	installed: "8.1",
	candidate: "8.2",
	source: "debian",
} as const;

let dir: string;
let script: AptScript;
// Every APT and dpkg argv the code under test ran in this case.
let seen: string[][] = [];
// Awaited before each dpkg-query answer, when a case holds the read.
let dpkgRead: (() => Promise<void>) | undefined;

// The notice's dpkg readback answers from the same scripted device as APT.
function initNotice(
	options: Parameters<typeof initCeraliveUpdateNotice>[0] = {},
) {
	return initCeraliveUpdateNotice({
		path: join(dir, "offer.json"),
		run: async (argv) => {
			seen.push([...argv]);
			if (argv[0] === "dpkg-query") await dpkgRead?.();
			return scriptedApt(script)(argv);
		},
		...options,
	});
}

// dpkg's answer about the standing offer when the device is in `state`.
async function proveInstalled(state: AptScript): Promise<void> {
	script = state;
	await withdrawCeraliveOfferIfInstalled(standingCeraliveOffer());
}
let broadcast: ReturnType<typeof spyOn<typeof websocket, "broadcastMsg">>;
let priorEnabled: boolean | undefined;
let priorDismissals: string | undefined;

async function useCapableImage(): Promise<void> {
	const capability = join(dir, "capabilities.json");
	await writeFile(
		capability,
		JSON.stringify({
			schema: 1,
			features: ["apt-all-packages"],
			apt_uid: 42042,
			ota_uid: 42041,
		}),
	);
	setUpdateCapabilityPathForTest(capability);
}

// What a tab that authenticates now receives, from the login replay's real sender.
function replayFrames(): unknown[] {
	const sent: string[] = [];
	notificationSendPersistent(
		{ send: (frame: string) => sent.push(frame) },
		true,
	);
	return sent.map((frame) => JSON.parse(frame).notification);
}

// The removals in it.
function replayedRemovals(): unknown[] {
	return replayFrames().flatMap(
		(frame) => (frame as { remove?: unknown[] }).remove ?? [],
	);
}

function liveFrames(): unknown[] {
	return broadcast.mock.calls.flatMap(([type, frame]) =>
		type === "notification" ? [frame] : [],
	);
}

// What the current frontend applies: frames that fail the schema are skipped.
function currentTab(frames: readonly unknown[], start: string[] = []) {
	const shown = new Set(start);
	for (const frame of frames) {
		const parsed = notificationsMessageSchema.safeParse(frame);
		if (!parsed.success) continue;
		for (const { name } of parsed.data.show ?? []) shown.add(name);
		for (const { id } of parsed.data.remove ?? []) shown.delete(id);
	}
	return [...shown].sort();
}

// The v2026.7.2 frontend (subscriptions.svelte.ts:583-596): no validation, and
// each `remove` entry goes straight to a store keyed by notification name.
function legacyTab(frames: readonly unknown[], start: string[] = []) {
	const shown = new Set<unknown>(start);
	for (const frame of frames) {
		const message = frame as { show?: { name: string }[]; remove?: unknown[] };
		for (const { name } of message.show ?? []) shown.add(name);
		for (const entry of message.remove ?? []) shown.delete(entry);
	}
	return [...shown].map(String).sort();
}

function liveRemovals(): string[] {
	const open = [NOTICE, OS_OFFER, KERNEL];
	const after = currentTab(liveFrames(), open);
	return open.filter((name) => !after.includes(name));
}

function standing(name: string): void {
	notificationBroadcast(name, "info", name, 0, true, true, true, name);
}

function shown() {
	return getPersistentNotifications(true).show.find(
		({ name }) => name === NOTICE,
	);
}

function context(sent: string[]): RPCContext {
	const ws = {
		send: (frame: string) => sent.push(frame),
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

async function check(next: AptScript): Promise<SoftwareUpdateError> {
	script = next;
	broadcast.mockClear();
	return runSoftwareUpdateCheck();
}

// Other files in the same process can leave persistent notices; every case starts and ends with none.
function clearPersistentNotices(): void {
	for (const { name } of getPersistentNotifications(true).show ?? [])
		notificationRemove(name);
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ceralive-update-notice-"));
	clearPersistentNotices();
	priorDismissals = process.env.CERALIVE_DISMISSALS_FILE;
	process.env.CERALIVE_DISMISSALS_FILE = join(dir, "dismissals.json");
	resetDismissalStoreForTests();
	priorEnabled = setup.apt_update_enabled;
	setup.apt_update_enabled = true;
	resetSoftwareUpdateState();
	script = {};
	setUpdateCapabilityPathForTest(join(dir, "absent-capabilities.json"));
	setCeraliveSourcesFileForTest(join(dir, "sources"));
	setUpdateSettingsFilePathForTest(join(dir, "settings.json"));
	setAptReachabilityProbeForTest(async () => ({
		ipv4: "ok",
		ipv6: "ok",
		used: "any",
		verdict: "any",
		detail: [],
	}));
	seen = [];
	dpkgRead = undefined;
	setAptCommandRunnerForTest((argv) => {
		seen.push([...argv]);
		return scriptedApt(script)(argv);
	});
	initNotice();
	broadcast = spyOn(websocket, "broadcastMsg");
});

afterEach(async () => {
	broadcast.mockRestore();
	clearPersistentNotices();
	setAptCommandRunnerForTest(null);
	resetSoftwareUpdateCheckRunner();
	setUpdateCapabilityPathForTest(null);
	setCeraliveSourcesFileForTest(null);
	setUpdateSettingsFilePathForTest(null);
	resetAptReachabilityProbeForTest();
	resetSoftwareUpdateState();
	setup.apt_update_enabled = priorEnabled;
	if (priorDismissals === undefined)
		delete process.env.CERALIVE_DISMISSALS_FILE;
	else process.env.CERALIVE_DISMISSALS_FILE = priorDismissals;
	resetDismissalStoreForTests();
	await rm(dir, { recursive: true, force: true });
});

// The device after the install of cerastream 2 (and of srtla 1.1, for two-package offers).
const installedRelease: AptScript = {
	installed: [cerastream("2", { installed: "2" })],
};
const bothPending: AptScript = {
	upgradable: [cerastream("2"), srtla("1.1")],
};
const bothInstalled: AptScript = {
	installed: [
		cerastream("2", { installed: "2" }),
		srtla("1.1", { installed: "1.1" }),
	],
};

async function recorded(): Promise<unknown> {
	return JSON.parse(await readFile(join(dir, "offer.json"), "utf8"));
}

describe("legacy image", () => {
	test("a conclusive check keys the notice by the exact verified versions", async () => {
		// When a fresh refresh and discovery find two first-party upgrades.
		expect(
			await check({
				upgradable: [srtla("1.1"), cerastream("2026.11.3")],
			}),
		).toBeNull();
		// Then the localized, actionable notice carries a version-bearing key.
		expect(notificationExists(NOTICE)).toMatchObject({
			key: "notifications.ceraliveUpdateAvailable",
			action: { kind: "navigate", target: "updates-dialog" },
			dismissalKey: "update:cerastream:arm64=2026.11.3,srtla:arm64=1.1",
		});
	});

	test("nothing pending after the update withdraws it live in current and pre-#183 tabs; a later login is not told", async () => {
		// Given the offer that was installed, plus OS and kernel notices on the same surface.
		standing(OS_OFFER);
		standing(KERNEL);
		await check({ upgradable: [cerastream("2")] });
		expect(notificationExists(NOTICE)).toBeDefined();
		// When the conclusive check after the update finds nothing pending, cerastream 2 installed.
		await check(installedRelease);
		// Then connected tabs of both frontend generations drop only the offer.
		const open = [NOTICE, OS_OFFER, KERNEL];
		expect(currentTab(liveFrames(), open)).toEqual([KERNEL, OS_OFFER].sort());
		expect(legacyTab(liveFrames(), open)).toEqual([KERNEL, OS_OFFER].sort());
		// And a tab of either generation that logs in later is not told: its copy may be
		// another release's. The next complete check while it is connected tells it.
		expect(replayedRemovals()).toEqual([]);
		expect(currentTab(replayFrames(), open)).toEqual([...open].sort());
		expect(legacyTab(replayFrames(), open)).toEqual([...open].sort());
		await check(installedRelease);
		expect(liveRemovals()).toEqual([NOTICE]);
		// And a fresh tab never sees it.
		expect(currentTab(replayFrames())).toEqual([KERNEL, OS_OFFER].sort());
	});

	test("the typed removal withdraws a current tab but does not reach a pre-#183 tab", async () => {
		await check({ upgradable: [cerastream("2")] });
		await check(installedRelease);
		const typedOnly = liveFrames().filter(
			(frame) => notificationsMessageSchema.safeParse(frame).success,
		);
		expect(currentTab(typedOnly, [NOTICE])).toEqual([]);
		expect(legacyTab(typedOnly, [NOTICE])).toEqual([NOTICE]);
	});

	test("a refresh that never saw CeraLive's source keeps the offer", async () => {
		await check({ upgradable: [cerastream("2")] });
		// When CeraLive's source is disabled and only Debian answered the refresh.
		await check({ inventory: DEBIAN_ONLY_INVENTORY });
		expect(liveRemovals()).toEqual([]);
		expect(notificationExists(NOTICE)?.dismissalKey).toBe(
			"update:cerastream:arm64=2",
		);
		expect(currentTab(replayFrames(), [NOTICE])).toEqual([NOTICE]);
	});

	test("a dismissal that cannot be written is refused and cannot withdraw the offer later", async () => {
		await check({ upgradable: [cerastream("2")] });
		const seen = shown();
		// When the dismissal store's directory is gone, so the write fails.
		process.env.CERALIVE_DISMISSALS_FILE = join(
			dir,
			"missing",
			"dismissals.json",
		);
		resetDismissalStoreForTests();
		const sent: string[] = [];
		await expect(
			call(
				dismissNotificationProcedure,
				{ name: NOTICE, revision: seen?.revision, publisher: seen?.publisher },
				{ context: context(sent) },
			),
		).rejects.toThrow();
		// Then nothing is remembered and the next conclusive check keeps the offer for every tab.
		expect(isNotificationDismissed("update:cerastream:arm64=2")).toBe(false);
		expect(notificationExists(NOTICE)).toBeDefined();
		await check({ upgradable: [cerastream("2")] });
		expect(liveRemovals()).toEqual([]);
		expect(currentTab(replayFrames(), [NOTICE])).toEqual([NOTICE]);
	});

	test("an independent update left after the install replaces the offer without a withdrawal", async () => {
		await check({ upgradable: [cerastream("2")] });
		// When the post-restart check finds srtla still pending (cerastream installed).
		await check({ upgradable: [srtla("1.1")] });
		// Then the notice stays up for the remaining release.
		expect(liveRemovals()).toEqual([]);
		expect(notificationExists(NOTICE)?.dismissalKey).toBe(
			"update:srtla:arm64=1.1",
		);
		expect(replayedRemovals()).toEqual([]);
	});

	test.each([
		[
			"an Err: line on stdout",
			{ stdout: "Err:1 https://apt.ceralive.tv stable InRelease\n" },
		],
		[
			"a failed-fetch warning",
			{
				stderr:
					"W: Failed to fetch https://apt.ceralive.tv/dists/stable/InRelease  Temporary failure resolving 'apt.ceralive.tv'\n",
			},
		],
		[
			"a stale-index warning",
			{
				stderr:
					"W: Some index files failed to download. They have been ignored, or old ones used instead.\n",
			},
		],
		[
			"an error line at exit zero",
			{ stderr: "E: The repository is not signed.\n" },
		],
		[
			"a captive portal",
			{
				stderr:
					"E: Failed to fetch x  Clearsigned file isn't valid, got 'NOSPLIT' (does the network require authentication?)\n",
			},
		],
		["a failed refresh", { exitCode: 100, stderr: "E: Could not get lock\n" }],
	])(
		"a refresh with %s leaves the standing offer untouched",
		async (_label, refresh) => {
			await check({ upgradable: [cerastream("2")] });
			// When the next refresh is not conclusive and the lists say nothing is pending.
			await check({ refresh });
			// Then the offer is neither withdrawn nor rekeyed.
			expect(liveRemovals()).toEqual([]);
			expect(notificationExists(NOTICE)?.dismissalKey).toBe(
				"update:cerastream:arm64=2",
			);
		},
	);

	test.each([
		["an error exit", { exitCode: 100, stderr: "E: dpkg was interrupted\n" }],
		["exit 1 without its own Abort.", { exitCode: 1 }],
		[
			"an error line at exit zero",
			{ exitCode: 0, stderr: "E: Sub-process returned an error code\n" },
		],
	])(
		"a discovery with %s after a good refresh is not proof either way",
		async (_label, discovery) => {
			await check({ upgradable: [cerastream("2")] });
			// When dist-upgrade fails but its stdout still parses as "nothing to do".
			await check({ discovery });
			expect(liveRemovals()).toEqual([]);
			expect(notificationExists(NOTICE)?.dismissalKey).toBe(
				"update:cerastream:arm64=2",
			);
		},
	);

	test.each([
		[
			"a candidate from another origin",
			{ upgradable: [cerastream("2", { source: "debian" })] },
		],
		[
			"a policy that cannot be read",
			{ upgradable: [cerastream("2")], policyFails: ["cerastream"] },
		],
		...(["launch", "timeout", "silent-exit-1"] as const).map(
			(how): [string, AptScript] => [
				`a candidate record (its architecture) that fails by ${how}`,
				{ upgradable: [cerastream("2")], fail: { "package-record": how } },
			],
		),
		[
			"a candidate record of another version",
			{
				upgradable: [cerastream("2")],
				records: {
					cerastream:
						"Package: cerastream\nArchitecture: arm64\nVersion: 1\n\n",
				},
			},
		],
		[
			"two candidate records",
			{
				upgradable: [cerastream("2")],
				records: {
					cerastream:
						"Package: cerastream\nArchitecture: arm64\nVersion: 2\n\nPackage: cerastream\nArchitecture: armhf\nVersion: 2\n\n",
				},
			},
		],
	] satisfies [string, AptScript][])(
		"%s is not proof either way",
		async (_label, contradiction) => {
			// Given no standing offer; then nothing is raised on unverified evidence.
			await check(contradiction);
			expect(notificationExists(NOTICE)).toBeUndefined();
			// And a standing offer survives the same evidence.
			await check({ upgradable: [cerastream("2")] });
			await check(contradiction);
			expect(liveRemovals()).toEqual([]);
			expect(notificationExists(NOTICE)?.dismissalKey).toBe(
				"update:cerastream:arm64=2",
			);
		},
	);

	test("a kept-back CeraLive package the Install control refuses raises nothing", async () => {
		// When dist-upgrade keeps cerastream back and only its explicit plan upgrades it.
		await check({ keptBack: [cerastream("2")] });
		// Then the dialog is not actionable, and the notice does not claim it is.
		expect(getUpdateState()).toMatchObject({ actionable_count: 0 });
		expect(notificationExists(NOTICE)).toBeUndefined();
	});

	test("a dismissal hides that exact release only, even at the same download size", async () => {
		await check({ upgradable: [cerastream("2")] });
		const seen = shown();
		await call(
			dismissNotificationProcedure,
			{ name: NOTICE, revision: seen?.revision, publisher: seen?.publisher },
			{ context: context([]) },
		);
		// When the same release is discovered again, it stays hidden and is withdrawn live; a
		// reconnecting tab is not told.
		await check({ upgradable: [cerastream("2")] });
		expect(notificationExists(NOTICE)).toBeUndefined();
		expect(liveRemovals()).toEqual([NOTICE]);
		expect(currentTab(replayFrames(), [NOTICE])).toEqual([NOTICE]);
		// When a new release of the same package with the same size appears.
		await check({ upgradable: [cerastream("3")] });
		// Then it is offered again.
		expect(notificationExists(NOTICE)?.dismissalKey).toBe(
			"update:cerastream:arm64=3",
		);
		expect(replayedRemovals()).toEqual([]);
	});

	test("a dismissal removes the notice from connected tabs; a tab that missed it keeps its copy on reconnect", async () => {
		await check({ upgradable: [cerastream("2")] });
		const seen = shown();
		// When one tab dismisses the release it shows.
		notificationDismiss(NOTICE, seen);
		// Then connected tabs of either generation drop it, and a reconnecting one is not told.
		expect(liveRemovals()).toEqual([NOTICE]);
		expect(legacyTab(liveFrames(), [NOTICE])).toEqual([]);
		expect(currentTab(replayFrames(), [NOTICE])).toEqual([NOTICE]);
		expect(legacyTab(replayFrames(), [NOTICE])).toEqual([NOTICE]);
	});

	test("a dismissal from a tab still showing an older release changes nothing and shows it the current one", async () => {
		await check({ upgradable: [cerastream("2")] });
		const old = shown();
		await check({ upgradable: [cerastream("3")] });
		const sent: string[] = [];
		// When the stale tab's dismissal of release 2 arrives after release 3 replaced it.
		await call(
			dismissNotificationProcedure,
			{ name: NOTICE, revision: old?.revision, publisher: old?.publisher },
			{ context: context(sent) },
		);
		// Then release 3 is neither dismissed nor hidden, and that tab gets it back.
		expect(isNotificationDismissed("update:cerastream:arm64=3")).toBe(false);
		expect(isNotificationDismissed("update:cerastream:arm64=2")).toBe(false);
		expect(notificationExists(NOTICE)?.dismissalKey).toBe(
			"update:cerastream:arm64=3",
		);
		expect(sent.map((frame) => JSON.parse(frame).notification)).toEqual([
			{ show: [shown()] },
		]);
		// Checked independently of the producer: the resent copy is the newer release.
		const resent = JSON.parse(sent[0] ?? "{}").notification.show[0];
		expect(resent).toMatchObject({
			name: NOTICE,
			key: "notifications.ceraliveUpdateAvailable",
			publisher: old?.publisher,
		});
		expect(resent.revision).toBeGreaterThan(old?.revision ?? Infinity);
	});

	test("a dismissal that cannot name the release it saw changes nothing", async () => {
		await check({ upgradable: [cerastream("2")] });
		const sent: string[] = [];
		broadcast.mockClear();
		// When an older frontend sends the name only.
		await call(
			dismissNotificationProcedure,
			{ name: NOTICE },
			{ context: context(sent) },
		);
		// Then nothing is recorded, removed or resent.
		expect(isNotificationDismissed("update:cerastream:arm64=2")).toBe(false);
		expect(notificationExists(NOTICE)).toBeDefined();
		expect(liveFrames()).toEqual([]);
		expect(sent).toEqual([]);
	});

	test("a dismissed successor withdraws the predecessor instead of keeping it alive", async () => {
		await check({ upgradable: [cerastream("2")] });
		// Given the operator already dismissed the next release.
		recordNotificationDismissal("update:cerastream:arm64=3");
		// When a conclusive check finds that dismissed release.
		await check({ upgradable: [cerastream("3")] });
		// Then the older offer leaves every connected tab; a reconnecting one is not told.
		expect(liveRemovals()).toEqual([NOTICE]);
		expect(notificationExists(NOTICE)).toBeUndefined();
		expect(currentTab(replayFrames(), [NOTICE])).toEqual([NOTICE]);
	});

	test("the legacy relay replay sends the show frame only, never a removal", async () => {
		standing(OS_OFFER);
		await check({ upgradable: [cerastream("2")] });
		// Given this process's conclusive check found nothing pending, the offer installed.
		await check(installedRelease);
		const sent: string[] = [];
		await notificationSendPersistent(
			{ send: (frame: string) => sent.push(frame) },
			true,
		);
		const frames = sent.map((frame) => JSON.parse(frame).notification);
		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({ replay: true });
		expect(currentTab(frames, [NOTICE])).toEqual([NOTICE, OS_OFFER]);
		expect(legacyTab(frames, [NOTICE])).toEqual([NOTICE, OS_OFFER]);
	});
});

describe("capable image", () => {
	beforeEach(useCapableImage);

	test("srtla from the CeraLive origin raises the localized notice keyed by version", async () => {
		expect(await check({ upgradable: [srtla("2.0")] })).toBeNull();
		expect(notificationExists(NOTICE)).toMatchObject({
			key: "notifications.ceraliveUpdateAvailable",
			action: { kind: "navigate", target: "updates-dialog" },
			dismissalKey: "update:srtla:arm64=2.0",
		});
	});

	test("verified Debian-only upgrades withdraw the CeraLive offer", async () => {
		await check({ upgradable: [srtla("2.0")] });
		// When srtla is installed and only a Debian security update remains.
		await check({
			upgradable: [curl],
			installed: [srtla("2.0", { installed: "2.0" })],
		});
		expect(getUpdateState()).toMatchObject({ actionable_count: 1 });
		expect(liveRemovals()).toEqual([NOTICE]);
		// And a tab that logs in to this process later is not told.
		expect(replayedRemovals()).toEqual([]);
	});

	test("a Debian-only refresh without CeraLive's source keeps the offer", async () => {
		await check({ upgradable: [srtla("2.0")] });
		await check({ upgradable: [curl], inventory: DEBIAN_ONLY_INVENTORY });
		expect(liveRemovals()).toEqual([]);
		expect(currentTab(replayFrames(), [NOTICE])).toEqual([NOTICE]);
	});

	test("a first-party candidate whose policy disagrees with the simulation leaves the offer untouched", async () => {
		await check({ upgradable: [srtla("2.0")] });
		// When the simulation says 2.1 but the policy candidate is still 2.0.
		await check({ upgradable: [srtla("2.0", { planned: "2.1" })] });
		// Then the unverified row is not read as "no offer remains".
		expect(liveRemovals()).toEqual([]);
		expect(notificationExists(NOTICE)?.dismissalKey).toBe(
			"update:srtla:arm64=2.0",
		);
	});

	test("a dismissed verified subset never withdraws while another first-party candidate is unverified", async () => {
		await check({ upgradable: [cerastream("2"), srtla("3")] });
		expect(notificationExists(NOTICE)?.dismissalKey).toBe(
			"update:cerastream:arm64=2,srtla:arm64=3",
		);
		// Given the operator dismissed cerastream=2 alone in an earlier release.
		recordNotificationDismissal("update:cerastream:arm64=2");
		// When cerastream=2 verifies but srtla's policy disagrees with its simulation.
		await check({
			upgradable: [cerastream("2"), srtla("3.1", { planned: "3" })],
		});
		// Then srtla's pending offer stays on screen.
		expect(liveRemovals()).toEqual([]);
		expect(notificationExists(NOTICE)?.dismissalKey).toBe(
			"update:cerastream:arm64=2,srtla:arm64=3",
		);
	});
});

describe("manual and periodic checks", () => {
	afterEach(() => {
		jest.useRealTimers();
	});

	test.each([
		["manual", () => expect(triggerManualUpdateCheck()).toBe(true)],
		["periodic", () => periodicCheckForSoftwareUpdates()],
	])(
		"a %s check withdraws only after a conclusive refresh",
		async (_label, start) => {
			await check({ upgradable: [cerastream("2")] });
			const refreshed =
				Promise.withResolvers<
					(
						err: SoftwareUpdateError,
						failures: number,
						refresh?: string,
					) => unknown
				>();
			setSoftwareUpdateCheckRunner((callback) => {
				refreshed.resolve(callback);
				return true;
			});
			script = installedRelease;
			broadcast.mockClear();
			start();
			const settle = await refreshed.promise;
			// The periodic loop reschedules itself; keep that timer out of the test.
			jest.useFakeTimers();
			// When the refresh was not conclusive, the same "nothing pending" lists change nothing.
			await settle(true, 1, undefined);
			expect(liveRemovals()).toEqual([]);
			// When a conclusive refresh precedes the same discovery, the offer is withdrawn.
			await settle(null, 0, REFRESH);
			expect(liveRemovals()).toEqual([NOTICE]);
		},
	);
});

// What #664's readback asks dpkg-query for (dpkg expands the escapes itself).
const DPKG_FORMAT =
	"-f=$" +
	"{Package}\\t$" +
	"{Architecture}\\t$" +
	"{db:Status-Abbrev}\\t$" +
	"{Version}\\n";

describe("a finished install", () => {
	// Runs a legacy install of the standing offer through the real start and completion path.
	async function install(state: AptScript, exit: number) {
		setAptCommandRunnerForTest(null);
		// The harness observes the same broadcast seam; two wrappers would call each other.
		broadcast.mockRestore();
		const h = await updateHarness();
		seen = [];
		script = state;
		h.completion = Promise.resolve(exit);
		startSoftwareUpdate();
		await h.check();
		return h;
	}

	test("withdraws the offer in its own result step, while it still holds the updater, when dpkg shows it installed", async () => {
		await check({ upgradable: [cerastream("2")] });
		const before = await readFile(join(dir, "offer.json"), "utf8");
		// What the updater answers while dpkg is read.
		const during: unknown[] = [];
		dpkgRead = async () => {
			during.push(isUpdating(), startSoftwareUpdate().started);
		};
		// When the legacy transaction for the offer succeeds and the backend restarts itself.
		await using h = await install(installedRelease, 0);
		await h.restarted();
		// Then dpkg was read while the update still held the updater: nothing else could start.
		expect(during).toEqual([true, false]);
		// And connected tabs drop it before the restart; a fresh tab is shown nothing.
		expect(getUpdateState()).toEqual({ kind: "success" });
		expect(notificationExists(NOTICE)).toBeUndefined();
		expect(currentTab(replayFrames())).toEqual([]);
		// But a tab that logs in later is not told: its copy may be another release's.
		expect(replayedRemovals()).toEqual([]);
		expect(currentTab(replayFrames(), [NOTICE])).toEqual([NOTICE]);
		expect(legacyTab(replayFrames(), [NOTICE])).toEqual([NOTICE]);
		// And the record still names the offer, so the update's own restart reads dpkg again.
		expect(await readFile(join(dir, "offer.json"), "utf8")).toBe(before);
		// And only dpkg was asked: one query of the offered instance, then its own comparison.
		expect(seen).toEqual([
			["dpkg-query", "-W", DPKG_FORMAT, "--", "cerastream"],
			["dpkg", "--compare-versions", "2", "ge", "2"],
		]);
	});

	test("a successful install is not evidence when dpkg does not show the offer installed", async () => {
		await check({ upgradable: [cerastream("2")] });
		// When the transaction succeeds but cerastream is still at 1.
		await using h = await install(
			{ installed: [cerastream("2", { installed: "1" })] },
			0,
		);
		await h.restarted();
		// Then the update still restarts, and only the next proof or conclusive check may withdraw the notice.
		expect(getUpdateState()).toEqual({ kind: "success" });
		expect(replayedRemovals()).toEqual([]);
		expect(
			getPersistentNotifications(true).show.map(({ name }) => name),
		).toContain(NOTICE);
	});

	test("a failed install reads nothing and keeps the offer", async () => {
		await check({ upgradable: [cerastream("2")] });
		// When the transaction fails, though dpkg would show the offer installed.
		await using _h = await install(installedRelease, 100);
		expect(getUpdateState()).toMatchObject({ kind: "failed" });
		expect(seen).toEqual([]);
		expect(notificationExists(NOTICE)?.dismissalKey).toBe(
			"update:cerastream:arm64=2",
		);
		expect(replayedRemovals()).toEqual([]);
	});

	test("dpkg, not a string comparison, decides the installed version reaches the offer", async () => {
		await check({
			upgradable: [cerastream("2026.9.1", { installed: "2026.8.0" })],
		});
		// When 2026.10.0 is installed: lower than 2026.9.1 as text, higher to dpkg.
		await proveInstalled({
			installed: [cerastream("2026.10.0", { installed: "2026.10.0" })],
		});
		expect(liveRemovals()).toEqual([NOTICE]);
		expect(await recorded()).toEqual({
			version: 8,
			offer: [{ name: "cerastream", arch: "arm64", version: "2026.9.1" }],
		});
	});

	test.each([
		["1:1.0~rc1+build1", "1:1.0", false],
		["1:1.0+git1", "1:1.0", true],
		["1:1.0", "0:999", true],
		["2026.11.3", "2026.11.3", true],
	])(
		"dpkg's order decides installed %s against offered %s",
		async (installed, offered, proven) => {
			await check({ upgradable: [cerastream(offered, { installed: "0.1" })] });
			broadcast.mockClear();
			await proveInstalled({
				installed: [cerastream(installed, { installed })],
			});
			expect(liveRemovals()).toEqual(proven ? [NOTICE] : []);
		},
	);

	const unproven: readonly [string, AptScript][] = [
		[
			"an offered package still below the offered version",
			{
				installed: [
					cerastream("2", { installed: "1" }),
					srtla("1.1", { installed: "1.1" }),
				],
			},
		],
		[
			"an offered package below the offered version only in dpkg's order",
			{
				installed: [
					cerastream("2", { installed: "2" }),
					srtla("1.1", { installed: "1.1~rc1" }),
				],
			},
		],
		[
			"an offered package dpkg does not know",
			{ installed: [srtla("1.1", { installed: "1.1" })] },
		],
		[
			"an offered package dpkg lists only under another architecture",
			{
				installed: [
					cerastream("2", { installed: "2", installedArch: "armhf" }),
					srtla("1.1", { installed: "1.1" }),
				],
			},
		],
		...(
			[
				["config-files", "rc "],
				["half-configured", "iF "],
				["unpacked", "iU "],
				["triggers-pending", "it "],
				["reinstall-required", "iiR"],
			] as const
		).map(([state, abbrev]): [string, AptScript] => [
			`dpkg reporting an offered package ${state}`,
			{ ...bothInstalled, dpkgStatus: { cerastream: abbrev } },
		]),
		...(
			["launch", "timeout", "signal", "silent-exit-1", "truncated"] as const
		).map((how): [string, AptScript] => [
			`dpkg-query ${how}`,
			{ ...bothInstalled, fail: { "dpkg-query": how } },
		]),
		...(["launch", "timeout", "signal", "silent-exit-1"] as const).map(
			(how): [string, AptScript] => [
				`dpkg --compare-versions ${how}`,
				{ ...bothInstalled, fail: { "dpkg-compare": how } },
			],
		),
	];

	for (const [label, state] of unproven)
		test(`${label} keeps the offer and records nothing`, async () => {
			// Given a two-package offer shown and recorded.
			await check(bothPending);
			const before = await readFile(join(dir, "offer.json"), "utf8");
			broadcast.mockClear();
			// When the install finished and dpkg's answer does not prove it took the offer.
			await proveInstalled(state);
			// Then nothing is removed, delivered or written.
			expect(liveRemovals()).toEqual([]);
			expect(notificationExists(NOTICE)?.dismissalKey).toBe(
				"update:cerastream:arm64=2,srtla:arm64=1.1",
			);
			expect(replayedRemovals()).toEqual([]);
			expect(await readFile(join(dir, "offer.json"), "utf8")).toBe(before);
		});

	test("a held package installed at the offered version is installed", async () => {
		await check(bothPending);
		await proveInstalled({ ...bothInstalled, holds: ["cerastream"] });
		expect(liveRemovals()).toEqual([NOTICE]);
	});

	// A read held open while a check finds release 3 instead.
	async function newerOfferDuring(read: () => Promise<void>): Promise<void> {
		await check({ upgradable: [cerastream("2")] });
		const reading = Promise.withResolvers<void>();
		const held = Promise.withResolvers<void>();
		dpkgRead = async () => {
			reading.resolve();
			await held.promise;
		};
		script = installedRelease;
		const proving = read();
		await reading.promise;
		dpkgRead = undefined;
		await check({ upgradable: [cerastream("3", { installed: "2" })] });
		held.resolve();
		await proving;
		// Then the newer offer stays shown and recorded.
		expect(liveRemovals()).toEqual([]);
		expect(notificationExists(NOTICE)?.dismissalKey).toBe(
			"update:cerastream:arm64=3",
		);
		expect(replayedRemovals()).toEqual([]);
		expect(await recorded()).toEqual({
			version: 8,
			offer: [{ name: "cerastream", arch: "arm64", version: "3" }],
		});
	}

	test("a check that records a newer offer while the install's dpkg read runs wins", async () => {
		await newerOfferDuring(() =>
			withdrawCeraliveOfferIfInstalled(standingCeraliveOffer()),
		);
	});

	test("a startup with a stored offer reads nothing, so no read of it can outlive a newer verdict", async () => {
		await check({ upgradable: [cerastream("2")] });
		// A dpkg read that would never answer.
		dpkgRead = () => new Promise<void>(() => undefined);
		seen = [];
		clearPersistentNotices();
		initNotice();
		expect(seen).toEqual([]);
		expect(notificationExists(NOTICE)).toBeUndefined();
		// And the newer verdict a check records next is the one on screen.
		dpkgRead = undefined;
		await check({ upgradable: [cerastream("3", { installed: "2" })] });
		expect(notificationExists(NOTICE)?.dismissalKey).toBe(
			"update:cerastream:arm64=3",
		);
	});

	test("an install with no recorded offer proves nothing and runs nothing", async () => {
		seen = [];
		await proveInstalled(installedRelease);
		expect(seen).toEqual([]);
		expect(await Bun.file(join(dir, "offer.json")).exists()).toBe(false);
	});
});

for (const capable of [false, true])
	describe(`${capable ? "capable" : "legacy"} image: logins and restarts`, () => {
		beforeEach(async () => {
			if (capable) await useCapableImage();
		});

		test("logins run no command and are told no removal; a restart reads nothing", async () => {
			await check({ upgradable: [cerastream("2")] });
			await proveInstalled(installedRelease);
			seen = [];
			// The update's own proof is no authority over a copy a tab brings to a later login.
			expect(replayedRemovals()).toEqual([]);
			expect(seen).toEqual([]);
			// The next process reads nothing, announces nothing and writes nothing.
			clearPersistentNotices();
			initNotice();
			expect(seen).toEqual([]);
			expect(notificationExists(NOTICE)).toBeUndefined();
			expect(replayedRemovals()).toEqual([]);
			expect(await recorded()).toEqual({
				version: 8,
				offer: [{ name: "cerastream", arch: "arm64", version: "2" }],
			});
			// Its complete check finds nothing pending, dpkg showing the stored offer: connected
			// tabs are told live, logins are not.
			await check(installedRelease);
			expect(seen.filter(([bin]) => bin?.startsWith("dpkg"))).toEqual([
				["dpkg-query", "-W", DPKG_FORMAT, "--", "cerastream"],
				["dpkg", "--compare-versions", "2", "ge", "2"],
			]);
			expect(liveRemovals()).toEqual([NOTICE]);
			expect(replayedRemovals()).toEqual([]);
			expect(await recorded()).toEqual({ version: 8, offer: null });
			// A later restart has nothing to read or deliver.
			seen = [];
			initNotice();
			expect(replayedRemovals()).toEqual([]);
			expect(seen).toEqual([]);
		});

		test("a complete check's none is told live to connected tabs only, never at login", async () => {
			await check({ upgradable: [cerastream("2")] });
			await check(installedRelease);
			expect(liveRemovals()).toEqual([NOTICE]);
			expect(replayedRemovals()).toEqual([]);
			seen = [];
			initNotice();
			expect(replayedRemovals()).toEqual([]);
			expect(seen).toEqual([]);
		});

		test("a startup that dpkg shows the stored offer installed neither announces nor removes it and writes nothing, even read-only", async () => {
			await check({ upgradable: [cerastream("2")] });
			const before = await readFile(join(dir, "offer.json"), "utf8");
			script = installedRelease;
			for (const write of [
				undefined,
				() => {
					throw new Error("state directory is read-only");
				},
			]) {
				clearPersistentNotices();
				broadcast.mockClear();
				initNotice(write ? { write } : {});
				expect(liveRemovals()).toEqual([]);
				expect(notificationExists(NOTICE)).toBeUndefined();
				expect(replayedRemovals()).toEqual([]);
				expect(await readFile(join(dir, "offer.json"), "utf8")).toBe(before);
			}
		});

		test("a login during a live stream or with updates disabled runs nothing and is told no removal", async () => {
			await check({ upgradable: [cerastream("2")] });
			await check(installedRelease);
			for (const [label, refuse, restore] of [
				[
					"updates disabled",
					() => {
						setup.apt_update_enabled = false;
					},
					() => {
						setup.apt_update_enabled = true;
					},
				],
				[
					"a live stream",
					() => setStreamLivenessSourceForTest(() => "streaming"),
					() => setStreamLivenessSourceForTest(null),
				],
			] as const) {
				refuse();
				seen = [];
				const frames = replayedRemovals();
				restore();
				expect([label, frames.length, seen]).toEqual([label, 0, []]);
			}
		});

		test("startup announces no stored offer, dismissed or not; this process's own check does", async () => {
			await check({ upgradable: [cerastream("2")] });
			// When a fresh process loads the record (it starts with no notices).
			clearPersistentNotices();
			broadcast.mockClear();
			initNotice();
			// Then the stored offer, which a tab may already have seen superseded, is not shown again.
			expect(notificationExists(NOTICE)).toBeUndefined();
			expect(liveFrames()).toEqual([]);
			expect(replayedRemovals()).toEqual([]);
			// Its own conclusive check shows it.
			await check({ upgradable: [cerastream("2")] });
			expect(notificationExists(NOTICE)?.dismissalKey).toBe(
				"update:cerastream:arm64=2",
			);
			// When that release was dismissed, a fresh process neither shows it nor removes
			// anything: a tab may show another release a predecessor raised.
			recordNotificationDismissal("update:cerastream:arm64=2");
			clearPersistentNotices();
			broadcast.mockClear();
			initNotice();
			expect(notificationExists(NOTICE)).toBeUndefined();
			expect(liveRemovals()).toEqual([]);
			expect(replayedRemovals()).toEqual([]);
			// Its complete check finds that dismissed release: then connected tabs are told live.
			await check({ upgradable: [cerastream("2")] });
			expect(liveRemovals()).toEqual([NOTICE]);
			expect(replayedRemovals()).toEqual([]);
		});
	});

// A command of the check itself that did not answer is never "nothing pending".
const unanswered: readonly [AptRead, FailedRead, "both" | "capable"][] = [
	["inventory", "launch", "both"],
	["inventory", "timeout", "both"],
	["inventory", "signal", "both"],
	["inventory", "silent-exit-1", "both"],
	["apt-mark", "launch", "capable"],
	["apt-mark", "timeout", "capable"],
];

// An answer that is only partly there is never "nothing pending" either.
const incomplete: readonly [
	string,
	AptScript,
	"both" | "capable" | "legacy",
][] = [
	[
		"a plan without its summary line",
		{ fail: { simulation: "no-summary" } },
		"capable",
	],
	[
		"a plan cut to its first line",
		{ fail: { simulation: "truncated" } },
		"capable",
	],
	[
		"a discovery without its summary line",
		{ fail: { discovery: "no-summary" } },
		"legacy",
	],
	[
		"a discovery cut to its first line",
		{ fail: { discovery: "truncated" } },
		"legacy",
	],
	[
		"an inventory cut before CeraLive's source",
		{ fail: { inventory: "truncated" } },
		"both",
	],
	[
		"a discovery that lists fewer upgrades than its summary counts",
		{
			discovery: {
				exitCode: 1,
				stdout:
					"Reading package lists...\nBuilding dependency tree...\nReading state information...\nCalculating upgrade...\nThe following packages will be upgraded:\n  curl\n2 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\nNeed to get 4 kB of archives.\nDo you want to continue? [Y/n] N\nAbort.\n",
			},
		},
		"legacy",
	],
	[
		"the kept-back fallback plan, whose own exit is not read",
		{ keptBack: [cerastream("2")] },
		"legacy",
	],
	[
		"a clean refresh that never reached CeraLive's index (its source still cached)",
		{ refresh: { stdout: DEBIAN_ONLY_REFRESH } },
		"both",
	],
	[
		"nothing pending while dpkg shows the offered package still below the offer",
		{ installed: [cerastream("1", { installed: "1" })] },
		"both",
	],
	[
		"another architecture's instance of an offered package planned",
		{
			upgradable: [
				{
					name: "cerastream:armhf",
					installed: "1",
					candidate: "2",
					arch: "armhf",
				},
			],
		},
		"both",
	],
	[
		"an upgrade list naming one package twice",
		{
			discovery: {
				exitCode: 1,
				stdout:
					"Reading package lists...\nBuilding dependency tree...\nReading state information...\nCalculating upgrade...\nThe following packages will be upgraded:\n  curl curl\n2 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\nNeed to get 4 kB of archives.\nDo you want to continue? [Y/n] N\nAbort.\n",
			},
		},
		"legacy",
	],
	[
		"a first-party package only newly installed beside an unrelated upgrade",
		{ upgradable: [curl, modemSupport("2026.1")] },
		"legacy",
	],
	[
		"a kept-back fallback that failed yet reads as nothing pending",
		{
			keptBack: [cerastream("2")],
			fallback: {
				exitCode: 100,
				stdout:
					"0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n",
				stderr:
					"E: Unable to correct problems, you have held broken packages.\n",
			},
		},
		"legacy",
	],
];

for (const capable of [false, true])
	describe(`${capable ? "capable" : "legacy"} image: a check whose own evidence is missing`, () => {
		const image = capable ? "capable" : "legacy";
		beforeEach(async () => {
			if (capable) await useCapableImage();
		});

		for (const [read, how, on] of unanswered)
			if (on === "both" || on === image)
				test(`${read} ${how} keeps the offer and records nothing`, async () => {
					// Given the offer shown and recorded.
					await check({ upgradable: [cerastream("2")] });
					const before = await readFile(join(dir, "offer.json"), "utf8");
					// When it is installed and one command of the next conclusive check does not answer
					// (capable discovery runs both itself, so there the whole check refuses).
					expect(
						await check({ ...installedRelease, fail: { [read]: how } }),
					).toBe(capable ? "discovery_failed" : null);
					// Then nothing is removed, delivered or written.
					expect(liveRemovals()).toEqual([]);
					expect(notificationExists(NOTICE)?.dismissalKey).toBe(
						"update:cerastream:arm64=2",
					);
					expect(replayedRemovals()).toEqual([]);
					expect(await readFile(join(dir, "offer.json"), "utf8")).toBe(before);
				});

		for (const [label, variation, on] of incomplete)
			if (on === "both" || on === image)
				test(`${label} keeps the offer and records nothing`, async () => {
					await check({ upgradable: [cerastream("2")] });
					const before = await readFile(join(dir, "offer.json"), "utf8");
					// When it is installed and the next check's evidence is incomplete in this one way.
					await check({ ...installedRelease, ...variation });
					expect(liveRemovals()).toEqual([]);
					expect(notificationExists(NOTICE)?.dismissalKey).toBe(
						"update:cerastream:arm64=2",
					);
					expect(replayedRemovals()).toEqual([]);
					expect(await readFile(join(dir, "offer.json"), "utf8")).toBe(before);
				});

		test("after the install, a conclusive check that finds nothing pending withdraws and records none", async () => {
			await check({ upgradable: [cerastream("2")] });
			await check(installedRelease);
			expect(liveRemovals()).toEqual([NOTICE]);
			expect(await recorded()).toEqual({ version: 8, offer: null });
		});

		test("a plan cut right after its summary hides no first-party row", async () => {
			await check({ upgradable: [cerastream("2")] });
			const before = await readFile(join(dir, "offer.json"), "utf8");
			// When the release is still pending but the answer is lost after its summary.
			await check({
				upgradable: [cerastream("2")],
				fail: capable
					? { simulation: "cut-after-summary" }
					: { discovery: "cut-after-summary" },
			});
			// Then the cut answer is not read as an empty plan.
			expect(liveRemovals()).toEqual([]);
			expect(notificationExists(NOTICE)?.dismissalKey).toBe(
				"update:cerastream:arm64=2",
			);
			expect(await readFile(join(dir, "offer.json"), "utf8")).toBe(before);
		});

		test("a roster dependency the plan installs is part of the offer Install takes", async () => {
			// When the plan upgrades cerastream and newly installs a roster package with it.
			await check({ upgradable: [cerastream("2"), modemSupport("2026.1")] });
			// Then capable Install pins the whole plan, so the offer keys both exact versions.
			// Legacy Install names only the upgrades and APT brings the dependency, which no
			// offer names: that check is not complete and shows nothing.
			expect(notificationExists(NOTICE)?.dismissalKey).toBe(
				capable
					? "update:ceralive-modem-support:arm64=2026.1,cerastream:arm64=2"
					: undefined,
			);
		});

		test("an architecture-independent package is offered and proven as its own instance", async () => {
			await check({ upgradable: [cerastream("2", { arch: "all" })] });
			expect(await recorded()).toEqual({
				version: 8,
				offer: [{ name: "cerastream", arch: "all", version: "2" }],
			});
			broadcast.mockClear();
			await proveInstalled({
				installed: [cerastream("2", { installed: "2", arch: "all" })],
			});
			expect(liveRemovals()).toEqual([NOTICE]);
		});

		test("a candidate the solver keeps back leaves the check incomplete: the upgrade beside it is neither shown nor recorded", async () => {
			await check({ upgradable: [srtla("2.0")], keptBack: [cerastream("2")] });
			expect(notificationExists(NOTICE)).toBeUndefined();
			expect(currentTab(liveFrames())).not.toContain(NOTICE);
			expect(await Bun.file(join(dir, "offer.json")).exists()).toBe(false);
		});
	});

describe("capable image: the check's own plan", () => {
	beforeEach(useCapableImage);

	test("a plan that only installs a roster dependency, cut after its summary, keeps the offer", async () => {
		// Given the capable plan newly installs a roster package, and that offer is shown.
		await check({ upgradable: [modemSupport("2026.1")] });
		expect(notificationExists(NOTICE)?.dismissalKey).toBe(
			"update:ceralive-modem-support:arm64=2026.1",
		);
		const before = await readFile(join(dir, "offer.json"), "utf8");
		// When the next answer keeps "0 upgraded, 1 newly installed" but loses the Inst row.
		await check({
			upgradable: [modemSupport("2026.1")],
			fail: { simulation: "cut-after-summary" },
		});
		// Then "0 upgraded" in the text is not read as an empty plan.
		expect(liveRemovals()).toEqual([]);
		expect(notificationExists(NOTICE)?.dismissalKey).toBe(
			"update:ceralive-modem-support:arm64=2026.1",
		);
		expect(await readFile(join(dir, "offer.json"), "utf8")).toBe(before);
	});
});

for (const capable of [false, true])
	describe(`${capable ? "capable" : "legacy"} image: one slot, one rule`, () => {
		beforeEach(async () => {
			if (capable) await useCapableImage();
		});

		const noticeShows = (frames: readonly unknown[]) =>
			frames.filter((frame) =>
				(frame as { show?: { name: string }[] }).show?.some(
					({ name }) => name === NOTICE,
				),
			).length;

		test("a new release inside the rate limit still reaches every connected tab", async () => {
			const frames: unknown[] = [];
			// When three checks within a second find releases 2, 3 and 4 (the limiter holds the
			// third update of a slot inside a second of the second).
			for (const release of ["2", "3", "4"]) {
				await check({ upgradable: [cerastream(release)] });
				frames.push(...liveFrames());
			}
			// Then connected tabs are sent every copy, so the slot is what they hold.
			expect(noticeShows(frames)).toBe(3);
			expect(notificationExists(NOTICE)?.dismissalKey).toBe(
				"update:cerastream:arm64=4",
			);
		});

		test("a login is told no removal, before or after a later check that is not conclusive", async () => {
			await check({ upgradable: [cerastream("2")] });
			await check(installedRelease);
			expect(replayedRemovals()).toEqual([]);
			// When the next check's refresh fails, a tab that logs in is still not told.
			await check({
				...installedRelease,
				refresh: { exitCode: 100, stderr: "E: Could not get lock\n" },
			});
			expect(replayedRemovals()).toEqual([]);
		});

		test('with no stored offer, a held first-party package beside an unrelated upgrade is no "none"', async () => {
			// Given no record (a backend before this notice raised the banner).
			await check({
				keptBack: [cerastream("2")],
				holds: ["cerastream"],
				upgradable: [curl],
			});
			expect(liveRemovals()).toEqual([]);
			expect(replayedRemovals()).toEqual([]);
			expect(await Bun.file(join(dir, "offer.json")).exists()).toBe(false);
		});

		// Each sequence ends with the copy a connected tab holds (it started with a copy a
		// predecessor raised) and the copy a tab keeps when it logs in afterwards.
		type Steps = { a?: ReturnType<typeof standingCeraliveOffer> };
		const step = {
			offerA: async (c: Steps) => {
				await check({ upgradable: [cerastream("2")] });
				c.a = standingCeraliveOffer();
			},
			offerB: () => check({ upgradable: [cerastream("3")] }),
			noneInstalled: () => check(installedRelease),
			noneBelow: () =>
				check({ installed: [cerastream("1", { installed: "1" })] }),
			failingRefresh: () =>
				check({
					...installedRelease,
					refresh: { exitCode: 100, stderr: "E: Could not get lock\n" },
				}),
			debianOnlyRefresh: () =>
				check({
					...installedRelease,
					refresh: { stdout: DEBIAN_ONLY_REFRESH },
				}),
			heldBesideCurl: () =>
				check({
					keptBack: [cerastream("2")],
					holds: ["cerastream"],
					upgradable: [curl],
				}),
			proveA: async (c: Steps) => {
				script = { installed: [cerastream("3", { installed: "3" })] };
				await withdrawCeraliveOfferIfInstalled(c.a ?? null);
			},
			proveStanding: () => proveInstalled(installedRelease),
			// A real restart sends nothing; emptying this process's registry broadcasts removals.
			restart: async () => {
				clearPersistentNotices();
				broadcast.mockClear();
				initNotice();
			},
			dismissA: async () => {
				recordNotificationDismissal("update:cerastream:arm64=2");
			},
			// A dismissal of the release shown, from a connected tab.
			dismissLive: async () => {
				notificationDismiss(NOTICE, shown());
			},
			// The device's evidence changes (a rollback) and no check runs.
			rollback: async () => {
				script = { upgradable: [cerastream("2")] };
			},
			keptBackBesideB: () =>
				check({ upgradable: [srtla("2.0")], keptBack: [cerastream("2")] }),
			heldAlone: () =>
				check({ keptBack: [cerastream("2")], holds: ["cerastream"] }),
			completeBoth: () =>
				check({ upgradable: [cerastream("2"), srtla("2.0")] }),
			// srtla 2.0 installed while cerastream stays kept back at 1.
			proveB: () =>
				proveInstalled({
					installed: [srtla("2.0", { installed: "2.0" })],
					keptBack: [cerastream("2")],
				}),
		} satisfies Record<string, (c: Steps) => unknown>;
		const sequences: readonly [
			string,
			readonly (keyof typeof step)[],
			"kept" | "removed",
			"kept" | "removed",
		][] = [
			[
				"a complete check finds the offer installed",
				["offerA", "noneInstalled"],
				"removed",
				"kept",
			],
			[
				"the install's proof of the offer this process shows",
				["offerA", "proveStanding"],
				"removed",
				"kept",
			],
			[
				"the install's proof of a stored offer after a restart",
				["offerA", "restart", "proveStanding"],
				"kept",
				"kept",
			],
			["a restart with a stored offer", ["offerA", "restart"], "kept", "kept"],
			[
				"a restart with a dismissed stored offer",
				["offerA", "dismissA", "restart"],
				"kept",
				"kept",
			],
			[
				"a complete check finding the dismissed set",
				["offerA", "dismissA", "offerA"],
				"removed",
				"kept",
			],
			[
				"a newer offer, then proof of the older one",
				["offerA", "offerB", "proveA"],
				"kept",
				"kept",
			],
			[
				"a complete none, then a check that is not conclusive",
				["offerA", "noneInstalled", "failingRefresh"],
				"removed",
				"kept",
			],
			[
				"nothing pending while dpkg shows the offer below",
				["offerA", "noneBelow"],
				"kept",
				"kept",
			],
			[
				"a refresh that never reached CeraLive",
				["offerA", "debianOnlyRefresh"],
				"kept",
				"kept",
			],
			[
				"a held first-party package beside an unrelated upgrade",
				["offerA", "heldBesideCurl"],
				"kept",
				"kept",
			],
			[
				"a held package, no stored offer",
				["restart", "heldBesideCurl"],
				"kept",
				"kept",
			],
			[
				"a complete none, then the evidence changes before a login",
				["offerA", "noneInstalled", "rollback"],
				"removed",
				"kept",
			],
			[
				"a dismissal in another tab, then a login",
				["offerA", "dismissLive"],
				"removed",
				"kept",
			],
			[
				"an incomplete check beside the offer, then the install of the other package",
				["offerA", "keptBackBesideB", "proveB"],
				"kept",
				"kept",
			],
			[
				"a stored offer, an incomplete check beside it, then the install of the other package",
				["offerA", "restart", "keptBackBesideB", "proveB"],
				"kept",
				"kept",
			],
			[
				"an incomplete check, then a complete one",
				["restart", "keptBackBesideB", "completeBoth"],
				"kept",
				"kept",
			],
			[
				"the offer's hold changes, then a complete none",
				["offerA", "heldAlone", "noneInstalled"],
				"removed",
				"kept",
			],
			[
				"a stored offer, then a newer complete offer",
				["offerA", "restart", "offerB"],
				"kept",
				"kept",
			],
		];

		for (const [label, steps, connected, login] of sequences)
			test(`${label}: connected tab ${connected}, later login ${login}`, async () => {
				const c: Steps = {};
				const frames: unknown[] = [];
				for (const name of steps) {
					await step[name](c);
					frames.push(...liveFrames());
					broadcast.mockClear();
				}
				const state = (names: string[]) =>
					names.includes(NOTICE) ? "kept" : "removed";
				expect([
					state(currentTab(frames, [NOTICE])),
					state(legacyTab(frames, [NOTICE])),
					state(currentTab(replayFrames(), [NOTICE])),
					state(legacyTab(replayFrames(), [NOTICE])),
				]).toEqual([connected, connected, login, login]);
			});
	});
