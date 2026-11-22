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

// allow: SIZE_OK — legacy update coordinator owns the shared discovery/install/recovery latches; new admission parsing stays in leaf modules.
import { randomUUID } from "node:crypto";
import {
	type AptReachability as AptReachabilityWire,
	aptReachabilitySchema,
	type UpdatePackage,
	type UpdatePreflightReason,
} from "@ceraui/rpc";
import { holdUpdateProgress } from "@ceraui/rpc/package-progress";
import type { UpdateCapabilities } from "@ceraui/rpc/schemas";
import { invariant } from "../../helpers/invariant.ts";
import { logger } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import {
	type SpawnWithTimeoutResult,
	spawnWithTimeout,
} from "../../helpers/spawn-policy.ts";
import { getms, oneHour, oneMinute } from "../../helpers/time.ts";
import { isDevelopment } from "../../mocks/mock-config.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { updateGwWrapper } from "../network/gateways.ts";
import { setup } from "../setup.ts";
import { notePlannedShutdown } from "../streaming/armed-stream-marker.ts";
import {
	notificationBroadcast,
	notificationRemove,
} from "../ui/notifications.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import {
	AptAllRefusalError,
	assertPinnedInstallSimulation,
	buildAptAllDiscoveryArgs,
	buildAptAllDownloadArgs,
	buildAptAllInstallArgs,
	discoverAptAllPackages,
	type PinnedAptPackage,
} from "./apt-all-packages.ts";
import {
	logAptAllRefusal,
	resetAptAllRefusalLogForTest,
} from "./apt-all-refusal-log.ts";
import { cleanAptCache } from "./apt-cache-clean.ts";
/* Software updates */
import { APT_PACKAGE_NAME_RE } from "./apt-package-name.ts";
import {
	deriveUpdateProgress,
	PHASE_MARKERS,
	type SoftUpdateStatus,
} from "./apt-progress.ts";
import {
	type AptReachability,
	defaultAptReachabilityDeps,
	deriveVerdict,
	probeAptReachability,
} from "./apt-reachability.ts";
import {
	defaultAptSpaceDeps,
	preflightAptSpace,
} from "./apt-space-admission.ts";
import { AptPreflightError } from "./apt-space-parser.ts";
import {
	type AptTransferAdmission,
	captureAptTransferAdmission,
} from "./apt-transfer-abort.ts";
import {
	type AptTransaction,
	legacyAptTransaction,
	openPinnedAptTransaction,
} from "./apt-transport.ts";
import {
	installFamily,
	normalizeAptCommandFailure,
} from "./apt-transport-result.ts";
import {
	logParseError,
	type ParseResult,
	parseFail,
	parseOk,
} from "./cli-parse.ts";
import {
	requestCompletionReboot,
	resetCompletionRebootForTest,
} from "./deferred-completion-reboot.ts";
import { isRealDevice } from "./device-detection.ts";
import {
	assertDisruptiveActionFree,
	DisruptiveActionRefusal,
	isDisruptiveActionPending,
	resetDisruptiveActionReservationForTest,
} from "./disruptive-action-reservation.ts";
import { classifyPackageLayer } from "./package-layer.ts";
import { markBootDegraded } from "./readiness.ts";
import type { SoftwareUpdateAttempt } from "./software-update-output.ts";
import {
	pendingAwareAptSpaceDeps,
	runLegacyPackageEffects,
} from "./software-update-pending-effects.ts";
import {
	DetachedAptServiceCleanupError,
	recoverDetachedAptUpgrade,
	runDetachedAptAll,
	runDetachedAptUpgrade,
	type SoftwareUpdateOutputHandlers,
	softwareUpdateUptimeMs,
} from "./software-update-process.ts";
import {
	isSoftwareUpdateRecoveryInconclusive,
	recoverSoftwareUpdateWithCoordination,
	resetSoftwareUpdateRecovery,
} from "./software-update-recovery.ts";
import {
	type CommitExitHook,
	finishSoftwareUpdateRestart,
} from "./software-update-restart.ts";
import { defaultDetachedAptServiceDeps } from "./software-update-service.ts";
import { isStreamConfirmedIdle } from "./stream-liveness-source.ts";
import { reconcileAptChannel } from "./update-apt-channel.ts";
import {
	readUpdateCapabilities,
	UpdateCapabilityReadError,
} from "./update-capabilities.ts";
import {
	PendingPackageSuccessError,
	pendingPackageSuccess,
} from "./update-orchestrator/pending-success-fence.ts";
import { getRecoveredUpdateExitHook } from "./update-orchestrator/recovery-exit-gate.ts";
import {
	deriveUpdateIdentity,
	deriveUpdateState,
	type UpdateCheckFailureReason,
	type UpdateFailure,
	type UpdateIdentity,
	type UpdateState,
	updateDismissalKey,
} from "./update-state.ts";

export type { SoftUpdateStatus } from "./apt-progress.ts";

let availableUpdates:
	| {
			package_count: number;
			download_size?: string;
	  }
	| null
	| false = aptUpdatesEnabled() ? null : false;
let softUpdateStatus: SoftUpdateStatus | null = null;
// Between boot and recovery's first read of a detached unit, nobody knows
// whether an update is running; the initial push then says nothing.
let softUpdateRecoveryPending = false;
let aptGetUpdating = false;
let aptDiscoveryRunning = false;
let aptGetUpdateFailures = 0;
let aptHeldBackPackages: string | undefined;
let actionableAppPackages: string[] = [];
let actionableAllPackages: PinnedAptPackage[] = [];
let aptAllRefusal: AptAllRefusalError | null = null;
let aptAllMode = false;
let discoveredPackages: UpdatePackage[] = [];
let lastAptReachability: AptReachabilityWire | undefined;
let delayedSoftwareUpdateStart: ReturnType<typeof setTimeout> | undefined;
let softwareUpdateRecoveryRetryTimer: ReturnType<typeof setTimeout> | undefined;
const SOFTWARE_UPDATE_RECOVERY_RETRY_MS = 3_000;
const APT_REFRESH_TIMEOUT_MS = 5 * oneMinute;
const APT_DISCOVERY_TIMEOUT_MS = 2 * oneMinute;
// A backstop only: apt's own per-connection timeouts end a stalled fetch first.
const APT_DOWNLOAD_TIMEOUT_MS = 60 * oneMinute;

type AptReachabilityProbe = (options?: {
	readonly maxAgeMs?: number;
}) => Promise<AptReachability>;

const EMULATED_APT_REACHABILITY: AptReachability = {
	ipv4: "ok",
	ipv6: "ok",
	used: "any",
	verdict: "any",
	detail: [],
};

const defaultAptReachabilityProbe: AptReachabilityProbe = async (options) =>
	shouldUseMocks()
		? EMULATED_APT_REACHABILITY
		: probeAptReachability({ ...defaultAptReachabilityDeps, ...options });

let aptReachabilityProbe: AptReachabilityProbe = defaultAptReachabilityProbe;

export function setAptReachabilityProbeForTest(
	probe: AptReachabilityProbe,
): void {
	aptReachabilityProbe = probe;
}

export function resetAptReachabilityProbeForTest(): void {
	aptReachabilityProbe = defaultAptReachabilityProbe;
}

async function prepareAptNetwork(options?: {
	readonly maxAgeMs?: number;
}): Promise<AptReachability> {
	if (!(await isRealDevice())) return aptReachabilityProbe(options);
	if (!(await updateGwWrapper(true))) {
		logger.warn("Apt preflight refused: host default-route repair failed");
		return deriveVerdict([]);
	}
	// A bound NIC probe is not evidence for apt's unbound sockets after a route change.
	return aptReachabilityProbe({ maxAgeMs: 0 });
}

// An image that routes `apt_uid` gets the OS transfers' per-transaction selector and pin.
async function openAptNetwork(
	capabilities: UpdateCapabilities,
	options?: { readonly maxAgeMs?: number },
	admission?: AptTransferAdmission,
): Promise<AptTransaction> {
	return (await isRealDevice()) &&
		capabilities.mode === "capable" &&
		capabilities.features.includes("transport-uidrange")
		? openPinnedAptTransaction(admission)
		: legacyAptTransaction(await prepareAptNetwork(options));
}

function aptReachabilityWire(
	reachability: AptReachability,
): AptReachabilityWire {
	return aptReachabilitySchema.parse({
		ipv4: reachability.ipv4,
		ipv6: reachability.ipv6,
		used: reachability.used,
	});
}

const defaultAptCommandRunner: typeof spawnWithTimeout = (argv, options) =>
	spawnWithTimeout(argv, options);
let aptCommandRunner = defaultAptCommandRunner;
export function setAptCommandRunnerForTest(
	runner: typeof spawnWithTimeout | null,
): void {
	aptCommandRunner = runner ?? defaultAptCommandRunner;
}

async function runAptCommand(
	argv: string[],
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<SpawnWithTimeoutResult> {
	assertDisruptiveActionFree();
	pendingPackageSuccess.assertEffectsAllowed();
	try {
		const result = await aptCommandRunner(argv, {
			timeoutMs,
			env: { ...process.env, LC_ALL: "C", LANG: "C", LANGUAGE: undefined },
			...(signal ? { signal } : {}),
		});
		pendingPackageSuccess.assertEffectsAllowed();
		return result;
	} catch (error) {
		if (
			error instanceof PendingPackageSuccessError ||
			error instanceof DisruptiveActionRefusal
		)
			throw error;
		return normalizeAptCommandFailure(error);
	}
}

let availableIdentity: UpdateIdentity | null = null;
let currentUpdateIdentity: UpdateIdentity | null = null;
let lastUpdateFailure: UpdateFailure | null = null;
let lastUpdateSucceeded = false;
let lastPreflightFailure: UpdatePreflightReason | null = null;
let lastCleanupWarning: Extract<
	UpdateState,
	{ kind: "success" }
>["cleanup_warning"];

// Distinguish a failed check from "up to date", and an empty result from no check.
let lastCheckFailure: UpdateCheckFailureReason | null = null;
let lastCheckedAt: number | null = null;

function failCurrentCheck(reason: UpdateCheckFailureReason): void {
	lastCheckFailure = reason;
}

// Synchronous start refusals. Post-acceptance limits are in root AGENTS.md's
// "D8 stream/update admission: what it does NOT cover", item (c).
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

export function aptUpdatesEnabled(): boolean {
	return setup.apt_update_enabled !== false;
}

export function getAvailableUpdates() {
	return availableUpdates;
}

// A recovered unit's cleanup and restart are waiting for startup's verdict.
let recoveredOwnershipPending = false;

export function beginSoftwareUpdateRecovery(): void {
	softUpdateRecoveryPending = true;
}

function settleSoftwareUpdateRecovery(): void {
	softUpdateRecoveryPending = false;
}

/** The new attempt's record; an older attempt's recorded exit stays only as a leftover. */
function admitSoftwareUpdateAttempt(): boolean {
	const deps = defaultDetachedAptServiceDeps();
	try {
		let previous: SoftwareUpdateAttempt | null = null;
		try {
			previous = deps.readAttempt();
		} catch (error) {
			logger.warn(
				"Software update: the previous attempt record is unreadable",
				{
					error,
				},
			);
		}
		const leftover =
			previous?.exitCode !== undefined && previous.invocation !== undefined
				? { invocation: previous.invocation, exitCode: previous.exitCode }
				: previous?.leftover;
		deps.writeAttempt({
			schema: 2,
			attempt: randomUUID(),
			phase: "accepted",
			uptimeMs: softwareUpdateUptimeMs(deps),
			...(leftover ? { leftover } : {}),
		});
		return true;
	} catch (error) {
		logger.warn("Software update refused: the attempt could not be recorded", {
			error,
		});
		return false;
	}
}

/** A unit's exit that an earlier lifetime observed and recorded. */
function adoptRecordedOutcome(exitCode: number): void {
	softUpdateStatus = null;
	lastUpdateSucceeded = exitCode === 0;
	lastUpdateFailure =
		exitCode === 0
			? null
			: {
					reason: `apt-get exited with code ${exitCode}`,
					failure_id: randomUUID(),
				};
	lastPreflightFailure = null;
	lastCleanupWarning = undefined;
}

/** Package progress for an initial push; omitted while recovery is pending. */
export function initialSoftUpdateStatus(): {
	updating?: SoftUpdateStatus | null;
	update_state?: UpdateState;
} {
	return softUpdateRecoveryPending
		? {}
		: { updating: softUpdateStatus, update_state: getUpdateState() };
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
	softUpdateRecoveryPending = false;
	recoveredOwnershipPending = false;
	if (delayedSoftwareUpdateStart) clearTimeout(delayedSoftwareUpdateStart);
	if (softwareUpdateRecoveryRetryTimer) {
		clearTimeout(softwareUpdateRecoveryRetryTimer);
	}
	delayedSoftwareUpdateStart = undefined;
	softwareUpdateRecoveryRetryTimer = undefined;
	resetSoftwareUpdateRecovery();
	lastInstallUnitVerdict = "not-probed";
	aptDiscoveryRunning = false;
	softUpdateStatus = null;
	currentUpdateIdentity = null;
	lastUpdateFailure = null;
	lastUpdateSucceeded = false;
	lastCheckFailure = null;
	lastPreflightFailure = null;
	lastCleanupWarning = undefined;
	lastCheckedAt = null;
	lastAptReachability = undefined;
	actionableAppPackages = [];
	actionableAllPackages = [];
	aptAllRefusal = null;
	resetAptAllRefusalLogForTest();
	aptAllMode = false;
	discoveredPackages = [];
}

export type SoftwareUpdateRecoveryDeps = {
	readonly recover: typeof recoverDetachedAptUpgrade;
	readonly scheduleRetry: (retry: () => void) => void;
	readonly resumePeriodicChecks: () => void;
};

function scheduleSoftwareUpdateRecoveryRetry(retry: () => void): void {
	if (softwareUpdateRecoveryRetryTimer) return;
	softwareUpdateRecoveryRetryTimer = setTimeout(() => {
		softwareUpdateRecoveryRetryTimer = undefined;
		retry();
	}, SOFTWARE_UPDATE_RECOVERY_RETRY_MS);
	softwareUpdateRecoveryRetryTimer.unref?.();
}

const defaultSoftwareUpdateRecoveryDeps: SoftwareUpdateRecoveryDeps = {
	recover: recoverDetachedAptUpgrade,
	scheduleRetry: scheduleSoftwareUpdateRecoveryRetry,
	resumePeriodicChecks: periodicCheckForSoftwareUpdates,
};

export { isSoftwareUpdateRecoveryInconclusive };

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
						...(discoveredPackages.length > 0
							? { packages: discoveredPackages }
							: {}),
						actionable_count: aptAllMode
							? actionableAllPackages.length
							: actionableAppPackages.length,
					}
				: null;
	return deriveUpdateState({
		checking: aptGetUpdating || aptDiscoveryRunning,
		available,
		updating:
			softUpdateStatus && softUpdateStatus.result === undefined
				? softUpdateStatus
				: null,
		failure: lastUpdateFailure,
		succeeded: lastUpdateSucceeded,
		preflightFailure: lastPreflightFailure,
		...(lastCleanupWarning === undefined
			? {}
			: { cleanupWarning: lastCleanupWarning }),
		checkFailure: lastCheckFailure,
		checkedAt: lastCheckedAt,
		...(lastAptReachability !== undefined
			? { reachability: lastAptReachability }
			: {}),
	});
}

function broadcastUpdateState() {
	broadcastMsg("status", { update_state: getUpdateState() });
}

// Auto-reboot runner DI seam: default runs the real argv-only run(); tests spy it.
type RebootRunner = (bin: string, args: string[]) => void | Promise<void>;

const defaultRebootRunner: RebootRunner = async (bin, args) => {
	await run(bin, args);
};

let rebootRunner: RebootRunner = defaultRebootRunner;

export function setRebootRunner(
	runner: (bin: string, args: string[]) => void,
): void {
	rebootRunner = (bin, args) => {
		const completion: unknown = runner(bin, args);
		return completion instanceof Promise
			? completion.then(() => undefined)
			: undefined;
	};
}

export function resetRebootRunner(): void {
	resetCompletionRebootForTest();
	resetDisruptiveActionReservationForTest();
	rebootRunner = defaultRebootRunner;
}

// Gate on isDevelopment() so a dev host is never rebooted after an update.
export function rebootAfterUpdate(): void {
	if (!isDevelopment())
		requestCompletionReboot(() => rebootRunner("reboot", []));
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

export { ceralivePackageList } from "./package-layer.ts";

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

// The reporting-side reader of the same block `parseHeldBackPackages` feeds to an
// argv. It DROPS a name that fails the charset instead of throwing, because this
// list is informational: a malformed entry must cost the operator one row, never
// the whole discovery cycle. The argv path stays fail-loud.
export function parseKeptBackPackageNames(stdout: string): string[] {
	const section = parseAptPackageList(
		stdout,
		"The following packages have been kept back:\n",
	);
	if (!section.ok || section.value === undefined) return [];
	return section.value
		.split(/\s+/)
		.filter((name) => name.length > 0 && APT_PACKAGE_NAME_RE.test(name));
}

// A package named in both lists remains kept-back, rather than installable.
export function buildDiscoveredPackages(
	upgradable: readonly string[],
	keptBack: readonly string[],
): UpdatePackage[] {
	const held = new Set(keptBack);
	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const name of [...upgradable, ...keptBack]) {
		if (name.length === 0 || seen.has(name)) continue;
		seen.add(name);
		ordered.push(name);
	}
	return ordered.map((name) => {
		const layer = classifyPackageLayer(name);
		const isKeptBack = held.has(name);
		return {
			name,
			layer,
			...(isKeptBack ? { kept_back: true as const } : {}),
			actionable: layer === "app" && !isKeptBack,
		};
	});
}

export function actionableAppNames(
	packages: readonly UpdatePackage[],
): string[] {
	return packages
		.filter((entry) => entry.actionable === true)
		.map((entry) => entry.name)
		.sort();
}

export function buildAptInstallArgs(packages: string[]): string[] {
	return ["install", "--assume-no", ...packages];
}

export function buildAptDiscoveryArgs(
	verdict: AptReachability["verdict"],
): string[] {
	return [
		"/usr/bin/apt-get",
		"dist-upgrade",
		"--assume-no",
		...aptFamilyArgs(verdict),
	];
}

async function getCapableUpdateSize(
	reachability: AptReachability,
): Promise<SoftwareUpdateError> {
	aptAllMode = true;
	pendingPackageSuccess.assertEffectsAllowed();
	await reconcileAptChannel("capable");
	const simulation = await runAptCommand(
		buildAptAllDiscoveryArgs(aptFamilyArgs(reachability.verdict)),
		APT_DISCOVERY_TIMEOUT_MS,
	);
	if (simulation.exitCode !== 0) {
		logAptAllRefusal(
			new AptAllRefusalError("discovery_failed", "simulation", {
				exit: simulation.exitCode,
				detail: simulation.stderr,
			}),
		);
		failCurrentCheck("discovery_failed");
		return "discovery_failed";
	}
	const holds = await runAptCommand(
		["/usr/bin/apt-mark", "showhold"],
		APT_DISCOVERY_TIMEOUT_MS,
	);
	if (holds.exitCode !== 0) {
		logAptAllRefusal(
			new AptAllRefusalError("discovery_failed", "held-packages", {
				exit: holds.exitCode,
				detail: holds.stderr,
			}),
		);
		failCurrentCheck("discovery_failed");
		return "discovery_failed";
	}
	try {
		const sourcePolicy = await runAptCommand(
			["/usr/bin/apt-cache", "policy"],
			APT_DISCOVERY_TIMEOUT_MS,
		);
		if (sourcePolicy.exitCode !== 0)
			throw new AptAllRefusalError("discovery_failed", "source-policy", {
				exit: sourcePolicy.exitCode,
				detail: sourcePolicy.stderr,
			});
		const result = await discoverAptAllPackages(
			simulation.stdout,
			holds.stdout,
			async (name) => {
				const policy = await runAptCommand(
					["/usr/bin/apt-cache", "policy", name],
					APT_DISCOVERY_TIMEOUT_MS,
				);
				if (policy.exitCode !== 0)
					throw new AptAllRefusalError("discovery_failed", "package-policy", {
						exit: policy.exitCode,
						detail: policy.stderr,
					});
				return policy.stdout;
			},
			sourcePolicy.stdout,
		);
		pendingPackageSuccess.assertEffectsAllowed();
		aptAllRefusal = null;
		actionableAllPackages = result.actionable;
		discoveredPackages = result.packages;
		const packageNames = result.packages.map((item) => item.name);
		availableIdentity =
			packageNames.length > 0
				? deriveUpdateIdentity(packageNames, packageNames.length)
				: null;
		availableUpdates = { package_count: packageNames.length };
		if (
			result.actionable.some(
				({ name }) => name.startsWith("ceralive-") || name === "cerastream",
			)
		) {
			notificationBroadcast(
				"ceralive_update",
				"warning",
				"A CeraLive update is available. Open Settings → Software Updates to install it.",
				0,
				true,
				true,
			);
		}
		broadcastMsg("status", {
			available_updates: availableUpdates,
			update_state: getUpdateState(),
		});
		return null;
	} catch (error) {
		if (!(error instanceof AptAllRefusalError)) throw error;
		logAptAllRefusal(error);
		aptAllRefusal = error;
		actionableAllPackages = [];
		availableUpdates = null;
		availableIdentity = null;
		discoveredPackages = [];
		lastUpdateFailure = { reason: error.reason };
		notificationBroadcast(
			"ceralive_update_failed",
			"error",
			"The software update was refused. Open Settings → Software Updates to see the reason.",
			0,
			true,
			true,
		);
		broadcastMsg("status", {
			available_updates: availableUpdates,
			update_state: getUpdateState(),
		});
		return "discovery_failed";
	}
}

function aptFamilyArgs(verdict: AptReachability["verdict"]): readonly string[] {
	if (verdict === "force_ipv4") return ["-o", "Acquire::ForceIPv4=true"];
	if (verdict === "force_ipv6") return ["-o", "Acquire::ForceIPv6=true"];
	return [];
}

export function buildAptRefreshArgs(
	verdict: AptReachability["verdict"],
): string[] {
	return [
		"/usr/bin/apt-get",
		"update",
		"--allow-releaseinfo-change",
		"-o",
		"Acquire::http::Timeout=15",
		"-o",
		"Acquire::https::Timeout=15",
		"-o",
		"Acquire::Retries=1",
		...aptFamilyArgs(verdict),
	];
}

export function buildAptUpgradeArgs(
	packages: readonly string[],
	verdict: AptReachability["verdict"],
): string[] {
	const base = [
		"-y",
		"-o",
		"Dpkg::Options::=--force-confdef",
		"-o",
		"Dpkg::Options::=--force-confold",
		...aptFamilyArgs(verdict),
	];
	const actionable = packages
		.filter((name) => classifyPackageLayer(name) === "app")
		.sort();
	return [...base, "install", ...actionable];
}

async function aptAssumeNoInstall(
	packages: string[],
	verdict: AptReachability["verdict"],
): Promise<string> {
	const result = await runAptCommand(
		[
			"/usr/bin/apt-get",
			...buildAptInstallArgs(packages),
			...aptFamilyArgs(verdict),
		],
		APT_DISCOVERY_TIMEOUT_MS,
	);
	// --assume-no exits non-zero whenever changes would be made; its summary is
	// still authoritative stdout and must be parsed on that expected refusal.
	return result.stdout;
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
		.replaceAll("\r\n", "\n")
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

	const names = packageList.value
		.split(/\s+/)
		.filter((name) => APT_PACKAGE_NAME_RE.test(name));
	return parseOk({
		upgradeCount: upgradeCount.value,
		downloadSize: downloadSize.value,
		ceralivePackages: names.some(
			(name) => classifyPackageLayer(name) === "app",
		),
		packages: names,
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

async function getSoftwareUpdateSize(reachability: AptReachability) {
	if (!aptUpdatesEnabled()) return null;
	if (!isStreamConfirmedIdle() || isUpdating() || aptGetUpdating) return "busy";
	const capabilities = await readPackageCapabilities();
	if (capabilities === null) return "discovery_failed";
	pendingPackageSuccess.assertEffectsAllowed();
	if (capabilities.mode === "capable")
		return getCapableUpdateSize(reachability);
	aptAllMode = false;

	const upgradeResult = await runAptCommand(
		buildAptDiscoveryArgs(reachability.verdict),
		APT_DISCOVERY_TIMEOUT_MS,
	);
	const upgrade = {
		code: upgradeResult.exitCode,
		stdout: upgradeResult.stdout,
		stderr: upgradeResult.stderr,
	};
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
	let fromHeldBack = false;

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
			fromHeldBack = true;
			const stdout = await aptAssumeNoInstall(
				parseHeldBackPackages(aptHeldBackPackages),
				reachability.verdict,
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
		aptHeldBackPackages = undefined;
	}
	// The kept-back block is read from the ORIGINAL dist-upgrade output on every
	// cycle, not only when nothing could be upgraded: apt reports kept-back
	// packages alongside real upgrades, and an operator must be told about them
	// either way. In the held-back fallback branch `res` describes the explicit
	// install plan rather than an upgrade set, so nothing there is upgradable.
	discoveredPackages = buildDiscoveredPackages(
		fromHeldBack ? [] : res.packages,
		parseKeptBackPackageNames(upgrade.stdout),
	);
	actionableAppPackages = actionableAppNames(discoveredPackages);

	availableIdentity =
		res.upgradeCount > 0
			? deriveUpdateIdentity(res.packages, res.upgradeCount, res.downloadSize)
			: null;

	if (res.ceralivePackages && availableIdentity) {
		notificationBroadcast(
			"ceralive_update",
			"warning",
			"A CeraLive update is available. Open Settings → Software Updates to install it.",
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

async function readPackageCapabilities(): Promise<UpdateCapabilities | null> {
	try {
		return await readUpdateCapabilities();
	} catch (error) {
		if (!(error instanceof UpdateCapabilityReadError)) throw error;
		pendingPackageSuccess.assertEffectsAllowed();
		actionableAppPackages = [];
		actionableAllPackages = [];
		discoveredPackages = [];
		availableUpdates = null;
		availableIdentity = null;
		lastUpdateSucceeded = false;
		failCurrentCheck(error.reason);
		logger.warn("Software update capability regime unknown", {
			reason: error.reason,
		});
		return null;
	}
}

// Node's ExecException, reproduced structurally so callers keep the same
// error-classification surface (code/stdout/stderr) without the Node import.
type ExecException = Error & {
	code?: number;
	stdout?: string;
	stderr?: string;
};

export type SoftwareUpdateError =
	| ExecException
	| "busy"
	| "repos_unreachable"
	| "discovery_failed"
	| "captive_portal"
	| true
	| null;

/**
 * Classify the outcome of `apt-get update` into the legacy `errOrStderr` value.
 *
 */
export function classifyAptUpdateResult(
	exitCode: number,
	stderr: string,
): SoftwareUpdateError {
	if (
		stderr.includes("does the network require authentication?") ||
		stderr.includes("Clearsigned file isn't valid, got 'NOSPLIT'")
	) {
		return "captive_portal";
	}
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
	if (pendingPackageSuccess.pending) return false;
	if (!aptUpdatesEnabled()) return false;
	if (
		!isStreamConfirmedIdle() ||
		isUpdating() ||
		aptGetUpdating ||
		aptDiscoveryRunning
	) {
		return false;
	}

	lastCheckFailure = null;
	lastAptReachability = undefined;
	aptGetUpdating = true;
	broadcastUpdateState();

	void runLegacyPackageEffects(
		async () => {
			const capabilities = await readPackageCapabilities();
			if (capabilities === null) {
				callback("discovery_failed", aptGetUpdateFailures);
				return;
			}
			await reconcileAptChannel(capabilities.mode);
			const network = await openAptNetwork(capabilities);
			const reachability = network.reachability;
			pendingPackageSuccess.assertEffectsAllowed();
			lastAptReachability = aptReachabilityWire(reachability);
			broadcastUpdateState();
			if (
				reachability.verdict === "unreachable" ||
				reachability.verdict === "captive_portal" ||
				reachability.verdict === "probe_unavailable" ||
				reachability.verdict === "credentials_invalid"
			) {
				aptGetUpdating = false;
				const reason =
					reachability.verdict === "probe_unavailable" ||
					reachability.verdict === "credentials_invalid"
						? "discovery_failed"
						: reachability.verdict === "unreachable"
							? "repos_unreachable"
							: "captive_portal";
				failCurrentCheck(reason);
				callback(reason, aptGetUpdateFailures);
				return;
			}
			// Each attempt's reachability carries the family it is pinned to.
			const res = await network.transfer((reachability) =>
				runAptCommand(
					buildAptRefreshArgs(reachability.verdict),
					APT_REFRESH_TIMEOUT_MS,
				),
			);
			const stdout = res.stdout;
			const stderr = res.stderr;

			aptGetUpdating = false;

			// The operator-visible generic refresh verdict keys on the exit code because
			// apt writes benign warnings to stderr. Only the two captive-portal signatures
			// are specific enough for stderr to override that rule.
			const errOrStderr = classifyAptUpdateResult(res.exitCode, stderr);
			if (errOrStderr === "captive_portal") {
				failCurrentCheck("captive_portal");
			} else if (res.exitCode !== 0) {
				failCurrentCheck("refresh_failed");
			}

			if (stderr.length) {
				aptGetUpdateFailures++;
			} else {
				aptGetUpdateFailures = 0;
			}

			logger.info(
				`apt-get update: ${errOrStderr === null ? "success" : "error"}`,
			);
			if (stdout) logger.info(stdout);
			if (stderr) logger.error(stderr);

			if (callback) callback(errOrStderr, aptGetUpdateFailures);
		},
		() => callback("discovery_failed", aptGetUpdateFailures),
	)
		.catch((error: unknown) => {
			aptGetUpdating = false;
			failCurrentCheck("discovery_failed");
			logger.warn("Software update refresh failed unexpectedly", {
				error: error instanceof Error ? error : String(error),
			});
			callback("discovery_failed", aptGetUpdateFailures);
		})
		.finally(() => {
			aptGetUpdating = false;
			broadcastUpdateState();
		});
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

// Benign refresh warnings must not suppress discovery's publication.
type SoftwareUpdateSizeRunner = (
	reachability: AptReachability,
) => Promise<SoftwareUpdateError>;

let softwareUpdateSizeRunner: SoftwareUpdateSizeRunner = getSoftwareUpdateSize;

export function setSoftwareUpdateSizeRunner(
	runner: SoftwareUpdateSizeRunner,
): void {
	softwareUpdateSizeRunner = runner;
}

export function resetSoftwareUpdateSizeRunner(): void {
	softwareUpdateSizeRunner = getSoftwareUpdateSize;
}

// Orchestrator checks own a full cycle, not discovery against previously fetched lists.
export function runSoftwareUpdateCheck(): Promise<SoftwareUpdateError> {
	return new Promise((resolve, reject) => {
		const started = softwareUpdateCheckRunner((refresh) => {
			// Exit-zero warnings are benign; discovery must retain a real refresh failure.
			const failure =
				refresh === true && lastCheckFailure === null ? null : refresh;
			if (failure !== null) {
				resolve(failure);
				return;
			}
			void runUpdateDiscoveryAndReport().then(
				(discovery) => resolve(failure ?? discovery),
				reject,
			);
		});
		if (!started) resolve("busy");
	});
}

// Publish after discovery's early returns so an empty result is observable.
export async function runUpdateDiscoveryAndReport(): Promise<SoftwareUpdateError> {
	if (pendingPackageSuccess.pending) return "discovery_failed";
	if (aptDiscoveryRunning) return "busy";
	aptDiscoveryRunning = true;
	lastCheckedAt = Date.now();
	try {
		const capabilities = await readPackageCapabilities();
		if (capabilities === null) return "discovery_failed";
		const network = await openAptNetwork(capabilities);
		const reachability = network.reachability;
		pendingPackageSuccess.assertEffectsAllowed();
		lastAptReachability = aptReachabilityWire(reachability);
		if (
			reachability.verdict === "probe_unavailable" ||
			reachability.verdict === "credentials_invalid"
		) {
			failCurrentCheck("discovery_failed");
			return "discovery_failed";
		}
		if (reachability.verdict === "unreachable") {
			failCurrentCheck("repos_unreachable");
			return "repos_unreachable";
		}
		if (reachability.verdict === "captive_portal") {
			failCurrentCheck("captive_portal");
			return "captive_portal";
		}
		return await network.within(
			(attempt) =>
				runLegacyPackageEffects(
					() => {
						lastAptReachability = aptReachabilityWire(attempt);
						return softwareUpdateSizeRunner(attempt);
					},
					() => "discovery_failed" as const,
				),
			() => {
				failCurrentCheck("discovery_failed");
				return "discovery_failed";
			},
		);
	} catch (error) {
		if (error instanceof PendingPackageSuccessError) return "discovery_failed";
		throw error;
	} finally {
		aptDiscoveryRunning = false;
		broadcastUpdateState();
	}
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
	if (pendingPackageSuccess.pending) {
		if (nextCheckForSoftwareUpdatesTimer)
			clearTimeout(nextCheckForSoftwareUpdatesTimer);
		scheduleNextSoftwareUpdateCheck(SKIP_RETRY_DELAY_MS);
		return;
	}
	if (!aptUpdatesEnabled()) return;
	// Protect the dev host from background APT effects.
	if (shouldUseMocks()) return;
	if (isSoftwareUpdateRecoveryInconclusive()) return;
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

export function triggerManualUpdateCheck(): boolean {
	if (pendingPackageSuccess.pending) return false;
	if (isSoftwareUpdateRecoveryInconclusive()) return false;
	if (shouldUseMocks()) {
		if (
			!isStreamConfirmedIdle() ||
			isUpdating() ||
			aptGetUpdating ||
			aptDiscoveryRunning
		) {
			return false;
		}
		lastUpdateFailure = null;
		lastUpdateSucceeded = false;
		lastCheckFailure = null;
		lastPreflightFailure = null;
		lastCleanupWarning = undefined;
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
	const priorPreflight = lastPreflightFailure;
	const priorCleanup = lastCleanupWarning;
	lastUpdateFailure = null;
	lastUpdateSucceeded = false;
	lastPreflightFailure = null;
	lastCleanupWarning = undefined;

	const started = softwareUpdateCheckRunner(async () => {
		await runUpdateDiscoveryAndReport();
	});
	if (!started) {
		lastUpdateFailure = priorFailure;
		lastUpdateSucceeded = priorSucceeded;
		lastPreflightFailure = priorPreflight;
		lastCleanupWarning = priorCleanup;
	}
	return started;
}

type SoftwareUpdateRunner = (
	onCommitSucceeded?: () => void,
) => UpdateStartOutcome;

const defaultSoftwareUpdateRunner: SoftwareUpdateRunner = (
	onCommitSucceeded,
) => {
	const admission = captureAptTransferAdmission();
	const checkStarted = softwareUpdateCheckRunner(async (err) => {
		if (err === null) {
			await doSoftwareUpdate(onCommitSucceeded, admission);
		} else if (softUpdateStatus) {
			const reason =
				err === "discovery_failed"
					? "discovery_failed"
					: "Failed to fetch the updated package list; aborting the update.";
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

	// Latching a declined check would wedge isUpdating(). For later latch gaps,
	// see "D8 stream/update admission: what it does NOT cover" in
	// AGENTS.md.
	if (!checkStarted) return refuseUpdateStart("check_unavailable");

	settleSoftwareUpdateRecovery();
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

let mockSoftwareUpdatePromise: Promise<void> | null = null;

export function getMockSoftwareUpdatePromise(): Promise<void> | null {
	return mockSoftwareUpdatePromise;
}

async function simulateMockSoftwareUpdate(): Promise<void> {
	softUpdateStatus = { total: 0, downloading: 0, unpacking: 0, setting_up: 0 };
	broadcastMsg("status", { updating: softUpdateStatus });

	const steps: SoftUpdateStatus[] = [
		{ total: 1, downloading: 1, unpacking: 0, setting_up: 0, percent: 45 },
		{ total: 1, downloading: 1, unpacking: 0, setting_up: 0, percent: 99 },
		{ total: 1, downloading: 0, unpacking: 0, setting_up: 1, percent: 20 },
		{ total: 1, downloading: 0, unpacking: 0, setting_up: 1, percent: 80 },
	];

	for (const step of steps) {
		await Bun.sleep(MOCK_UPDATE_STEP_DELAY_MS);
		if (!softUpdateStatus) return;
		softUpdateStatus = step;
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

export function startSoftwareUpdate(
	onCommitSucceeded?: () => void,
): UpdateStartOutcome {
	if (isDisruptiveActionPending()) return refuseUpdateStart("already_updating");
	if (pendingPackageSuccess.pending)
		return refuseUpdateStart("check_unavailable");
	if (!aptUpdatesEnabled()) return refuseUpdateStart("updates_disabled");
	if (!isStreamConfirmedIdle()) return refuseUpdateStart("streaming");
	if (isUpdating()) return refuseUpdateStart("already_updating");
	if (isSoftwareUpdateRecoveryInconclusive()) {
		return refuseUpdateStart("check_unavailable");
	}
	if (recoveredOwnershipPending) return refuseUpdateStart("check_unavailable");
	// Before anything is published or started: a restart from here on finds
	// this attempt's record, never an older attempt's exit.
	if (!shouldUseMocks() && !admitSoftwareUpdateAttempt())
		return refuseUpdateStart("check_unavailable");

	currentUpdateIdentity = availableIdentity;
	lastUpdateFailure = null;
	lastUpdateSucceeded = false;
	lastPreflightFailure = null;
	lastCleanupWarning = undefined;

	if (aptGetUpdating || aptDiscoveryRunning) {
		if (!delayedSoftwareUpdateStart) {
			delayedSoftwareUpdateStart = setTimeout(() => {
				delayedSoftwareUpdateStart = undefined;
				if (pendingPackageSuccess.pending) return;
				const outcome = startSoftwareUpdate(onCommitSucceeded);
				if (!outcome.started) {
					lastUpdateSucceeded = false;
					lastUpdateFailure = {
						reason: `Software update could not start after waiting for package discovery: ${outcome.reason}`,
						...((currentUpdateIdentity ?? availableIdentity)
							? {
									identity: (currentUpdateIdentity ??
										availableIdentity) as UpdateIdentity,
								}
							: {}),
					};
					broadcastUpdateState();
				}
			}, 3 * 1000);
			delayedSoftwareUpdateStart.unref?.();
		}
		return { started: true };
	}

	if (shouldUseMocks()) {
		mockSoftwareUpdatePromise = simulateMockSoftwareUpdate();
		void mockSoftwareUpdatePromise;
		return { started: true };
	}

	return softwareUpdateRunner(onCommitSucceeded);
}

type SoftwareUpdateProcessMonitor = {
	readonly handlers: SoftwareUpdateOutputHandlers;
	// Resolves once softUpdateStatus/lastUpdateSucceeded/lastUpdateFailure are
	// settled — NOT once the detached logging + crash-to-restart tail below has
	// run. That tail deliberately throws via invariant() on a plain success to
	// force an unhandled rejection that restarts the process; a caller
	// awaiting the returned promise must observe getUpdateState() settle
	// without being able to catch (and thus swallow) that intentional crash.
	readonly finish: (
		completion: Promise<number>,
		onCommitSucceeded?: CommitExitHook,
	) => Promise<void>;
};

export function createSoftwareUpdateProcessMonitor(
	prefetched = "",
	{
		ownership,
		exitHook,
	}: {
		readonly ownership?: Promise<boolean>;
		/** Read once ownership is granted: startup reserves the hook while adjudicating. */
		readonly exitHook?: () => CommitExitHook | undefined;
	} = {},
): SoftwareUpdateProcessMonitor {
	let rebootAfterUpgrade = false;
	let summaryParseLogged = false;
	let aptLog = prefetched;
	let aptErr = "";
	let aptStatus = "";
	// A reattached unit is announced by its first caught-up drain.
	let announced = true;
	// Live units write the status channel; a recovered one says whether it does.
	let channel = true;
	// Only a durably recorded exit may restart CeraUI; unrecorded, the unit is the evidence.
	let outcomeRecorded = true;

	const observeRebootPackages = () => {
		if (rebootAfterUpgrade) return;
		const count = parseUpgradePackageCount(aptLog);
		if (!count.ok) {
			if (!summaryParseLogged && aptLog.includes(" upgraded")) {
				summaryParseLogged = true;
				logParseError(count);
			}
			return;
		}
		if (count.value === 0) return;
		const packageList = parseAptUpgradedPackages(aptLog);
		rebootAfterUpgrade =
			packageList.ok &&
			packageList.value !== undefined &&
			packageListIncludes(packageList.value, rebootPackageList);
	};
	if (prefetched) observeRebootPackages();

	const publishProgress = (caughtUp = true) => {
		if (!softUpdateStatus) return;
		observeRebootPackages();
		// A recovered unit is announced only once its files are read to the end.
		if (!announced && !caughtUp) return;
		const previous = softUpdateStatus;
		const next = holdUpdateProgress(
			previous,
			deriveUpdateProgress(
				aptLog.slice(prefetched.length),
				channel ? aptStatus : undefined,
			),
		);
		softUpdateStatus = next;
		if (announced && next === previous) return;
		announced = true;
		settleSoftwareUpdateRecovery();
		try {
			broadcastMsg("status", {
				updating: next,
				update_state: getUpdateState(),
			});
		} catch (broadcastError) {
			// The observer must keep draining; a lost frame is superseded by the next.
			logger.warn("Software update progress: broadcast failed", {
				error: broadcastError,
			});
		}
	};

	const handlers: SoftwareUpdateOutputHandlers = {
		onStdout: (data) => {
			aptLog += data;
		},
		onStderr: (data) => {
			aptErr += data;
		},
		onStatus: (data) => {
			aptStatus += data;
		},
		onDrained: publishProgress,
		onStatusLost: () => {
			channel = false;
		},
		onOutcomeRecorded: (recorded) => {
			outcomeRecorded = recorded;
		},
		onAttached: (aptStatus) => {
			announced = false;
			channel = aptStatus;
		},
		onObserverError: (error, suppressedRetries = 0) => {
			logger.warn(
				"Software update observer retrying after a local read failure",
				{
					error,
					suppressed_retries: suppressedRetries,
				},
			);
		},
	};

	const settle = async (
		completion: Promise<number>,
		owned: boolean,
	): Promise<number> => {
		let code: number;
		try {
			code = await completion;
		} catch (err) {
			if (err instanceof DetachedAptServiceCleanupError) {
				// The verified, recorded exit is the outcome; the next launch retires the unit.
				code = err.transactionExitCode;
				logger.error(
					"Software update: the finished unit could not be retired",
					{
						error: err.cleanupError,
					},
				);
			} else {
				const message = err instanceof Error ? err.message : String(err);
				aptErr += aptErr.length > 0 ? `\n${message}` : message;
				code = 1;
			}
		}

		// Keep the in-flight latch until cleanup settles; its result cannot change code.
		// A recovered unit's cache waits until startup hands the unit over.
		const cleaned =
			ownership !== undefined || (await cleanAptCache(defaultAptSpaceDeps.run));
		lastCleanupWarning =
			code === 0 && !cleaned ? "post_clean_failed" : undefined;
		// The outcome is known: initial pushes may report it again.
		settleSoftwareUpdateRecovery();

		if (softUpdateStatus) {
			const failure =
				code === 0
					? null
					: {
							reason: aptErr.trim() || `apt-get exited with code ${code}`,
							failure_id: randomUUID(),
							...((currentUpdateIdentity ?? availableIdentity)
								? {
										identity: (currentUpdateIdentity ??
											availableIdentity) as UpdateIdentity,
									}
								: {}),
						};
			// getUpdateState()-relevant assignments happen FIRST and
			// unconditionally, before any broadcast/notification call below —
			// a caller awaiting settle() must observe the real outcome even if
			// a broadcast fails for some unrelated reason.
			lastUpdateSucceeded = code === 0;
			if (code === 0 && owned && !ownership) pendingPackageSuccess.observe();
			lastUpdateFailure = failure;
			softUpdateStatus.result = code === 0 ? code : aptErr;
			const settledStatus = softUpdateStatus;
			softUpdateStatus = null;
			try {
				if (failure) {
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
				broadcastMsg("status", {
					updating: settledStatus,
					update_state: getUpdateState(),
				});
				broadcastUpdateState();
			} catch (broadcastError) {
				// The outcome is already recorded above; a broadcast/notification
				// failure must never mask it or make settle() throw — that would
				// let an upstream guard (guardNonCritical) swallow the deliberate
				// crash-to-restart `finish()`'s tail fires on a plain success.
				logger.warn("Software update settle: broadcast failed", {
					error: broadcastError,
				});
			}
		}

		return code;
	};

	const finish = (
		completion: Promise<number>,
		onCommitSucceeded?: CommitExitHook,
	): Promise<void> => {
		const settled = settle(completion, onCommitSucceeded !== undefined);
		if (ownership) recoveredOwnershipPending = true;
		// Keep the deliberate restart detached so a caller's catch cannot swallow it.
		void settled.then(async (code) => {
			if (aptLog) logger.info(aptLog);
			if (aptErr) logger.error(aptErr);
			let hook = onCommitSucceeded;
			if (ownership) {
				// The outcome is told already; the unit's owner duties wait for startup.
				let owned = false;
				try {
					owned = await ownership;
					if (owned) {
						hook = exitHook?.() ?? onCommitSucceeded;
						const cleaned = await cleanAptCache(defaultAptSpaceDeps.run);
						if (code === 0 && !cleaned) {
							lastCleanupWarning = "post_clean_failed";
							broadcastUpdateState();
						}
						if (code === 0 && hook) pendingPackageSuccess.observe();
					}
				} catch (error) {
					owned = false;
					logger.error(
						"Software update: the recovered unit was not handed over",
						{
							error,
						},
					);
				} finally {
					recoveredOwnershipPending = false;
				}
				if (!owned) {
					logger.warn(
						"Software update: startup kept the recovered unit; it is watched only",
					);
					return;
				}
			}
			if (code === 0) {
				// Persist the observed commit success before deliberately exiting.
				void finishSoftwareUpdateRestart(hook, () => {
					if (!outcomeRecorded) {
						markBootDegraded("software-update-retirement");
						logger.error(
							"Software update: restart withheld; the exit could not be recorded, so the finished unit stays as the evidence",
						);
					} else if (rebootAfterUpgrade && !hook) {
						rebootAfterUpdate();
					} else {
						invariant(
							false,
							"software update complete; exiting to restart CeraUI",
						);
					}
				});
			}
		});
		return settled.then(() => undefined);
	};

	return { handlers, finish };
}

async function doSoftwareUpdate(
	onCommitSucceeded?: () => void,
	admission?: AptTransferAdmission,
): Promise<void> {
	return runLegacyPackageEffects(
		() => prepareSoftwareUpdate(onCommitSucceeded, admission),
		() => {
			softUpdateStatus = null;
			broadcastMsg("status", {
				updating: null,
				update_state: getUpdateState(),
			});
		},
	);
}

async function prepareSoftwareUpdate(
	onCommitSucceeded?: () => void,
	admission?: AptTransferAdmission,
): Promise<void> {
	pendingPackageSuccess.assertEffectsAllowed();
	if (!aptUpdatesEnabled() || !isStreamConfirmedIdle()) return;
	const capabilities = await readPackageCapabilities();
	if (capabilities === null) {
		refuseUnknownPackageInstall();
		return;
	}
	const network = await openAptNetwork(
		capabilities,
		{ maxAgeMs: 0 },
		admission,
	);
	const reachability = network.reachability;
	pendingPackageSuccess.assertEffectsAllowed();
	const freshCapabilities = await readPackageCapabilities();
	if (freshCapabilities === null) {
		refuseUnknownPackageInstall();
		return;
	}
	const capable = freshCapabilities.mode === "capable";
	pendingPackageSuccess.assertEffectsAllowed();
	if (capable) {
		const discovery = await network.within(
			(attempt) => getCapableUpdateSize(attempt),
			(): SoftwareUpdateError => {
				failCurrentCheck("discovery_failed");
				return "discovery_failed";
			},
		);
		if (discovery !== null) {
			if (softUpdateStatus)
				softUpdateStatus.result = aptAllRefusal?.reason ?? "discovery_failed";
			softUpdateStatus = null;
			broadcastMsg("status", {
				updating: null,
				update_state: getUpdateState(),
			});
			return;
		}
	}
	lastAptReachability = aptReachabilityWire(reachability);
	if (
		reachability.verdict === "unreachable" ||
		reachability.verdict === "captive_portal" ||
		reachability.verdict === "probe_unavailable" ||
		reachability.verdict === "credentials_invalid" ||
		(capable
			? actionableAllPackages.length === 0
			: actionableAppPackages.length === 0)
	) {
		const reason =
			reachability.verdict === "captive_portal"
				? "A captive portal prevented the software update."
				: reachability.verdict === "probe_unavailable"
					? "The repository probe tooling is unavailable."
					: reachability.verdict === "credentials_invalid"
						? "The APT client certificate was rejected."
						: reachability.verdict === "unreachable"
							? "The software repositories are unreachable."
							: "No actionable application packages are available.";
		lastUpdateSucceeded = false;
		lastUpdateFailure = { reason };
		if (softUpdateStatus) softUpdateStatus.result = reason;
		broadcastMsg("status", {
			updating: softUpdateStatus,
			update_state: getUpdateState(),
		});
		softUpdateStatus = null;
		broadcastUpdateState();
		return;
	}
	const args = capable
		? buildAptAllInstallArgs(
				actionableAllPackages,
				installFamily(network.reachability.verdict),
			)
		: buildAptUpgradeArgs(actionableAppPackages, reachability.verdict);
	if (capable) {
		try {
			const probe = await network.within(
				(attempt) =>
					runAptCommand(
						[
							"/usr/bin/apt-get",
							"-s",
							"-o",
							"Debug::NoLocking=1",
							...buildAptAllInstallArgs(
								actionableAllPackages,
								installFamily(attempt.verdict),
							).filter((arg) => arg !== "-y" && arg !== "--no-download"),
						],
						APT_DISCOVERY_TIMEOUT_MS,
					),
				() => ({ exitCode: 1, stdout: "", stderr: "update routing refused" }),
			);
			if (probe.exitCode !== 0)
				throw new AptAllRefusalError("discovery_failed", "pinned-simulation", {
					exit: probe.exitCode,
					detail: probe.stderr,
				});
			assertPinnedInstallSimulation(probe.stdout, actionableAllPackages);
		} catch (error) {
			if (!(error instanceof AptAllRefusalError)) throw error;
			logAptAllRefusal(error);
			lastUpdateFailure = { reason: error.reason };
			softUpdateStatus = null;
			notificationBroadcast(
				"ceralive_update_failed",
				"error",
				"The software update was refused. Open Settings → Software Updates to see the reason.",
				0,
				true,
				true,
			);
			broadcastMsg("status", {
				updating: null,
				update_state: getUpdateState(),
			});
			return;
		}
	}
	if (capable && aptAllRefusal !== null) {
		lastUpdateFailure = { reason: aptAllRefusal.reason };
		softUpdateStatus = null;
		broadcastMsg("status", { updating: null, update_state: getUpdateState() });
		return;
	}
	try {
		await network.within(
			(attempt) =>
				preflightAptSpace(
					capable && network.pinned
						? buildAptAllInstallArgs(
								actionableAllPackages,
								installFamily(attempt.verdict),
							)
						: args,
					pendingAwareAptSpaceDeps,
				),
			() => {
				throw new AptPreflightError("probe_failed");
			},
		);
	} catch (error) {
		if (pendingPackageSuccess.pending)
			throw new PendingPackageSuccessError(
				"package success persistence pending",
			);
		if (!(error instanceof AptPreflightError)) throw error;
		lastPreflightFailure = error.reason;
		lastUpdateFailure = null;
		lastUpdateSucceeded = false;
		lastCleanupWarning = undefined;
		// Omission preserves the browser's overlay. Clear and terminal must be ONE frame.
		softUpdateStatus = null;
		logger.warn("Software update preflight refused", {
			preflight_reason: error.reason,
		});
		broadcastMsg("status", { updating: null, update_state: getUpdateState() });
		return;
	}
	// Fetch under the pin so the unit's own download stage is a cache hit.
	let prefetched = "";
	if (capable && network.pinned) {
		// The transfer runs before the unit's status channel exists: name it.
		if (softUpdateStatus) {
			softUpdateStatus = { ...PHASE_MARKERS.downloading };
			broadcastMsg("status", {
				updating: softUpdateStatus,
				update_state: getUpdateState(),
			});
		}
		const fetched = await network.transfer(
			(attempt, signal) =>
				runAptCommand(
					buildAptAllDownloadArgs(aptFamilyArgs(attempt.verdict)),
					APT_DOWNLOAD_TIMEOUT_MS,
					signal,
				),
			{ abortable: true },
		);
		if (fetched.exitCode !== 0 && !network.aborted()) {
			const failed = createSoftwareUpdateProcessMonitor();
			failed.handlers.onStdout(fetched.stdout);
			failed.handlers.onStderr(fetched.stderr);
			await failed.finish(Promise.resolve(fetched.exitCode));
			return;
		}
		prefetched = fetched.stdout;
	}
	// Stamp after preflight so a refusal does not suppress stream restoration.
	assertDisruptiveActionFree();
	if (network.aborted() || !isStreamConfirmedIdle()) {
		refuseUpdateStart("streaming");
		softUpdateStatus = null;
		broadcastUpdateState();
		return;
	}
	pendingPackageSuccess.assertEffectsAllowed();
	notePlannedShutdown("software_update");
	const monitor = createSoftwareUpdateProcessMonitor(prefetched);
	const finalFamily = installFamily(network.reachability.verdict);
	const detachedArgs =
		capable && network.pinned
			? buildAptAllInstallArgs(actionableAllPackages, finalFamily)
			: args;
	lastAptReachability = aptReachabilityWire(network.reachability);

	// 2026-08-29: apt can restart ceralive.service from a package script;
	// running it in this unit's cgroup then lets that restart kill the package
	// transaction itself. PID 1 owns this service, and the next backend process
	// reattaches to its durable output instead of relaunching apt.
	void monitor.finish(
		capable
			? runDetachedAptAll(detachedArgs, finalFamily, monitor.handlers)
			: runDetachedAptUpgrade(args, monitor.handlers),
		capable ? onCommitSucceeded : undefined,
	);
}

function refuseUnknownPackageInstall(): void {
	lastUpdateFailure = { reason: "discovery_failed" };
	softUpdateStatus = null;
	broadcastMsg("status", { updating: null, update_state: getUpdateState() });
}

/**
 * What the last recovery attempt established about the detached install unit.
 * `false` from recovery covers both a unit proven gone and a probe that never
 * ran (updates disabled, mocks, a transaction already observed), and only the
 * first may be read as "nothing survived the restart".
 */
export type InstallUnitVerdict = "attached" | "absent" | "not-probed";

let lastInstallUnitVerdict: InstallUnitVerdict = "not-probed";

export function getLastInstallUnitVerdict(): InstallUnitVerdict {
	return lastInstallUnitVerdict;
}

async function recoverSoftwareUpdate(
	deps: SoftwareUpdateRecoveryDeps = defaultSoftwareUpdateRecoveryDeps,
	ownership?: Promise<boolean>,
): Promise<boolean> {
	// One recovery per unit: a later caller gets the answer and changes nothing.
	if (lastInstallUnitVerdict === "attached") return true;
	// This process already published its outcome or still owns its transaction.
	if (pendingPackageSuccess.pending) return false;
	// Reset first: a throwing probe must not leave an older attempt's verdict.
	lastInstallUnitVerdict = "not-probed";
	if (isUpdating()) return false;
	// Mock mode never launches a detached unit. With updates disabled CeraUI
	// starts none and never probes (the deferred download stays unproven).
	if (shouldUseMocks() || !aptUpdatesEnabled()) {
		settleSoftwareUpdateRecovery();
		return false;
	}

	// Watched at once. With `ownership` (startup's verdict) given, retiring the
	// unit, cleaning the cache and restarting wait until it is true.
	const monitor = createSoftwareUpdateProcessMonitor(
		"",
		ownership ? { ownership, exitHook: getRecoveredUpdateExitHook } : {},
	);
	// With ownership pending the hook is read at hand-over, never at attach.
	const exitHook = ownership ? undefined : getRecoveredUpdateExitHook();
	const recovered = await deps.recover(
		{
			...monitor.handlers,
			onAttached: (aptStatus) => {
				softUpdateStatus = {
					total: 0,
					downloading: 0,
					unpacking: 0,
					setting_up: 0,
				};
				lastUpdateFailure = null;
				lastUpdateSucceeded = false;
				lastPreflightFailure = null;
				lastCleanupWarning = undefined;
				logger.warn(
					"Software update: reattached to the detached apt transaction",
				);
				monitor.handlers.onAttached?.(aptStatus);
			},
		},
		undefined,
		{ retire: ownership ?? true },
	);
	// `null`: no unit, or one whose exit tells the current attempt nothing.
	if (!recovered) {
		lastInstallUnitVerdict = "absent";
		if (softUpdateRecoveryPending) {
			settleSoftwareUpdateRecovery();
			// A tab that kept its overlay across the restart learns it is over.
			broadcastMsg("status", {
				updating: null,
				update_state: getUpdateState(),
			});
		}
		return false;
	}
	if ("recorded" in recovered) {
		// Once per boot: a later recovery call finds the hold already settled.
		if (recovered.unit === "absent" && !softUpdateRecoveryPending) return false;
		lastInstallUnitVerdict =
			recovered.unit === "finished" ? "attached" : "absent";
		adoptRecordedOutcome(recovered.recorded.exitCode);
		if (recovered.unit === "finished")
			logger.warn(
				"Software update: a finished unit whose exit is already recorded is not adopted again",
			);
		settleSoftwareUpdateRecovery();
		// A tab that missed the result across the restarts learns it now.
		broadcastMsg("status", {
			updating: null,
			update_state: getUpdateState(),
		});
		return recovered.unit === "finished";
	}
	lastInstallUnitVerdict = "attached";

	if (recovered.wasAlreadyFinished) {
		// Only a bounded final drain + cleanup remain (no poll loop) — awaiting
		// it here is what makes getUpdateState() authoritative the instant this
		// function returns, instead of leaving a window where the unit is
		// already gone from systemd's view but its outcome is not yet recorded.
		// That window is exactly what let the update-orchestrator's own resume
		// (resume.ts resumeCommitting()) observe neither a live nor a settled
		// state and misclassify a successful recovery as unresolved.
		await monitor.finish(recovered.completion, exitHook);
	} else {
		// Still running: this can take minutes. Never block boot on it.
		void monitor.finish(recovered.completion, exitHook);
	}
	return true;
}

export function recoverSoftwareUpdateIfRunning(
	deps: SoftwareUpdateRecoveryDeps = defaultSoftwareUpdateRecoveryDeps,
	/** Startup's verdict: until it is true the unit is only watched. */
	ownership?: Promise<boolean>,
): Promise<boolean> {
	return recoverSoftwareUpdateWithCoordination({
		attempt: () => recoverSoftwareUpdate(deps, ownership),
		scheduleRetry: deps.scheduleRetry,
		resumePeriodicChecks: deps.resumePeriodicChecks,
		reportRetryError: (error) => {
			logger.warn("Software update recovery probe will retry", { error });
		},
	});
}
