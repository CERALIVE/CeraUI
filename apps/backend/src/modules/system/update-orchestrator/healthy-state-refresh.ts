import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import { KernelUpdateError } from "./kernel-state.ts";
import { inspectSlotSync, startSlotSync } from "./lock.ts";
import { readSlotSyncEvidence } from "./slot-sync-state.ts";

const HEALTHCHECK_UNIT = "ceralive-healthcheck.service";
const RESTART_TIMEOUT_MS = 180_000;
const SETTLE_TIMEOUT_MS = 15 * 60_000;
const POLL_MS = 2_000;
// A mirror that refuses or finishes instantly is never seen running.
const MIRROR_START_GRACE_MS = 15_000;

export type HealthyStateRefreshDeps = {
	readonly matches: () => Promise<boolean>;
	readonly restartHealthcheck: () => Promise<boolean>;
	readonly startMirror: () => Promise<void>;
	readonly mirrorState: () => Promise<"running" | "failed" | "idle">;
	readonly sleep: (ms: number) => Promise<void>;
	readonly now: () => number;
};

/** Mirrors the image stager's gate: boot id, build id and dpkg status must equal the healthcheck record. */
export async function healthyStateMatchesBoot(): Promise<boolean> {
	try {
		const evidence = await readSlotSyncEvidence();
		const recorded = evidence.healthyState;
		return (
			recorded !== null &&
			recorded.boot_id === evidence.bootId &&
			recorded.build_id === evidence.buildId &&
			recorded.dpkg_status_sha256 === evidence.statusSha256
		);
	} catch {
		return false;
	}
}

export async function restartHealthcheck(): Promise<boolean> {
	const result = await spawnWithTimeout(
		["systemctl", "restart", HEALTHCHECK_UNIT],
		{ timeoutMs: RESTART_TIMEOUT_MS },
	);
	return result.exitCode === 0;
}

const defaultDeps: HealthyStateRefreshDeps = {
	matches: healthyStateMatchesBoot,
	restartHealthcheck,
	startMirror: startSlotSync,
	mirrorState: async () => {
		try {
			const probe = await inspectSlotSync();
			if (probe.kind === "running") return "running";
			return probe.kind === "failed" || probe.kind === "refused"
				? "failed"
				: "idle";
		} catch {
			return "running"; // unreadable: keep waiting rather than assume it is quiet
		}
	},
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: Date.now,
};

// A timed-out or unspawnable command is a staging failure, not a download failure.
async function guarded<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (cause) {
		throw new KernelUpdateError("kernel_staging_failed", { cause });
	}
}

/** Re-runs the healthcheck (which re-verifies before recording) when the record is stale; the stager's gate stays the authority. */
export async function ensureHealthyStateForStage(
	deps: HealthyStateRefreshDeps = defaultDeps,
): Promise<void> {
	if (await deps.matches()) return;
	if (!(await guarded(deps.restartHealthcheck)))
		throw new KernelUpdateError("kernel_staging_failed");
	const started = deps.now();
	const deadline = started + SETTLE_TIMEOUT_MS;
	// Own the follow-up mirror so CeraUI's scheduler cannot take the update lock
	// between the refresh and the stager's non-blocking lock attempt.
	await guarded(deps.startMirror);
	let sawRunning = false;
	for (;;) {
		const mirror = await deps.mirrorState();
		if (mirror === "running") sawRunning = true;
		else if (sawRunning || deps.now() - started >= MIRROR_START_GRACE_MS) {
			// The healthcheck already refreshed the record, so a mirror that failed
			// without ever being seen running must not pass on the record alone.
			if (mirror === "failed")
				throw new KernelUpdateError("kernel_staging_failed");
			if (await deps.matches()) return;
			throw new KernelUpdateError("kernel_staging_failed");
		}
		if (deps.now() >= deadline)
			throw new KernelUpdateError("kernel_staging_failed");
		await deps.sleep(POLL_MS);
	}
}
