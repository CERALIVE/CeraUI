import { logger } from "../../../helpers/logger.ts";
import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import { updatePinController } from "../update-transport/pin.ts";
import {
	acquireOsStageControlLease,
	type OsStageControlLease,
} from "./os-stage-control-lease.ts";
import { OsStageError } from "./os-stage-error.ts";
import { osInstallClientsGone } from "./os-stage-install-clients.ts";
import { createOsStageJobOwner } from "./os-stage-job.ts";
import { OS_STAGE_GUARD_UNIT, readOsStageJob } from "./os-stage-job-files.ts";
import { observeRaucStage } from "./os-stage-observation.ts";
import {
	defaultOsOrphanEffects,
	settleOsStageOrphan,
} from "./os-stage-orphan.ts";
import { drainRetainedOsStagePin } from "./os-stage-pin-retention.ts";
import { recoverOwnedOsStageAtStartup } from "./os-stage-startup-recovery.ts";
import { killAndRestartRaucForStream } from "./stream-abort.ts";

let admissionReady = false;
let inFlight: Promise<OsStartupSettlement> | undefined;
let liveProducer: () => string | null = () => null;
export function setOsStageLiveProducerProbe(probe: () => string | null): void {
	liveProducer = probe;
}
export function osUpdateAdmissionReady(): boolean {
	return admissionReady;
}
export function ensureOsUpdateAdmissionReady(
	hasUnsettledJob = false,
	overrides: Partial<OsStartupDeps> = {},
): boolean {
	if (hasUnsettledJob) admissionReady = false;
	if (!admissionReady && !inFlight) {
		void reconcileOsStageStartup(overrides).catch((error: unknown) => {
			logger.warn(
				"update-orchestrator: startup writer recovery remains unresolved",
				{ error },
			);
		});
	}
	return admissionReady;
}

export type OsStartupSettlement =
	| { readonly kind: "none" }
	| {
			readonly kind: "reconciled";
			readonly attemptId: string;
			readonly reason: "os_stage_outcome_unknown_after_restart";
	  };
export type OsStartupDeps = {
	readonly acquireControl?: typeof acquireOsStageControlLease;
	readonly readJob: typeof readOsStageJob;
	readonly run: typeof spawnWithTimeout;
	readonly owner: typeof createOsStageJobOwner;
	readonly observe: typeof observeRaucStage;
	readonly cliGone: (url?: string) => Promise<boolean>;
	readonly restart: () => Promise<void>;
	readonly sweep: () => Promise<void>;
	readonly drain: typeof drainRetainedOsStagePin;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly liveProducer?: () => string | null;
	readonly orphan?: (
		record: Awaited<ReturnType<typeof readOsStageJob>>,
		control?: OsStageControlLease,
	) => Promise<boolean>;
};

export { osInstallClientsGone } from "./os-stage-install-clients.ts";

const defaults: OsStartupDeps = {
	readJob: readOsStageJob,
	run: spawnWithTimeout,
	owner: createOsStageJobOwner,
	observe: observeRaucStage,
	cliGone: osInstallClientsGone,
	restart: killAndRestartRaucForStream,
	sweep: () => updatePinController.sweep(),
	drain: drainRetainedOsStagePin,
	now: () => performance.now(),
	sleep: (ms) => Bun.sleep(ms),
};

export function reconcileOsStageStartup(
	overrides: Partial<OsStartupDeps> = {},
): Promise<OsStartupSettlement> {
	if (inFlight) return inFlight;
	admissionReady = false;
	const deps = { ...defaults, ...overrides };
	const orphan =
		deps.orphan ??
		((record, control) =>
			settleOsStageOrphan(record, {
				...defaultOsOrphanEffects,
				sweep: deps.sweep,
				...(control ? { control } : {}),
				liveProducer: deps.liveProducer ?? liveProducer,
			}));
	const work = async (): Promise<OsStartupSettlement> => {
		await using control = await (
			deps.acquireControl ?? acquireOsStageControlLease
		)();
		if (!control.held()) throw new OsStageError("rauc_recovery_unproven");
		const record = await deps.readJob();
		if (
			record &&
			!record.launched &&
			(deps.liveProducer ?? liveProducer)() === null
		) {
			if (!(await orphan(record, control)))
				throw new OsStageError("rauc_recovery_unproven");
			admissionReady = true;
			return {
				kind: "reconciled",
				attemptId: record.attemptId,
				reason: "os_stage_outcome_unknown_after_restart",
			};
		}
		const unit = await deps.run(
			["systemctl", "show", OS_STAGE_GUARD_UNIT, "--property=LoadState"],
			{ timeoutMs: 2_000 },
		);
		if (unit.exitCode !== 0)
			throw new OsStageError("rauc_recovery_unproven", { cause: unit });
		const liveAttempt = (deps.liveProducer ?? liveProducer)();
		if (liveAttempt !== null) {
			if (record && record.attemptId !== liveAttempt)
				throw new OsStageError("rauc_recovery_unproven", {
					diagnostics: { refusal: "live-producer-conflict" },
				});
			admissionReady = true;
			return { kind: "none" };
		}
		if (!record) {
			if (unit.stdout.trim() !== "LoadState=not-found")
				throw new OsStageError("rauc_recovery_unproven", {
					diagnostics: { refusal: "foreign-or-unrecorded-guardian" },
				});
			if (!(await orphan(null, control))) await deps.sweep();
			admissionReady = true;
			return { kind: "none" };
		}
		const owner = deps.owner(record);
		if (unit.stdout.trim() === "LoadState=not-found" || !(await owner.held())) {
			if (!(await orphan(record, control)))
				throw new OsStageError("rauc_recovery_unproven");
			admissionReady = true;
			return {
				kind: "reconciled",
				attemptId: record.attemptId,
				reason: "os_stage_outcome_unknown_after_restart",
			};
		}
		const producerAfterOwnership = (deps.liveProducer ?? liveProducer)();
		if (producerAfterOwnership !== null) {
			if (producerAfterOwnership !== record.attemptId)
				throw new OsStageError("rauc_recovery_unproven", {
					diagnostics: { refusal: "live-producer-conflict" },
				});
			admissionReady = true;
			return { kind: "none" };
		}
		await recoverOwnedOsStageAtStartup(record, owner, deps);
		admissionReady = true;
		return {
			kind: "reconciled",
			attemptId: record.attemptId,
			reason: "os_stage_outcome_unknown_after_restart",
		};
	};
	inFlight = work()
		.catch((cause: unknown) => {
			if (cause instanceof OsStageError) throw cause;
			throw new OsStageError("rauc_recovery_unproven", { cause });
		})
		.finally(() => {
			inFlight = undefined;
		});
	return inFlight;
}

export async function isOsStageReady(): Promise<boolean> {
	if (!admissionReady || (await readOsStageJob())) return false;
	const snapshot = await observeRaucStage({
		processes: new Set(),
		resources: new Set(),
	});
	return (
		snapshot?.active === true &&
		snapshot.operation === "idle" &&
		snapshot.resources.length === 0 &&
		snapshot.processes.every((id) => id === snapshot.instance) &&
		snapshot.bootedHealthy &&
		snapshot.bootPrimary === snapshot.bootedSlot &&
		snapshot.bootPrimary !== snapshot.targetSlot &&
		snapshot.targetInactive &&
		!snapshot.activationArmed
	);
}

// Writer quiescence is not evidence that staging succeeded.
export async function proveOsWriterQuiescent(): Promise<boolean> {
	try {
		if (await readOsStageJob()) await reconcileOsStageStartup();
		return await isOsStageReady();
	} catch (error) {
		logger.warn("update-orchestrator: OS writer quiescence unproven", {
			error,
		});
		return false;
	}
}
