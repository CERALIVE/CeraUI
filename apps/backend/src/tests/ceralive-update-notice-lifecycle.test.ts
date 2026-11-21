/*
 * The "A CeraLive update is available" notice (`ceralive_update`) used to be
 * raised by both discovery paths and never withdrawn: after a Rock was updated to
 * the candidate, an already-open tab kept the banner forever. These tests drive
 * the real check entry points (refresh + discovery) over scripted APT output and
 * pin when the notice may change: only a conclusive check with every first-party
 * candidate verified, keyed by the exact versions the Install control would take.
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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notificationsMessageSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import { setup } from "../modules/setup.ts";
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
	replayedRemovalFrames,
} from "../modules/ui/notifications.ts";
import * as websocket from "../modules/ui/websocket-server.ts";
import { dismissNotificationProcedure } from "../rpc/procedures/notifications.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import {
	type AptPackage,
	type AptScript,
	DEBIAN_ONLY_INVENTORY,
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
const curl = {
	name: "curl",
	installed: "8.1",
	candidate: "8.2",
	source: "debian",
} as const;

let dir: string;
let script: AptScript;
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

function replayFrames(): unknown[] {
	return [
		{ ...getPersistentNotifications(true), replay: true },
		...replayedRemovalFrames(true),
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

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ceralive-update-notice-"));
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
	setAptCommandRunnerForTest((argv) => scriptedApt(script)(argv));
	broadcast = spyOn(websocket, "broadcastMsg");
});

afterEach(async () => {
	broadcast.mockRestore();
	for (const name of [NOTICE, OS_OFFER, KERNEL]) notificationRemove(name);
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

	test("nothing pending after the update withdraws it in current and pre-#183 tabs, live and on reconnect", async () => {
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
		// And a tab that reconnects later is told too; a fresh tab never sees it.
		expect(currentTab(replayFrames(), open)).toEqual([KERNEL, OS_OFFER].sort());
		expect(legacyTab(replayFrames(), open)).toEqual([KERNEL, OS_OFFER].sort());
		expect(currentTab(replayFrames())).toEqual([KERNEL, OS_OFFER].sort());
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
		expect(isNotificationDismissed("update:cerastream=2")).toBe(false);
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
		expect(notificationExists(NOTICE)?.dismissalKey).toBe("update:srtla=1.1");
		expect(replayedRemovalFrames(true)).toEqual([]);
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
			"a policy candidate that differs from the install plan",
			{ upgradable: [cerastream("3", { planned: "2" })] },
		],
		[
			"a candidate from another origin",
			{ upgradable: [cerastream("2", { source: "debian" })] },
		],
		[
			"a policy that cannot be read",
			{ upgradable: [cerastream("2")], policyFails: ["cerastream"] },
		],
		[
			"an install plan that no longer takes a listed package",
			{ upgradable: [cerastream("2")], planOmits: ["cerastream"] },
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
		expect(currentTab(replayFrames(), [NOTICE])).toEqual([]);
		// When a new release of the same package with the same size appears.
		await check({ upgradable: [cerastream("3")] });
		// Then it is offered again.
		expect(notificationExists(NOTICE)?.dismissalKey).toBe(
			"update:cerastream=3",
		);
		expect(replayedRemovalFrames(true)).toEqual([]);
	});

	test("a tab that missed a dismissal in another tab drops the notice on reconnect", async () => {
		await check({ upgradable: [cerastream("2")] });
		const seen = shown();
		// When one tab dismisses the release it shows.
		notificationDismiss(NOTICE, seen);
		// Then the replay another tab of either generation receives carries the removal.
		expect(currentTab(replayFrames(), [NOTICE])).toEqual([]);
		expect(legacyTab(replayFrames(), [NOTICE])).toEqual([]);
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
		expect(currentTab(replayFrames(), [NOTICE])).toEqual([]);
	});

	test("the legacy relay replay sends the show frame first, then both removal forms", async () => {
		standing(OS_OFFER);
		await check({ upgradable: [cerastream("2")] });
		await check({});
		const sent: string[] = [];
		notificationSendPersistent(
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
		expect(currentTab(replayFrames(), [NOTICE])).toEqual([]);
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

test("a successful install is not evidence that no offer remains", async () => {
	await check({ upgradable: [cerastream("2")] });
	setAptCommandRunnerForTest(null);
	// The harness observes the same broadcast seam; two wrappers would call each other.
	broadcast.mockRestore();
	// When the legacy transaction for the offer succeeds and the backend restarts itself.
	await using h = await updateHarness();
	h.completion = Promise.resolve(0);
	startSoftwareUpdate();
	await h.check();
	await h.restarted();
	// Then only the next conclusive check may withdraw the notice.
	expect(getUpdateState()).toEqual({ kind: "success" });
	expect(replayedRemovalFrames(true)).toEqual([]);
	expect(
		getPersistentNotifications(true).show.map(({ name }) => name),
	).toContain(NOTICE);
});
