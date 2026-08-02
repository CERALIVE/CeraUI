/*
    CeraUI - web UI for the CERALIVE project
    Copyright (C) 2024-2025 CeraLive project


    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { execPNR } from "../../helpers/exec.ts";
import { invariant } from "../../helpers/invariant.ts";
import { logger } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import { getms, oneHour, oneMinute } from "../../helpers/time.ts";
import { isDevelopment } from "../../mocks/mock-config.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { queueUpdateGw } from "../network/gateways.ts";
import { setup } from "../setup.ts";
import { notePlannedShutdown } from "../streaming/armed-stream-marker.ts";
import { getIsStreaming } from "../streaming/streaming.ts";
import {
	notificationBroadcast,
	notificationRemove,
} from "../ui/notifications.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
/* Software updates */
import { APT_PACKAGE_NAME_RE } from "./apt-package-name.ts";
import {
	logParseError,
	type ParseResult,
	parseFail,
	parseOk,
} from "./cli-parse.ts";
import {
	deriveUpdateIdentity,
	deriveUpdateState,
	type UpdateCheckFailureReason,
	type UpdateFailure,
	type UpdateIdentity,
	type UpdateState,
	updateDismissalKey,
} from "./update-state.ts";

let availableUpdates:
	| {
			package_count: number;
			download_size?: string;
	  }
	| null
	| false = aptUpdatesEnabled() ? null : false;
type SoftUpdateStatus = {
	total: number;
	downloading: number;
	unpacking: number;
	setting_up: number;
	result?: string | 0;
};
let softUpdateStatus: SoftUpdateStatus | null = null;
let aptGetUpdating = false;
let aptGetUpdateFailures = 0;
let aptHeldBackPackages: string | undefined;

// Unified-update-state signals (Todo 24). The identity of the currently-available
// update; the identity being installed; and the terminal outcome of the last run.
// A terminal failure/success PERSISTS across background discovery re-runs — only a
// new install (startSoftwareUpdate) or a manual re-check clears it.
let availableIdentity: UpdateIdentity | null = null;
let currentUpdateIdentity: UpdateIdentity | null = null;
let lastUpdateFailure: UpdateFailure | null = null;
let lastUpdateSucceeded = false;

// Check-cycle outcome, separate from the install-cycle signals above. A check
// that could not complete MUST NOT read as "up to date", and a check that
// completed with nothing to do must still leave proof it ran — otherwise the
// operator's only evidence is a button that appears to do nothing (the live
// Rock 5B+ report this fixes: apt-get update ran and succeeded in 1.8 s while the
// dialog showed no spinner, no result and no error for 11 s).
let lastCheckFailure: UpdateCheckFailureReason | null = null;
let lastCheckedAt: number | null = null;

function failCurrentCheck(reason: UpdateCheckFailureReason): void {
	lastCheckFailure = reason;
}

// Why an update start was refused. A refusal is ALWAYS one of these — never a
// bare `return` — so the operator gets a reason instead of a dialog that shows
// "Applying…" and reverts in silence (the live Rock 5B+ report this fixes).
export type UpdateStartRefusal =
	| "updates_disabled"
	| "streaming"
	| "already_updating"
	| "check_unavailable";

export type UpdateStartOutcome =
	| { started: true }
	| { started: false; reason: UpdateStartRefusal };

function refuseUpdateStart(reason: UpdateStartRefusal): UpdateStartOutcome {
	logger.warn(`Software update refused: ${reason}`);
	return { started: false, reason };
}

// The ONE predicate for "may this device install apt updates". Discovery, the
// periodic check, and the install path all read it, so the UI can never offer an
// update the install path would refuse.
export function aptUpdatesEnabled(): boolean {
	return setup.apt_update_enabled !== false;
}

export function getAvailableUpdates() {
	return availableUpdates;
}

export function getSoftUpdateStatus() {
	return softUpdateStatus;
}

export function isUpdating() {
	return softUpdateStatus != null;
}

// Test seam, mirroring the reset*Runner seams below: drops the in-flight latch
// and the last terminal outcome so a suite that leaves an update mid-flight
// cannot refuse the next test's start with `already_updating`.
export function resetSoftwareUpdateState(): void {
	softUpdateStatus = null;
	currentUpdateIdentity = null;
	lastUpdateFailure = null;
	lastUpdateSucceeded = false;
	lastCheckFailure = null;
	lastCheckedAt = null;
}

export function getUpdateState(): UpdateState {
	const available =
		availableUpdates === false
			? false
			: availableUpdates && availableIdentity
				? {
						identity: availableIdentity,
						package_count: availableUpdates.package_count,
						...(availableUpdates.download_size !== undefined
							? { download_size: availableUpdates.download_size }
							: {}),
					}
				: null;
	return deriveUpdateState({
		checking: aptGetUpdating,
		available,
		updating:
			softUpdateStatus && softUpdateStatus.result === undefined
				? softUpdateStatus
				: null,
		failure: lastUpdateFailure,
		succeeded: lastUpdateSucceeded,
		checkFailure: lastCheckFailure,
		checkedAt: lastCheckedAt,
	});
}

function broadcastUpdateState() {
	broadcastMsg("status", { update_state: getUpdateState() });
}

// Auto-reboot runner DI seam: default runs the real argv-only run(); tests spy it.
type RebootRunner = (bin: string, args: string[]) => void;

const defaultRebootRunner: RebootRunner = (bin, args) => {
	void run(bin, args);
};

let rebootRunner: RebootRunner = defaultRebootRunner;

export function setRebootRunner(runner: RebootRunner): void {
	rebootRunner = runner;
}

export function resetRebootRunner(): void {
	rebootRunner = defaultRebootRunner;
}

// Gate on isDevelopment() so a dev host is never rebooted after an update.
export function rebootAfterUpdate(): void {
	if (!isDevelopment()) {
		rebootRunner("reboot", []);
	}
}

export type AptUpgradeSummary = {
	readonly upgradeCount: number;
	readonly downloadSize?: string;
	readonly ceralivePackages: boolean;
	readonly packages: string[];
};

export function parseUpgradePackageCount(text: string): ParseResult<number> {
	const upgradedCount = text.match(/(\d+) upgraded/)?.[1];
	const newlyInstalledCount = text.match(/, (\d+) newly installed/)?.[1];
	if (upgradedCount === undefined || newlyInstalledCount === undefined) {
		return parseFail(
			"parseAptUpgradeSummary",
			"missing upgraded/newly installed counts",
			text,
		);
	}

	return parseOk(
		Number.parseInt(upgradedCount, 10) +
			Number.parseInt(newlyInstalledCount, 10),
	);
}

export function parseUpgradeDownloadSize(text: string): ParseResult<string> {
	const value = text
		.split("Need to get ")[1]
		?.split(/\/|( of archives)/)[0]
		?.trim();
	if (value === undefined || value.length === 0) {
		return parseFail(
			"parseAptUpgradeSummary",
			"missing Need to get download-size line",
			text,
		);
	}
	return parseOk(value);
}

// Show an update notification if there are pending updates to packages matching this list
const ceralivePackageList = [
	"ceralive",
	"cerastream",
	"ceraui",
	"srtla",
	"usb-modeswitch-data",
	"l4t",
];
// Reboot instead of just restarting CeraUI if we've updated packages matching this list
const rebootPackageList = ["l4t", "ceralive-linux-", "ceralive-network-config"];

export function parseHeldBackPackages(packages: string): string[] {
	const names = packages
		.trim()
		.split(/\s+/)
		.filter((n) => n.length > 0);
	for (const name of names) {
		invariant(
			APT_PACKAGE_NAME_RE.test(name),
			`invalid package name in held-back list: ${name}`,
		);
	}
	return names;
}

export function buildAptInstallArgs(packages: string[]): string[] {
	return ["install", "--assume-no", ...packages];
}

export function buildAptUpgradeArgs(heldBackPackages?: string[]): string[] {
	const base = [
		"-y",
		"-o",
		"Dpkg::Options::=--force-confdef",
		"-o",
		"Dpkg::Options::=--force-confold",
	];
	if (heldBackPackages && heldBackPackages.length > 0) {
		return [...base, "install", ...heldBackPackages];
	}
	return [...base, "dist-upgrade"];
}

async function aptAssumeNoInstall(packages: string[]): Promise<string> {
	try {
		return await run("apt-get", buildAptInstallArgs(packages));
	} catch (err) {
		// --assume-no aborts non-zero whenever changes would be made, so run()
		// rejects; the summary we parse is still on the rejection's stdout.
		const e = err as { stdout?: unknown };
		return typeof e.stdout === "string" ? e.stdout : "";
	}
}

function packageListIncludes(list: string, includes: Array<string>) {
	for (const p of includes) {
		if (list.includes(p)) return true;
	}
	return false;
}

export function parseAptPackageList(
	stdout: string,
	heading: string,
): ParseResult<string | undefined> {
	const section = stdout
		.split(heading)[1]
		?.split(/\n\w+/)[0]
		?.replace(/[\n ]+/g, " ")
		?.trim();
	return parseOk(section && section.length > 0 ? section : undefined);
}

function parseAptUpgradedPackages(stdout: string) {
	return parseAptPackageList(
		stdout,
		"The following packages will be upgraded:\n",
	);
}

export function parseAptUpgradeSummary(
	stdout: string,
): ParseResult<AptUpgradeSummary> {
	const upgradeCount = parseUpgradePackageCount(stdout);
	if (!upgradeCount.ok) return upgradeCount;
	if (upgradeCount.value === 0) {
		return parseOk({ upgradeCount: 0, ceralivePackages: false, packages: [] });
	}

	const downloadSize = parseUpgradeDownloadSize(stdout);
	if (!downloadSize.ok) return downloadSize;

	const packageList = parseAptUpgradedPackages(stdout);
	if (!packageList.ok) return packageList;
	if (packageList.value === undefined) {
		return parseFail(
			"parseAptUpgradeSummary",
			"missing upgraded package list",
			stdout,
		);
	}

	return parseOk({
		upgradeCount: upgradeCount.value,
		downloadSize: downloadSize.value,
		ceralivePackages: packageListIncludes(
			packageList.value,
			ceralivePackageList,
		),
		packages: packageList.value.split(/\s+/).filter((n) => n.length > 0),
	});
}

// `apt-get dist-upgrade --assume-no` exits non-zero by design (it answers "no"),
// so a non-zero code alone is not a failure — but a non-zero code WITH no stdout
// means apt itself could not run (lock held, no network, missing binary). That is
// operator-relevant: silently reporting "0 updates" would hide a broken updater.
export function reportUpdateCheckFailure(upgrade: {
	code: number;
	stdout: string;
	stderr: string;
}): boolean {
	if (upgrade.code !== 0 && upgrade.stdout.trim() === "") {
		logger.error(
			`Software update check failed: apt-get dist-upgrade exited ${upgrade.code}`,
			{ stderr: upgrade.stderr },
		);
		notificationBroadcast(
			"software_update_check_failed",
			"warning",
			"Couldn't check for software updates. The device will retry automatically.",
			60,
			false,
			true,
		);
		return true;
	}
	notificationRemove("software_update_check_failed");
	return false;
}

async function getSoftwareUpdateSize() {
	// Never advertise an update the install path would refuse to run.
	if (!aptUpdatesEnabled()) return null;
	if (getIsStreaming() || isUpdating() || aptGetUpdating) return "busy";

	// First see if any packages can be upgraded by dist-upgrade
	const upgrade = await execPNR("apt-get dist-upgrade --assume-no");
	if (reportUpdateCheckFailure(upgrade)) {
		failCurrentCheck("discovery_failed");
		return null;
	}
	let parsedSummary = parseAptUpgradeSummary(upgrade.stdout);
	if (!parsedSummary.ok) {
		logParseError(parsedSummary);
		failCurrentCheck("discovery_failed");
		return null;
	}
	let res = parsedSummary.value;

	// Otherwise, check if any packages have been held back (e.g. by dependencies changing)
	if (res.upgradeCount === 0) {
		const heldBackPackages = parseAptPackageList(
			upgrade.stdout,
			"The following packages have been kept back:\n",
		);
		if (!heldBackPackages.ok) {
			logParseError(heldBackPackages);
			failCurrentCheck("discovery_failed");
			return null;
		}
		aptHeldBackPackages = heldBackPackages.value;
		if (aptHeldBackPackages) {
			const stdout = await aptAssumeNoInstall(
				parseHeldBackPackages(aptHeldBackPackages),
			);
			parsedSummary = parseAptUpgradeSummary(stdout);
			if (!parsedSummary.ok) {
				logParseError(parsedSummary);
				failCurrentCheck("discovery_failed");
				return null;
			}
			res = parsedSummary.value;
		}
	} else {
		// Reset aptHeldBackPackages if some upgrades became available via dist-upgrade
		aptHeldBackPackages = undefined;
	}

	availableIdentity =
		res.upgradeCount > 0
			? deriveUpdateIdentity(res.packages, res.upgradeCount, res.downloadSize)
			: null;

	if (res.ceralivePackages && availableIdentity) {
		notificationBroadcast(
			"ceralive_update",
			"warning",
			"A CERALIVE update is available. Open Settings → Software Updates to install it.",
			0,
			true,
			true,
			true,
			"notifications.ceraliveUpdateAvailable",
			undefined,
			{
				action: {
					schema: 1,
					kind: "navigate",
					target: "updates-dialog",
					labelKey: "notifications.openUpdates",
				},
				dismissalKey: updateDismissalKey(availableIdentity),
			},
		);
	}

	availableUpdates = {
		package_count: res.upgradeCount,
		...(res.downloadSize !== undefined
			? { download_size: res.downloadSize }
			: {}),
	};
	broadcastMsg("status", {
		available_updates: availableUpdates,
		update_state: getUpdateState(),
	});

	return null;
}

// Node's ExecException, reproduced structurally so callers keep the same
// error-classification surface (code/stdout/stderr) without the Node import.
type ExecException = Error & {
	code?: number;
	stdout?: string;
	stderr?: string;
};

type SoftwareUpdateError = ExecException | "busy" | true | null;

/**
 * Classify the outcome of `apt-get update` into the legacy `errOrStderr` value.
 *
 * Preserves the exact pre-migration semantics of the `exec()` callback:
 *   - any stderr output ⇒ `true` (treated as an error, even on exit 0);
 *   - otherwise a non-zero exit ⇒ an ExecException-shaped error;
 *   - otherwise (exit 0, no stderr) ⇒ `null` (success).
 */
export function classifyAptUpdateResult(
	exitCode: number,
	stderr: string,
): SoftwareUpdateError {
	if (stderr.length) return true;
	if (exitCode !== 0) {
		const err = new Error(
			`apt-get update exited with code ${exitCode}`,
		) as ExecException;
		err.code = exitCode;
		return err;
	}
	return null;
}

// Returns false when skipped (streaming/updating/apt busy) so the periodic
// caller can still reschedule — a skipped check never runs its callback.
function checkForSoftwareUpdates(
	callback: (err: SoftwareUpdateError, aptGetUpdateFailures: number) => unknown,
): boolean {
	if (!aptUpdatesEnabled()) return false;
	if (getIsStreaming() || isUpdating() || aptGetUpdating) return false;

	// A fresh cycle supersedes the previous one's verdict, and the `checking`
	// transition is BROADCAST: it is derivable server-side the moment this flag
	// flips, but nothing published it, so no client could ever observe a check in
	// flight and the dialog cancelled its own spinner on the next frame.
	lastCheckFailure = null;
	aptGetUpdating = true;
	broadcastUpdateState();

	void (async () => {
		const res = await Bun.$`apt-get update --allow-releaseinfo-change`
			.nothrow()
			.quiet();
		const stdout = res.stdout.toString();
		const stderr = res.stderr.toString();

		aptGetUpdating = false;

		// The operator-visible verdict keys on the EXIT CODE, never on stderr:
		// apt writes benign warnings there on a perfectly good refresh, and
		// classifyAptUpdateResult's stderr rule (kept for the retry cadence) would
		// turn every one of those into a false alarm.
		if (res.exitCode !== 0) failCurrentCheck("refresh_failed");

		const errOrStderr = classifyAptUpdateResult(res.exitCode, stderr);

		if (stderr.length) {
			aptGetUpdateFailures++;
			queueUpdateGw();
		} else {
			aptGetUpdateFailures = 0;
		}

		logger.info(
			`apt-get update: ${errOrStderr === null ? "success" : "error"}`,
		);
		if (stdout) logger.info(stdout);
		if (stderr) logger.error(stderr);

		if (callback) callback(errOrStderr, aptGetUpdateFailures);
	})();
	return true;
}

// 10 SECONDS, not a bare `10` (10ms) which hammered apt every 10ms.
export const RETRY_DELAY_SHORT_MS = 10 * 1000;
export const RETRY_FAILURE_THRESHOLD = 12;
export const SKIP_RETRY_DELAY_MS = oneMinute;

export function computeNextCheckDelay(
	err: SoftwareUpdateError,
	failures: number,
): number {
	if (err === null) return oneHour;
	if (failures < RETRY_FAILURE_THRESHOLD) return RETRY_DELAY_SHORT_MS;
	return oneMinute;
}

type SoftwareUpdateCheckRunner = (
	callback: (err: SoftwareUpdateError, failures: number) => unknown,
) => boolean;

let softwareUpdateCheckRunner: SoftwareUpdateCheckRunner =
	checkForSoftwareUpdates;

export function setSoftwareUpdateCheckRunner(
	runner: SoftwareUpdateCheckRunner,
): void {
	softwareUpdateCheckRunner = runner;
}

export function resetSoftwareUpdateCheckRunner(): void {
	softwareUpdateCheckRunner = checkForSoftwareUpdates;
}

// Discovery DI seam wrapping getSoftwareUpdateSize (the SOLE `available_updates`
// broadcaster). Callers invoke it unconditionally: a noisy-but-nonfatal `apt-get update`
// (benign apt warnings on stderr, or one repo down) must not suppress the broadcast, and
// getSoftwareUpdateSize still surfaces a truly-broken apt via reportUpdateCheckFailure.
type SoftwareUpdateSizeRunner = () => Promise<SoftwareUpdateError>;

let softwareUpdateSizeRunner: SoftwareUpdateSizeRunner = getSoftwareUpdateSize;

export function setSoftwareUpdateSizeRunner(
	runner: SoftwareUpdateSizeRunner,
): void {
	softwareUpdateSizeRunner = runner;
}

export function resetSoftwareUpdateSizeRunner(): void {
	softwareUpdateSizeRunner = getSoftwareUpdateSize;
}

// The ONE place a check cycle lands, for both the periodic loop and the manual
// re-check. It stamps the attempt before discovery (so the discovery broadcast
// already carries it) and always emits a terminal frame — discovery has several
// early returns that broadcast nothing, and each of those used to leave the
// operator on whatever the dialog happened to be showing.
async function runUpdateDiscoveryAndReport(): Promise<SoftwareUpdateError> {
	lastCheckedAt = Date.now();
	const discovery = await softwareUpdateSizeRunner();
	broadcastUpdateState();
	return discovery;
}

let nextCheckForSoftwareUpdates = getms();
let nextCheckForSoftwareUpdatesTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleNextSoftwareUpdateCheck(delay: number): void {
	nextCheckForSoftwareUpdates = getms() + delay;
	nextCheckForSoftwareUpdatesTimer = setTimeout(
		periodicCheckForSoftwareUpdates,
		delay,
	);
}

export function periodicCheckForSoftwareUpdates() {
	if (!aptUpdatesEnabled()) return;
	// A dev/CI host must never be handed to apt. The manual check has its own
	// mock branch; this background loop simply does not run there.
	if (shouldUseMocks()) return;
	if (nextCheckForSoftwareUpdatesTimer) {
		clearTimeout(nextCheckForSoftwareUpdatesTimer);
		nextCheckForSoftwareUpdatesTimer = undefined;
	}

	const ms = getms();
	if (ms < nextCheckForSoftwareUpdates) {
		nextCheckForSoftwareUpdatesTimer = setTimeout(
			periodicCheckForSoftwareUpdates,
			nextCheckForSoftwareUpdates - ms,
		);
		return;
	}

	const started = softwareUpdateCheckRunner(async (err_, failures) => {
		// Discovery runs on every completed check; err_/failures drive ONLY the retry
		// cadence, so a failed apt-get update refresh retries sooner without ever
		// suppressing the available_updates broadcast.
		const discovery = await runUpdateDiscoveryAndReport();
		const err = err_ === null ? discovery : err_;
		scheduleNextSoftwareUpdateCheck(computeNextCheckDelay(err, failures));
	});

	// Skip path runs no callback; reschedule here so the loop survives a
	// stream/update window instead of dying until the next backend restart.
	if (!started) {
		scheduleNextSoftwareUpdateCheck(SKIP_RETRY_DELAY_MS);
	}
}

// Reuses the periodic discovery + skip guard but never touches its timer.
// Returns false when skipped (streaming/updating/apt busy).
export function triggerManualUpdateCheck(): boolean {
	if (shouldUseMocks()) {
		if (getIsStreaming() || isUpdating() || aptGetUpdating) return false;
		lastUpdateFailure = null;
		lastUpdateSucceeded = false;
		lastCheckFailure = null;
		lastCheckedAt = Date.now();
		availableUpdates = { package_count: 0 };
		availableIdentity = null;
		broadcastMsg("status", {
			available_updates: availableUpdates,
			update_state: getUpdateState(),
		});
		return true;
	}

	// A manual re-check supersedes a prior terminal outcome (Todo 24) — the
	// dialog's retry affordance routes here to re-enter `checking`. The clear has
	// to happen BEFORE dispatch (the runner broadcasts `checking` from inside) yet
	// must not survive a REFUSED check: that wiped the failed-install state the
	// operator was reading and broadcast nothing in its place, leaving the dialog
	// rendering a state the device no longer held.
	const priorFailure = lastUpdateFailure;
	const priorSucceeded = lastUpdateSucceeded;
	lastUpdateFailure = null;
	lastUpdateSucceeded = false;

	const started = softwareUpdateCheckRunner(async () => {
		await runUpdateDiscoveryAndReport();
	});
	if (!started) {
		lastUpdateFailure = priorFailure;
		lastUpdateSucceeded = priorSucceeded;
	}
	return started;
}

// apt spawn seam (T8): the default kicks off the real `apt-get update` →
// dist-upgrade pipeline. The dev/mock path NEVER calls it (it simulates the
// progress sequence instead); tests spy it to assert the real path fired (prod)
// or stayed untouched (dev). This is SEPARATE from the rebootRunner seam above,
// which only gates the post-update reboot — this gates the entire apt spawn.
// The runner reports its own outcome: a refusal is only discoverable once the
// apt package-list refresh has been dispatched.
type SoftwareUpdateRunner = () => UpdateStartOutcome;

const defaultSoftwareUpdateRunner: SoftwareUpdateRunner = () => {
	const checkStarted = softwareUpdateCheckRunner((err) => {
		if (err === null) {
			doSoftwareUpdate();
		} else if (softUpdateStatus) {
			const reason =
				"Failed to fetch the updated package list; aborting the update.";
			lastUpdateSucceeded = false;
			lastUpdateFailure = {
				reason,
				...((currentUpdateIdentity ?? availableIdentity)
					? {
							identity: (currentUpdateIdentity ??
								availableIdentity) as UpdateIdentity,
						}
					: {}),
			};
			notificationBroadcast(
				"ceralive_update_failed",
				"error",
				"The software update failed. Open Settings → Software Updates to see the reason and retry.",
				0,
				true,
				true,
				true,
				"notifications.ceraliveUpdateFailed",
				undefined,
				{
					action: {
						schema: 1,
						kind: "navigate",
						target: "updates-dialog",
						labelKey: "notifications.openUpdates",
					},
				},
			);
			softUpdateStatus.result = reason;
			broadcastMsg("status", {
				updating: softUpdateStatus,
				update_state: getUpdateState(),
			});
			softUpdateStatus = null;
			broadcastUpdateState();
		}
	});

	// The callback above is the ONLY thing that ever clears softUpdateStatus, so
	// latching it after a check that declined to run would leave isUpdating()
	// true for the lifetime of the process — refusing every later update and
	// silently killing the periodic check loop with it.
	if (!checkStarted) return refuseUpdateStart("check_unavailable");

	softUpdateStatus = { downloading: 0, unpacking: 0, setting_up: 0, total: 0 };
	broadcastMsg("status", {
		updating: softUpdateStatus,
		update_state: getUpdateState(),
	});
	return { started: true };
};

let softwareUpdateRunner: SoftwareUpdateRunner = defaultSoftwareUpdateRunner;

export function setSoftwareUpdateRunner(runner: SoftwareUpdateRunner): void {
	softwareUpdateRunner = runner;
}

export function resetSoftwareUpdateRunner(): void {
	softwareUpdateRunner = defaultSoftwareUpdateRunner;
}

const MOCK_UPDATE_STEP_DELAY_MS = 120;
const MOCK_UPDATE_TOTAL = 4;

let mockSoftwareUpdatePromise: Promise<void> | null = null;

export function getMockSoftwareUpdatePromise(): Promise<void> | null {
	return mockSoftwareUpdatePromise;
}

// Emulate the on-device update progression WITHOUT spawning apt: total resolves,
// then downloading, unpacking and setting_up each fill to total in turn, and
// finally a completion frame (result: 0) — the same wire shape doSoftwareUpdate
// produces from real apt stdout.
async function simulateMockSoftwareUpdate(): Promise<void> {
	softUpdateStatus = { total: 0, downloading: 0, unpacking: 0, setting_up: 0 };
	broadcastMsg("status", { updating: softUpdateStatus });

	const steps: Array<Partial<SoftUpdateStatus>> = [
		{ total: MOCK_UPDATE_TOTAL },
		{ downloading: MOCK_UPDATE_TOTAL },
		{ unpacking: MOCK_UPDATE_TOTAL },
		{ setting_up: MOCK_UPDATE_TOTAL },
	];

	for (const step of steps) {
		await Bun.sleep(MOCK_UPDATE_STEP_DELAY_MS);
		if (!softUpdateStatus) return;
		softUpdateStatus = { ...softUpdateStatus, ...step };
		broadcastMsg("status", { updating: softUpdateStatus });
	}

	await Bun.sleep(MOCK_UPDATE_STEP_DELAY_MS);
	if (!softUpdateStatus) return;
	softUpdateStatus = { ...softUpdateStatus, result: 0 };
	lastUpdateSucceeded = true;
	lastUpdateFailure = null;
	broadcastMsg("status", {
		updating: softUpdateStatus,
		update_state: getUpdateState(),
	});
	softUpdateStatus = null;
	broadcastUpdateState();
}

export function startSoftwareUpdate(): UpdateStartOutcome {
	if (!aptUpdatesEnabled()) return refuseUpdateStart("updates_disabled");
	if (getIsStreaming()) return refuseUpdateStart("streaming");
	if (isUpdating()) return refuseUpdateStart("already_updating");

	// An update restarts `ceralive` (and usually reboots) WITHOUT changing the
	// boot id, so a stream armed before an engine crash earlier in this same boot
	// would otherwise be restored by the post-update backend. Suppress it here,
	// where the update is known to be going ahead.
	notePlannedShutdown("software_update");

	// A fresh install supersedes any prior terminal outcome (Todo 24).
	currentUpdateIdentity = availableIdentity;
	lastUpdateFailure = null;
	lastUpdateSucceeded = false;

	// if an apt-get update is already in progress, retry later
	if (aptGetUpdating) {
		setTimeout(startSoftwareUpdate, 3 * 1000);
		return { started: true };
	}

	// Dev/mock seam: simulate the progress→complete sequence without ever
	// spawning apt, so the update UI is exercisable on a dev box.
	if (shouldUseMocks()) {
		mockSoftwareUpdatePromise = simulateMockSoftwareUpdate();
		void mockSoftwareUpdatePromise;
		return { started: true };
	}

	return softwareUpdateRunner();
}

function doSoftwareUpdate() {
	if (!aptUpdatesEnabled() || getIsStreaming()) return;

	let rebootAfterUpgrade = false;
	let aptLog = "";
	let aptErr = "";

	const heldBack = aptHeldBackPackages
		? parseHeldBackPackages(aptHeldBackPackages)
		: undefined;
	const aptUpgrade = Bun.spawn(["apt-get", ...buildAptUpgradeArgs(heldBack)], {
		stdout: "pipe",
		stderr: "pipe",
	});

	const handleStdoutChunk = (data: string) => {
		let sendUpdate = false;

		aptLog += data;

		if (!softUpdateStatus) return;

		if (softUpdateStatus.total === 0) {
			const count = parseUpgradePackageCount(aptLog);
			if (count.ok) {
				softUpdateStatus.total = count.value;
				sendUpdate = true;

				const packageList = parseAptUpgradedPackages(aptLog);
				if (
					packageList.ok &&
					packageList.value !== undefined &&
					packageListIncludes(packageList.value, rebootPackageList)
				) {
					rebootAfterUpgrade = true;
				}
			} else if (aptLog.includes(" upgraded")) {
				logParseError(count);
			}
		}

		if (softUpdateStatus.downloading !== softUpdateStatus.total) {
			const getMatch = data.match(/Get:(\d+)/);
			if (getMatch) {
				const i = Number.parseInt(getMatch[1] ?? "", 10);
				if (i > softUpdateStatus.downloading) {
					softUpdateStatus.downloading = Math.min(i, softUpdateStatus.total);
					sendUpdate = true;
				}
			}
		}

		const unpacking = data.match(/Unpacking /g);
		if (unpacking) {
			softUpdateStatus.downloading = softUpdateStatus.total;
			softUpdateStatus.unpacking += unpacking.length;
			softUpdateStatus.unpacking = Math.min(
				softUpdateStatus.unpacking,
				softUpdateStatus.total,
			);
			sendUpdate = true;
		}

		const setting_up = data.match(/Setting up /g);
		if (setting_up) {
			softUpdateStatus.setting_up += setting_up.length;
			softUpdateStatus.setting_up = Math.min(
				softUpdateStatus.setting_up,
				softUpdateStatus.total,
			);
			sendUpdate = true;
		}

		if (sendUpdate) {
			broadcastMsg("status", { updating: softUpdateStatus });
		}
	};

	void (async () => {
		const stdoutDecoder = new TextDecoder();
		const drainStdout = (async () => {
			for await (const chunk of aptUpgrade.stdout as ReadableStream<Uint8Array>) {
				handleStdoutChunk(stdoutDecoder.decode(chunk, { stream: true }));
			}
		})();

		const stderrDecoder = new TextDecoder();
		const drainStderr = (async () => {
			for await (const chunk of aptUpgrade.stderr as ReadableStream<Uint8Array>) {
				aptErr += stderrDecoder.decode(chunk, { stream: true });
			}
		})();

		const [, , code] = await Promise.all([
			drainStdout,
			drainStderr,
			aptUpgrade.exited,
		]);

		if (softUpdateStatus) {
			if (code === 0) {
				lastUpdateSucceeded = true;
				lastUpdateFailure = null;
			} else {
				lastUpdateSucceeded = false;
				lastUpdateFailure = {
					reason: aptErr.trim() || `apt-get exited with code ${code}`,
					...((currentUpdateIdentity ?? availableIdentity)
						? {
								identity: (currentUpdateIdentity ??
									availableIdentity) as UpdateIdentity,
							}
						: {}),
				};
				notificationBroadcast(
					"ceralive_update_failed",
					"error",
					"The software update failed. Open Settings → Software Updates to see the reason and retry.",
					0,
					true,
					true,
					true,
					"notifications.ceraliveUpdateFailed",
					undefined,
					{
						action: {
							schema: 1,
							kind: "navigate",
							target: "updates-dialog",
							labelKey: "notifications.openUpdates",
						},
					},
				);
			}
			softUpdateStatus.result = code === 0 ? code : aptErr;
			broadcastMsg("status", {
				updating: softUpdateStatus,
				update_state: getUpdateState(),
			});
			softUpdateStatus = null;
			broadcastUpdateState();
		}

		if (aptLog) logger.info(aptLog);
		if (aptErr) logger.error(aptErr);

		if (code === 0) {
			if (rebootAfterUpgrade) {
				rebootAfterUpdate();
			} else {
				invariant(false, "software update complete; exiting to restart CeraUI");
			}
		}
	})();
}
