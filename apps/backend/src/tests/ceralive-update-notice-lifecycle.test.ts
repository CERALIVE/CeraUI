/*
 * The "A CeraLive update is available" notice (`ceralive_update`) used to be
 * raised by both discovery paths and never withdrawn: after a Rock was updated to
 * the candidate, an already-open tab kept the banner forever. These tests drive
 * the real check entry points (refresh + discovery) and the real install
 * completion over scripted APT and dpkg output, and pin when the notice may
 * change: a conclusive check with every first-party candidate verified (keyed by
 * the exact versions the Install control would take), or a finished install that
 * dpkg proves took the offer. Logins and restarts run no command at all.
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
	withdrawCeraliveOfferIfInstalled,
} from "../modules/system/ceralive-update-notice.ts";
import {
	getUpdateState,
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
	replayToAuthenticated,
	setAuthenticatedReplay,
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
	type FailedRead,
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
// Every APT argv the code under test ran in this case.
let seen: string[][] = [];
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

// What an authenticating tab receives after the show replay (decided when it authenticates).
async function replayedRemovals(): Promise<unknown[]> {
	const frames: unknown[] = [];
	await replayToAuthenticated((frame) => frames.push(frame));
	return frames;
}

async function replayFrames(): Promise<unknown[]> {
	return [
		{ ...getPersistentNotifications(true), replay: true },
		...(await replayedRemovals()),
	];
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
	setAptCommandRunnerForTest((argv) => {
		seen.push([...argv]);
		return scriptedApt(script)(argv);
	});
	initCeraliveUpdateNotice({ path: join(dir, "offer.json") });
	broadcast = spyOn(websocket, "broadcastMsg");
});

afterEach(async () => {
	broadcast.mockRestore();
	setAuthenticatedReplay(undefined);
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
			dismissalKey: "update:cerastream=2026.11.3,srtla=1.1",
		});
	});

	test("nothing pending after the update withdraws it live in current and pre-#183 tabs; a later login is told only by an install's proof", async () => {
		// Given the offer that was installed, plus OS and kernel notices on the same surface.
		standing(OS_OFFER);
		standing(KERNEL);
		await check({ upgradable: [cerastream("2")] });
		expect(notificationExists(NOTICE)).toBeDefined();
		// When the conclusive check after the update finds nothing pending.
		await check({});
		// Then connected tabs of both frontend generations drop only the offer.
		const open = [NOTICE, OS_OFFER, KERNEL];
		expect(currentTab(liveFrames(), open)).toEqual([KERNEL, OS_OFFER].sort());
		expect(legacyTab(liveFrames(), open)).toEqual([KERNEL, OS_OFFER].sort());
		// And a tab that reconnects later is not told: a check's verdict is never delivered at login.
		expect(await replayedRemovals()).toEqual([]);
		expect(currentTab(await replayFrames(), open)).toEqual([...open].sort());
		// And a fresh tab never sees it.
		expect(currentTab(await replayFrames())).toEqual([KERNEL, OS_OFFER].sort());
	});

	test("the typed removal withdraws a current tab but does not reach a pre-#183 tab", async () => {
		await check({ upgradable: [cerastream("2")] });
		await check({});
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
			"update:cerastream=2",
		);
		expect(currentTab(await replayFrames(), [NOTICE])).toEqual([NOTICE]);
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
		expect(isNotificationDismissed("update:cerastream=2")).toBe(false);
		expect(notificationExists(NOTICE)).toBeDefined();
		await check({ upgradable: [cerastream("2")] });
		expect(liveRemovals()).toEqual([]);
		expect(currentTab(await replayFrames(), [NOTICE])).toEqual([NOTICE]);
	});

	test("an independent update left after the install replaces the offer without a withdrawal", async () => {
		await check({ upgradable: [cerastream("2")] });
		// When the post-restart check finds srtla still pending (cerastream installed).
		await check({ upgradable: [srtla("1.1")] });
		// Then the notice stays up for the remaining release.
		expect(liveRemovals()).toEqual([]);
		expect(notificationExists(NOTICE)?.dismissalKey).toBe("update:srtla=1.1");
		expect(await replayedRemovals()).toEqual([]);
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
				"update:cerastream=2",
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
				"update:cerastream=2",
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
				"update:cerastream=2",
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
		// When the same release is discovered again, it stays hidden and withdrawn for reconnecting tabs.
		await check({ upgradable: [cerastream("2")] });
		expect(notificationExists(NOTICE)).toBeUndefined();
		expect(currentTab(await replayFrames(), [NOTICE])).toEqual([]);
		// When a new release of the same package with the same size appears.
		await check({ upgradable: [cerastream("3")] });
		// Then it is offered again.
		expect(notificationExists(NOTICE)?.dismissalKey).toBe(
			"update:cerastream=3",
		);
		expect(await replayedRemovals()).toEqual([]);
	});

	test("a tab that missed a dismissal in another tab drops the notice on reconnect", async () => {
		await check({ upgradable: [cerastream("2")] });
		const seen = shown();
		// When one tab dismisses the release it shows.
		notificationDismiss(NOTICE, seen);
		// Then the replay another tab of either generation receives carries the removal.
		expect(currentTab(await replayFrames(), [NOTICE])).toEqual([]);
		expect(legacyTab(await replayFrames(), [NOTICE])).toEqual([]);
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
		expect(isNotificationDismissed("update:cerastream=3")).toBe(false);
		expect(isNotificationDismissed("update:cerastream=2")).toBe(false);
		expect(notificationExists(NOTICE)?.dismissalKey).toBe(
			"update:cerastream=3",
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
		expect(isNotificationDismissed("update:cerastream=2")).toBe(false);
		expect(notificationExists(NOTICE)).toBeDefined();
		expect(liveFrames()).toEqual([]);
		expect(sent).toEqual([]);
	});

	test("a dismissed successor withdraws the predecessor instead of keeping it alive", async () => {
		await check({ upgradable: [cerastream("2")] });
		// Given the operator already dismissed the next release.
		recordNotificationDismissal("update:cerastream=3");
		// When a conclusive check finds that dismissed release.
		await check({ upgradable: [cerastream("3")] });
		// Then the older offer leaves every tab.
		expect(liveRemovals()).toEqual([NOTICE]);
		expect(notificationExists(NOTICE)).toBeUndefined();
		expect(currentTab(await replayFrames(), [NOTICE])).toEqual([]);
	});

	test("the legacy relay replay sends the show frame first, then both removal forms", async () => {
		standing(OS_OFFER);
		await check({ upgradable: [cerastream("2")] });
		// Given the installed offer proven by dpkg in this process.
		await withdrawCeraliveOfferIfInstalled(scriptedApt(installedRelease));
		const sent: string[] = [];
		await notificationSendPersistent(
			{ send: (frame: string) => sent.push(frame) },
			true,
		);
		const frames = sent.map((frame) => JSON.parse(frame).notification);
		expect(frames).toHaveLength(3);
		expect(frames[0]).toMatchObject({ replay: true });
		expect(currentTab(frames, [NOTICE])).toEqual([OS_OFFER]);
		expect(legacyTab(frames, [NOTICE])).toEqual([OS_OFFER]);
	});
});

describe("capable image", () => {
	beforeEach(useCapableImage);

	test("srtla from the CeraLive origin raises the localized notice keyed by version", async () => {
		expect(await check({ upgradable: [srtla("2.0")] })).toBeNull();
		expect(notificationExists(NOTICE)).toMatchObject({
			key: "notifications.ceraliveUpdateAvailable",
			action: { kind: "navigate", target: "updates-dialog" },
			dismissalKey: "update:srtla=2.0",
		});
	});

	test("verified Debian-only upgrades withdraw the CeraLive offer", async () => {
		await check({ upgradable: [srtla("2.0")] });
		// When srtla is installed and only a Debian security update remains.
		await check({ upgradable: [curl] });
		expect(getUpdateState()).toMatchObject({ actionable_count: 1 });
		expect(liveRemovals()).toEqual([NOTICE]);
		// A later login is told only by an install's proof, not by this check.
		expect(await replayedRemovals()).toEqual([]);
	});

	test("a Debian-only refresh without CeraLive's source keeps the offer", async () => {
		await check({ upgradable: [srtla("2.0")] });
		await check({ upgradable: [curl], inventory: DEBIAN_ONLY_INVENTORY });
		expect(liveRemovals()).toEqual([]);
		expect(currentTab(await replayFrames(), [NOTICE])).toEqual([NOTICE]);
	});

	test("a first-party candidate whose policy disagrees with the simulation leaves the offer untouched", async () => {
		await check({ upgradable: [srtla("2.0")] });
		// When the simulation says 2.1 but the policy candidate is still 2.0.
		await check({ upgradable: [srtla("2.0", { planned: "2.1" })] });
		// Then the unverified row is not read as "no offer remains".
		expect(liveRemovals()).toEqual([]);
		expect(notificationExists(NOTICE)?.dismissalKey).toBe("update:srtla=2.0");
	});

	test("a dismissed verified subset never withdraws while another first-party candidate is unverified", async () => {
		await check({ upgradable: [cerastream("2"), srtla("3")] });
		expect(notificationExists(NOTICE)?.dismissalKey).toBe(
			"update:cerastream=2,srtla=3",
		);
		// Given the operator dismissed cerastream=2 alone in an earlier release.
		recordNotificationDismissal("update:cerastream=2");
		// When cerastream=2 verifies but srtla's policy disagrees with its simulation.
		await check({
			upgradable: [cerastream("2"), srtla("3.1", { planned: "3" })],
		});
		// Then srtla's pending offer stays on screen.
		expect(liveRemovals()).toEqual([]);
		expect(notificationExists(NOTICE)?.dismissalKey).toBe(
			"update:cerastream=2,srtla=3",
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
						conclusive?: boolean,
					) => unknown
				>();
			setSoftwareUpdateCheckRunner((callback) => {
				refreshed.resolve(callback);
				return true;
			});
			script = {};
			broadcast.mockClear();
			start();
			const settle = await refreshed.promise;
			// The periodic loop reschedules itself; keep that timer out of the test.
			jest.useFakeTimers();
			// When the refresh was not conclusive, the same "nothing pending" lists change nothing.
			await settle(true, 1, false);
			expect(liveRemovals()).toEqual([]);
			// When a conclusive refresh precedes the same discovery, the offer is withdrawn.
			await settle(null, 0, true);
			expect(liveRemovals()).toEqual([NOTICE]);
		},
	);
});

describe("a finished install", () => {
	// The device's dpkg answers the proof, recorded in `seen`.
	function device(state: AptScript) {
		return (argv: string[]) => {
			seen.push([...argv]);
			return scriptedApt(state)(argv);
		};
	}

	test("withdraws the offer before the update's restart when dpkg shows it installed", async () => {
		await check({ upgradable: [cerastream("2")] });
		setAptCommandRunnerForTest(null);
		// The harness observes the same broadcast seam; two wrappers would call each other.
		broadcast.mockRestore();
		// When the legacy transaction for the offer succeeds and the backend restarts itself.
		await using h = await updateHarness();
		seen = [];
		setAptCommandRunnerForTest(device(installedRelease));
		h.completion = Promise.resolve(0);
		startSoftwareUpdate();
		await h.check();
		await h.restarted();
		// Then by the restart the proof is durable and the notice is gone for live and later tabs.
		expect(getUpdateState()).toEqual({ kind: "success" });
		expect(await recorded()).toEqual({
			version: 7,
			offer: null,
			installed: [{ name: "cerastream", version: "2" }],
		});
		expect(notificationExists(NOTICE)).toBeUndefined();
		expect(currentTab(await replayFrames(), [NOTICE])).toEqual([]);
		expect(legacyTab(await replayFrames(), [NOTICE])).toEqual([]);
		// And only dpkg was asked: its status, then its own version comparison.
		expect(seen).toEqual([
			[
				"/usr/bin/dpkg-query",
				"-W",
				"-f",
				"$" + "{Package}\t$" + "{Status}\t$" + "{Version}\n",
				"cerastream",
			],
			["/usr/bin/dpkg", "--compare-versions", "2", "ge", "2"],
		]);
	});

	test("a successful install is not evidence when dpkg does not show the offer installed", async () => {
		await check({ upgradable: [cerastream("2")] });
		setAptCommandRunnerForTest(null);
		broadcast.mockRestore();
		// When the transaction succeeds but cerastream is still at 1.
		await using h = await updateHarness();
		setAptCommandRunnerForTest(
			device({ installed: [cerastream("2", { installed: "1" })] }),
		);
		h.completion = Promise.resolve(0);
		startSoftwareUpdate();
		await h.check();
		await h.restarted();
		// Then the update still restarts, and only the next conclusive check may withdraw the notice.
		expect(getUpdateState()).toEqual({ kind: "success" });
		expect(await replayedRemovals()).toEqual([]);
		expect(
			getPersistentNotifications(true).show.map(({ name }) => name),
		).toContain(NOTICE);
	});

	test("dpkg, not a string comparison, decides the installed version reaches the offer", async () => {
		await check({
			upgradable: [cerastream("2026.9.1", { installed: "2026.8.0" })],
		});
		// When 2026.10.0 is installed: lower than 2026.9.1 as text, higher to dpkg.
		await withdrawCeraliveOfferIfInstalled(
			scriptedApt({
				installed: [cerastream("2026.10.0", { installed: "2026.10.0" })],
			}),
		);
		expect(liveRemovals()).toEqual([NOTICE]);
		expect(await recorded()).toEqual({
			version: 7,
			offer: null,
			installed: [{ name: "cerastream", version: "2026.9.1" }],
		});
	});

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
			"dpkg reporting config-files for an offered package",
			{
				...bothInstalled,
				dpkgStatus: { cerastream: "deinstall ok config-files" },
			},
		],
		[
			"dpkg reporting an offered package half-configured",
			{
				...bothInstalled,
				dpkgStatus: { cerastream: "install ok half-configured" },
			},
		],
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
			await withdrawCeraliveOfferIfInstalled(scriptedApt(state));
			// Then nothing is removed, delivered or written.
			expect(liveRemovals()).toEqual([]);
			expect(notificationExists(NOTICE)?.dismissalKey).toBe(
				"update:cerastream=2,srtla=1.1",
			);
			expect(await replayedRemovals()).toEqual([]);
			expect(await readFile(join(dir, "offer.json"), "utf8")).toBe(before);
		});

	test("a check that records a newer offer while dpkg is read wins", async () => {
		await check({ upgradable: [cerastream("2")] });
		const reading = Promise.withResolvers<void>();
		const held = Promise.withResolvers<void>();
		// When the proof's dpkg read is held, and a check finds release 3 meanwhile.
		const proving = withdrawCeraliveOfferIfInstalled(async (argv) => {
			if (argv[0] === "/usr/bin/dpkg-query") {
				reading.resolve();
				await held.promise;
			}
			return scriptedApt(installedRelease)(argv);
		});
		await reading.promise;
		await check({ upgradable: [cerastream("3", { installed: "2" })] });
		held.resolve();
		await proving;
		// Then the newer offer stays shown and recorded.
		expect(liveRemovals()).toEqual([]);
		expect(notificationExists(NOTICE)?.dismissalKey).toBe(
			"update:cerastream=3",
		);
		expect(await recorded()).toEqual({
			version: 7,
			offer: [{ name: "cerastream", version: "3" }],
		});
	});

	test("an install with no recorded offer proves nothing and runs nothing", async () => {
		seen = [];
		await withdrawCeraliveOfferIfInstalled(device(installedRelease));
		expect(seen).toEqual([]);
		expect(await Bun.file(join(dir, "offer.json")).exists()).toBe(false);
	});
});

for (const capable of [false, true])
	describe(`${capable ? "capable" : "legacy"} image: logins and restarts`, () => {
		beforeEach(async () => {
			if (capable) await useCapableImage();
		});

		test("run no command, and an install's proof is delivered by the next process only", async () => {
			await check({ upgradable: [cerastream("2")] });
			await withdrawCeraliveOfferIfInstalled(scriptedApt(installedRelease));
			seen = [];
			// A login to the proving process is told.
			expect(await replayedRemovals()).toHaveLength(2);
			// The next process (the install's own restart) is told too, and takes the proof from the file.
			initCeraliveUpdateNotice({ path: join(dir, "offer.json") });
			expect(await replayedRemovals()).toHaveLength(2);
			expect(await recorded()).toEqual({ version: 7, offer: null });
			// A later restart has nothing to deliver.
			initCeraliveUpdateNotice({ path: join(dir, "offer.json") });
			expect(await replayedRemovals()).toEqual([]);
			// And none of it ran any command.
			expect(seen).toEqual([]);
		});

		test("a proof the file cannot give up is delivered by no process that kept it there", async () => {
			await check({ upgradable: [cerastream("2")] });
			await withdrawCeraliveOfferIfInstalled(scriptedApt(installedRelease));
			// When the next process cannot rewrite the record, it delivers nothing.
			initCeraliveUpdateNotice({
				path: join(dir, "offer.json"),
				write: () => {
					throw new Error("state directory is read-only");
				},
			});
			expect(await replayedRemovals()).toEqual([]);
			// Then the first process that can take it delivers it.
			initCeraliveUpdateNotice({ path: join(dir, "offer.json") });
			expect(await replayedRemovals()).toHaveLength(2);
		});

		test("a login during a live stream or with updates disabled runs nothing and is still told an install's proof", async () => {
			await check({ upgradable: [cerastream("2")] });
			await withdrawCeraliveOfferIfInstalled(scriptedApt(installedRelease));
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
				const frames = await replayedRemovals();
				restore();
				expect([label, frames.length, seen]).toEqual([label, 2, []]);
			}
		});

		test("startup re-announces a stored offer, and a dismissed one only withdraws", async () => {
			await check({ upgradable: [cerastream("2")] });
			// When a fresh process loads the record (it starts with no notices).
			clearPersistentNotices();
			initCeraliveUpdateNotice({ path: join(dir, "offer.json") });
			// Then the stored offer is shown again and nothing is removed.
			expect(notificationExists(NOTICE)?.dismissalKey).toBe(
				"update:cerastream=2",
			);
			expect(await replayedRemovals()).toEqual([]);
			// When that release was dismissed, a fresh process withdraws it instead.
			recordNotificationDismissal("update:cerastream=2");
			clearPersistentNotices();
			broadcast.mockClear();
			initCeraliveUpdateNotice({ path: join(dir, "offer.json") });
			expect(notificationExists(NOTICE)).toBeUndefined();
			expect(liveRemovals()).toEqual([NOTICE]);
			expect(await replayedRemovals()).toHaveLength(2);
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
						"update:cerastream=2",
					);
					expect(await replayedRemovals()).toEqual([]);
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
						"update:cerastream=2",
					);
					expect(await replayedRemovals()).toEqual([]);
					expect(await readFile(join(dir, "offer.json"), "utf8")).toBe(before);
				});

		test("after the install, a conclusive check that finds nothing pending withdraws and records none", async () => {
			await check({ upgradable: [cerastream("2")] });
			await check(installedRelease);
			expect(liveRemovals()).toEqual([NOTICE]);
			expect(await recorded()).toEqual({ version: 7, offer: null });
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
				"update:cerastream=2",
			);
			expect(await readFile(join(dir, "offer.json"), "utf8")).toBe(before);
		});

		test("a roster dependency the plan installs is part of the offer Install takes", async () => {
			// When the plan upgrades cerastream and newly installs a roster package with it.
			await check({ upgradable: [cerastream("2"), modemSupport("2026.1")] });
			// Then the offer is what Install takes, keyed by exact versions: capable Install pins
			// the whole plan, legacy Install names the upgrades and APT brings the dependency.
			expect(notificationExists(NOTICE)?.dismissalKey).toBe(
				capable
					? "update:ceralive-modem-support=2026.1,cerastream=2"
					: "update:cerastream=2",
			);
		});

		test("a candidate the solver keeps back does not veto the valid upgrade beside it", async () => {
			await check({ upgradable: [srtla("2.0")], keptBack: [cerastream("2")] });
			expect(notificationExists(NOTICE)?.dismissalKey).toBe("update:srtla=2.0");
		});
	});

describe("capable image: the check's own plan", () => {
	beforeEach(useCapableImage);

	test("a plan that only installs a roster dependency, cut after its summary, keeps the offer", async () => {
		// Given the capable plan newly installs a roster package, and that offer is shown.
		await check({ upgradable: [modemSupport("2026.1")] });
		expect(notificationExists(NOTICE)?.dismissalKey).toBe(
			"update:ceralive-modem-support=2026.1",
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
			"update:ceralive-modem-support=2026.1",
		);
		expect(await readFile(join(dir, "offer.json"), "utf8")).toBe(before);
	});
});
