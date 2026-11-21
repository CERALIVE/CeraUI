/*
 * The "A CeraLive update is available" notice (`ceralive_update`) used to be
 * raised by both discovery paths and never withdrawn: after a Rock was updated to
 * the candidate, an already-open tab kept the banner forever. These tests drive
 * the real check entry point (refresh + discovery) over fake APT output and pin
 * when the notice may change: only a conclusive check, keyed by the exact
 * first-party versions the Install control would take.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notificationsMessageSchema } from "@ceraui/rpc/schemas";

import { setup } from "../modules/setup.ts";
import {
	getUpdateState,
	resetAptReachabilityProbeForTest,
	resetSoftwareUpdateState,
	runSoftwareUpdateCheck,
	setAptCommandRunnerForTest,
	setAptReachabilityProbeForTest,
	startSoftwareUpdate,
} from "../modules/system/software-updates.ts";
import { setCeraliveSourcesFileForTest } from "../modules/system/update-apt-channel.ts";
import { setUpdateCapabilityPathForTest } from "../modules/system/update-capabilities.ts";
import { setUpdateSettingsFilePathForTest } from "../modules/system/update-settings.ts";
import {
	recordNotificationDismissal,
	resetDismissalStoreForTests,
} from "../modules/ui/notification-dismissals.ts";
import {
	getPersistentNotifications,
	notificationBroadcast,
	notificationDismiss,
	notificationExists,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import * as websocket from "../modules/ui/websocket-server.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

useSessionOwnerForFile();

const NOTICE = "ceralive_update";
const OS_OFFER = "update:updates-available:os:2026.12.0";
const KERNEL = "update:kernel-staged:7.2.1";

type Policy = { readonly installed: string; readonly candidate: string };
type Fixture = {
	refresh: { exitCode: number; stdout: string; stderr: string };
	plan: string;
	keptBackPlan: string;
	policy: Record<string, Policy>;
	simulation: string;
	capablePolicy: Record<string, string>;
};

const NOTHING =
	"0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n";

function legacyPlan(names: readonly string[], size = "4 kB"): string {
	return `The following packages will be upgraded:\n  ${names.join(" ")}\n${names.length} upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\nNeed to get ${size} of archives.\n`;
}

function legacyPolicy(name: string, { installed, candidate }: Policy): string {
	return `${name}:\n  Installed: ${installed}\n  Candidate: ${candidate}\n  Version table:\n     ${candidate} 500\n        500 https://apt.ceralive.tv/dists/stable/binary-arm64 ./ Packages\n *** ${installed} 100\n        100 /var/lib/dpkg/status\n`;
}

const CERALIVE_SOURCE =
	"https://apt.ceralive.tv/dists/stable/binary-arm64 ./ Packages";
const DEBIAN_SOURCE =
	"https://deb.debian.org/debian-security trixie-security/main arm64 Packages";
const INVENTORY = `Package files:
 100 /var/lib/dpkg/status
     release a=now
 500 ${DEBIAN_SOURCE}
     release v=13,o=Debian,a=stable-security,n=trixie-security,l=Debian-Security,c=main,b=arm64
     origin deb.debian.org
 500 ${CERALIVE_SOURCE}
     release o=CeraLive,a=stable,n=stable,l=CeraLive,c=
     origin apt.ceralive.tv
Pinned packages:
`;

function capablePolicy(
	name: string,
	installed: string,
	candidate: string,
	source: string,
	listed = candidate,
): string {
	return `${name}:\n  Installed: ${installed}\n  Candidate: ${candidate}\n  Version table:\n     ${listed} 990\n        990 ${source}\n *** ${installed} 100\n        100 /var/lib/dpkg/status\n`;
}

function inst(name: string, installed: string, candidate: string): string {
	return `Inst ${name} [${installed}] (${candidate} stable [arm64])\nConf ${name} (${candidate} stable [arm64])\n`;
}

let dir: string;
let fixture: Fixture;
let broadcast: ReturnType<typeof spyOn<typeof websocket, "broadcastMsg">>;
let priorEnabled: boolean | undefined;
let priorDismissals: string | undefined;

function empty(): Fixture {
	return {
		refresh: { exitCode: 0, stdout: "", stderr: "" },
		plan: NOTHING,
		keptBackPlan: NOTHING,
		policy: {},
		simulation: NOTHING,
		capablePolicy: {},
	};
}

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

function replay() {
	return notificationsMessageSchema.parse(getPersistentNotifications(true));
}

function liveRemovals(): string[] {
	return broadcast.mock.calls.flatMap(([type, frame]) =>
		type === "notification"
			? (notificationsMessageSchema
					.parse(frame)
					.remove?.map(({ id }) => id)
					.filter((id) => [NOTICE, OS_OFFER, KERNEL].includes(id)) ?? [])
			: [],
	);
}

function standing(name: string): void {
	notificationBroadcast(name, "info", name, 0, true, true, true, name);
}

async function check(next: Partial<Fixture>): Promise<void> {
	fixture = { ...empty(), ...next };
	broadcast.mockClear();
	expect(await runSoftwareUpdateCheck()).toBeNull();
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ceralive-update-notice-"));
	priorDismissals = process.env.CERALIVE_DISMISSALS_FILE;
	process.env.CERALIVE_DISMISSALS_FILE = join(dir, "dismissals.json");
	resetDismissalStoreForTests();
	priorEnabled = setup.apt_update_enabled;
	setup.apt_update_enabled = true;
	resetSoftwareUpdateState();
	fixture = empty();
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
	setAptCommandRunnerForTest(async (argv) => {
		const [bin, verb, name] = argv;
		if (bin === "/usr/bin/apt-get" && verb === "update") return fixture.refresh;
		if (bin === "/usr/bin/apt-get" && verb === "dist-upgrade")
			return { exitCode: 1, stdout: fixture.plan, stderr: "" };
		if (bin === "/usr/bin/apt-get" && verb === "install")
			return { exitCode: 1, stdout: fixture.keptBackPlan, stderr: "" };
		if (bin === "/usr/bin/apt-get" && verb === "-s")
			return { exitCode: 0, stdout: fixture.simulation, stderr: "" };
		if (bin === "/usr/bin/apt-mark")
			return { exitCode: 0, stdout: "", stderr: "" };
		if (bin === "/usr/bin/apt-cache" && verb === "policy") {
			if (name === undefined)
				return { exitCode: 0, stdout: INVENTORY, stderr: "" };
			const capable = fixture.capablePolicy[name];
			const legacy = fixture.policy[name];
			const stdout =
				capable ?? (legacy ? legacyPolicy(name, legacy) : undefined);
			if (stdout !== undefined) return { exitCode: 0, stdout, stderr: "" };
		}
		throw new Error(`unexpected APT command: ${JSON.stringify(argv)}`);
	});
	broadcast = spyOn(websocket, "broadcastMsg");
});

afterEach(async () => {
	broadcast.mockRestore();
	for (const name of [NOTICE, OS_OFFER, KERNEL]) notificationRemove(name);
	setAptCommandRunnerForTest(null);
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
	test("a conclusive check keys the notice by the exact candidate versions", async () => {
		// When a fresh refresh and discovery find two first-party upgrades.
		await check({
			plan: legacyPlan(["cerastream", "srtla"]),
			policy: {
				srtla: { installed: "1.0", candidate: "1.1" },
				cerastream: { installed: "2026.11.2", candidate: "2026.11.3" },
			},
		});
		// Then the localized, actionable notice carries a version-bearing key.
		expect(notificationExists(NOTICE)).toMatchObject({
			key: "notifications.ceraliveUpdateAvailable",
			action: { kind: "navigate", target: "updates-dialog" },
			dismissalKey: "update:cerastream=2026.11.3,srtla=1.1",
		});
	});

	test("nothing pending after the update withdraws it live and in every later replay, leaving OS and kernel notices", async () => {
		// Given the offer that was installed, plus OS and kernel notices on the same surface.
		standing(OS_OFFER);
		standing(KERNEL);
		await check({
			plan: legacyPlan(["cerastream"]),
			policy: { cerastream: { installed: "1", candidate: "2" } },
		});
		expect(notificationExists(NOTICE)).toBeDefined();
		// When the conclusive check after the update finds nothing pending.
		await check({ plan: NOTHING });
		// Then connected tabs are told, and a tab that reconnects later is told too.
		expect(liveRemovals()).toEqual([NOTICE]);
		expect(replay().remove?.map(({ id }) => id)).toEqual([NOTICE]);
		expect(
			replay()
				.show?.map(({ name }) => name)
				.sort(),
		).toEqual([KERNEL, OS_OFFER].sort());
	});

	test("an independent update left after the install replaces the offer without a withdrawal", async () => {
		await check({
			plan: legacyPlan(["cerastream"]),
			policy: { cerastream: { installed: "1", candidate: "2" } },
		});
		// When the post-restart check finds srtla still pending (cerastream installed).
		await check({
			plan: legacyPlan(["srtla"]),
			policy: { srtla: { installed: "1.0", candidate: "1.1" } },
		});
		// Then the notice stays up for the remaining release.
		expect(liveRemovals()).toEqual([]);
		expect(notificationExists(NOTICE)?.dismissalKey).toBe("update:srtla=1.1");
		expect(replay().remove).toBeUndefined();
	});

	test.each([
		[
			"an exit-zero refresh that kept stale lists",
			{
				exitCode: 0,
				stdout: "Err:1 https://apt.ceralive.tv stable InRelease\n",
				stderr:
					"W: Failed to fetch https://apt.ceralive.tv/dists/stable/InRelease  Temporary failure resolving 'apt.ceralive.tv'\nW: Some index files failed to download. They have been ignored, or old ones used instead.\n",
			},
		],
		[
			"a failed refresh",
			{ exitCode: 100, stdout: "", stderr: "E: Could not get lock\n" },
		],
	])("%s leaves the standing offer untouched", async (_label, refresh) => {
		await check({
			plan: legacyPlan(["cerastream"]),
			policy: { cerastream: { installed: "1", candidate: "2" } },
		});
		// When the next refresh is not conclusive and the lists say nothing is pending.
		fixture = { ...empty(), refresh };
		broadcast.mockClear();
		await runSoftwareUpdateCheck();
		// Then the offer is neither withdrawn nor rekeyed.
		expect(liveRemovals()).toEqual([]);
		expect(notificationExists(NOTICE)?.dismissalKey).toBe(
			"update:cerastream=2",
		);
	});

	test("a candidate policy that disagrees with the plan is not proof either way", async () => {
		// Given no standing offer; when the plan lists cerastream but policy says it is installed.
		await check({
			plan: legacyPlan(["cerastream"]),
			policy: { cerastream: { installed: "2", candidate: "2" } },
		});
		// Then nothing is raised on contradictory evidence.
		expect(notificationExists(NOTICE)).toBeUndefined();
		// And a standing offer survives the same contradiction.
		await check({
			plan: legacyPlan(["cerastream"]),
			policy: { cerastream: { installed: "1", candidate: "2" } },
		});
		await check({
			plan: legacyPlan(["cerastream"]),
			policy: { cerastream: { installed: "3", candidate: "3" } },
		});
		expect(liveRemovals()).toEqual([]);
		expect(notificationExists(NOTICE)?.dismissalKey).toBe(
			"update:cerastream=2",
		);
	});

	test("a kept-back CeraLive package the Install control refuses raises nothing", async () => {
		// When dist-upgrade keeps cerastream back and only its explicit plan upgrades it.
		await check({
			plan: `The following packages have been kept back:\n  cerastream\n${NOTHING}`,
			keptBackPlan: legacyPlan(["cerastream"]),
		});
		// Then the dialog is not actionable, and the notice does not claim it is.
		expect(getUpdateState()).toMatchObject({ actionable_count: 0 });
		expect(notificationExists(NOTICE)).toBeUndefined();
	});

	test("a dismissal hides that exact release only, even at the same download size", async () => {
		await check({
			plan: legacyPlan(["cerastream"], "4 kB"),
			policy: { cerastream: { installed: "1", candidate: "2" } },
		});
		notificationDismiss(NOTICE);
		// When the same release is discovered again, it stays hidden and withdrawn for reconnecting tabs.
		await check({
			plan: legacyPlan(["cerastream"], "4 kB"),
			policy: { cerastream: { installed: "1", candidate: "2" } },
		});
		expect(notificationExists(NOTICE)).toBeUndefined();
		expect(replay().remove?.map(({ id }) => id)).toEqual([NOTICE]);
		// When a new release of the same package with the same size appears.
		await check({
			plan: legacyPlan(["cerastream"], "4 kB"),
			policy: { cerastream: { installed: "1", candidate: "3" } },
		});
		// Then it is offered again.
		expect(notificationExists(NOTICE)?.dismissalKey).toBe(
			"update:cerastream=3",
		);
		expect(replay().remove).toBeUndefined();
	});

	test("a tab that missed a dismissal in another tab drops the notice on reconnect", async () => {
		await check({
			plan: legacyPlan(["cerastream"]),
			policy: { cerastream: { installed: "1", candidate: "2" } },
		});
		// When one tab dismisses it.
		notificationDismiss(NOTICE);
		// Then the replay another tab receives on reconnect carries the removal.
		expect(replay().remove?.map(({ id }) => id)).toEqual([NOTICE]);
	});

	test("a dismissed successor withdraws the predecessor instead of keeping it alive", async () => {
		await check({
			plan: legacyPlan(["cerastream"]),
			policy: { cerastream: { installed: "1", candidate: "2" } },
		});
		// Given the operator already dismissed the next release.
		recordNotificationDismissal("update:cerastream=3");
		// When a conclusive check finds that dismissed release.
		await check({
			plan: legacyPlan(["cerastream"]),
			policy: { cerastream: { installed: "1", candidate: "3" } },
		});
		// Then the older offer leaves every tab.
		expect(liveRemovals()).toEqual([NOTICE]);
		expect(notificationExists(NOTICE)).toBeUndefined();
		expect(replay().remove?.map(({ id }) => id)).toEqual([NOTICE]);
	});
});

describe("capable image", () => {
	beforeEach(useCapableImage);

	test("srtla from the CeraLive origin raises the localized notice keyed by version", async () => {
		await check({
			simulation: inst("srtla", "1.0", "2.0"),
			capablePolicy: {
				srtla: capablePolicy("srtla", "1.0", "2.0", CERALIVE_SOURCE),
			},
		});
		expect(notificationExists(NOTICE)).toMatchObject({
			key: "notifications.ceraliveUpdateAvailable",
			action: { kind: "navigate", target: "updates-dialog" },
			dismissalKey: "update:srtla=2.0",
		});
	});

	test("verified Debian-only upgrades withdraw the CeraLive offer", async () => {
		await check({
			simulation: inst("srtla", "1.0", "2.0"),
			capablePolicy: {
				srtla: capablePolicy("srtla", "1.0", "2.0", CERALIVE_SOURCE),
			},
		});
		// When srtla is installed and only a Debian security update remains.
		await check({
			simulation: inst("curl", "8.1", "8.2"),
			capablePolicy: {
				curl: capablePolicy("curl", "8.1", "8.2", DEBIAN_SOURCE),
			},
		});
		expect(getUpdateState()).toMatchObject({ actionable_count: 1 });
		expect(liveRemovals()).toEqual([NOTICE]);
		expect(replay().remove?.map(({ id }) => id)).toEqual([NOTICE]);
	});

	test("a first-party candidate whose policy disagrees with the simulation leaves the offer untouched", async () => {
		await check({
			simulation: inst("srtla", "1.0", "2.0"),
			capablePolicy: {
				srtla: capablePolicy("srtla", "1.0", "2.0", CERALIVE_SOURCE),
			},
		});
		// When the simulation says 2.1 but the policy candidate is still 2.0.
		await check({
			simulation: inst("srtla", "1.0", "2.1"),
			capablePolicy: {
				srtla: capablePolicy("srtla", "1.0", "2.0", CERALIVE_SOURCE),
			},
		});
		// Then the unverified row is not read as "no offer remains".
		expect(liveRemovals()).toEqual([]);
		expect(notificationExists(NOTICE)?.dismissalKey).toBe("update:srtla=2.0");
	});
});

test("a successful install is not evidence that no offer remains", async () => {
	await check({
		plan: legacyPlan(["cerastream"]),
		policy: { cerastream: { installed: "1", candidate: "2" } },
	});
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
	expect(replay().remove).toBeUndefined();
	expect(replay().show?.map(({ name }) => name)).toContain(NOTICE);
});
