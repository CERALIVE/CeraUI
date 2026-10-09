import { currentLifecycleHolder } from "../../streaming/lifecycle-admission.ts";
import { getIsStreaming } from "../../streaming/streaming.ts";
import type {
	RankedTransport,
	TransportSelection,
} from "../update-transport/core.ts";
import {
	UpdatePinError,
	UpdateTransferError,
	updatePinController,
} from "../update-transport/pin.ts";
import type { OsChannelManifest } from "./os-manifest.ts";
import type { ObservationReport } from "./os-stage-admission-diagnostics.ts";
import {
	observeAdmission,
	UNTRACKED_OBSERVATION,
} from "./os-stage-admission-snapshot.ts";
import {
	beginOsStageAttempt,
	type OsStageControl,
} from "./os-stage-attempt.ts";
import {
	acquireOsStageControlLease,
	type OsStageControlLease,
} from "./os-stage-control-lease.ts";
import { OsStageError } from "./os-stage-error.ts";
import { createOsStageJobOwner } from "./os-stage-job.ts";
import { observeRaucStage } from "./os-stage-observation.ts";
import type { RaucStageSnapshot } from "./os-stage-recovery.ts";
import {
	acquireOrSettleOsStage,
	assertOsStageToken,
	settleUnlaunchedOsStageFailure,
	withOsStageRunControl,
} from "./os-stage-run-control.ts";
import { settlePinnedOsAttempt } from "./os-stage-settlement.ts";
import { killAndRestartRaucForStream } from "./stream-abort.ts";

export type OsStageRunControl = OsStageControl & {
	readonly cellularApproved?: boolean;
	readonly canCommit?: () => boolean;
};
export type OsStageRunDeps<T> = {
	readonly acquireControl?: typeof acquireOsStageControlLease;
	readonly selection: () => Promise<TransportSelection>;
	readonly revalidate: () => Promise<void>;
	readonly pin: typeof updatePinController;
	readonly owner: typeof createOsStageJobOwner;
	readonly attempt: typeof beginOsStageAttempt;
	readonly observe: typeof observeRaucStage;
	readonly restart: () => Promise<void>;
	readonly blocked: () => Promise<boolean>;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly prepareReceipt: () => Promise<() => T>;
	readonly progress: (percent: number) => void;
	readonly readProgress: () => Promise<number | null>;
};

export { assertOsStageToken } from "./os-stage-run-control.ts";

export async function runOsStageJob<T>(
	manifest: OsChannelManifest,
	control: OsStageRunControl,
	deps: OsStageRunDeps<T>,
): Promise<T> {
	return withOsStageRunControl(control, deps.acquireControl, (guarded, lease) =>
		runLeasedOsStageJob(manifest, guarded, { ...deps, lease }),
	);
}

async function runLeasedOsStageJob<T>(
	manifest: OsChannelManifest,
	control: OsStageRunControl,
	deps: OsStageRunDeps<T> & { readonly lease: OsStageControlLease },
): Promise<T> {
	assertOsStageToken(control);
	const baseline = await observeAdmission((report) =>
		deps.observe(UNTRACKED_OBSERVATION, undefined, report),
	);
	assertOsStageToken(control);
	const owner = deps.owner({
		schema: 1,
		attemptId: control.attemptId,
		candidateKey: JSON.stringify(manifest),
		bundleUrl: manifest.bundle.url,
		baseline,
		processes: [...baseline.processes],
		resources: [],
		launched: false,
		cliSettled: true,
		requireNewInstance: false,
	});
	const failure = {
		owner,
		lease: deps.lease,
		effects: { observe: deps.observe, sweep: () => deps.pin.sweep() },
	};
	await acquireOrSettleOsStage(failure);
	let proof: RaucStageSnapshot | null = baseline;
	let approvalRequired = false;
	let observationGeneration = 0;
	const unsafe = Promise.withResolvers<never>();
	const drainage = Promise.withResolvers<{ readonly error?: unknown }>();
	const admit = async () => {
		assertOsStageToken(control);
		if (await deps.blocked())
			throw new OsStageError("os_stage_cancelled_for_stream");
		assertOsStageToken(control);
	};
	const capture = async (report?: ObservationReport) => {
		const generation = observationGeneration;
		const { processes, resources } = owner.record();
		const tracked = {
			processes: new Set(processes),
			resources: new Set(resources),
		};
		const snapshot = await deps.observe(tracked, undefined, report);
		if (generation !== observationGeneration) return null;
		const latest = owner.record();
		if (snapshot)
			owner.remember(
				snapshot,
				latest.launched,
				latest.cliSettled,
				latest.requireNewInstance,
			);
		return snapshot;
	};
	try {
		await admit();
		const initial = await deps.selection();
		await admit();
		const pinned = deps.pin.run(
			"os",
			initial,
			async (transport: RankedTransport) => {
				await admit();
				try {
					await deps.revalidate();
				} catch (cause) {
					assertOsStageToken(control);
					if (cause instanceof OsStageError) throw cause;
					throw new OsStageError("rauc_install_failed", { cause });
				}
				await admit();
				const before = await observeAdmission(capture, baseline);
				await admit();
				if (!(await owner.held()))
					throw new OsStageError("rauc_recovery_unproven");
				await admit();
				owner.beginAttempt(
					before,
					`${transport.candidate.ifname}/${transport.family}`,
				);
				proof = null;
				await settlePinnedOsAttempt({
					url: manifest.bundle.url,
					transport,
					control,
					before,
					owner,
					deps,
					admit,
					capture,
					generation: () => observationGeneration,
					invalidate: () => ++observationGeneration,
					confirmed: (snapshot) => {
						proof = snapshot;
					},
					unsafe: (error) => unsafe.reject(error),
					drain: drainage.promise.then(({ error }) => {
						if (error instanceof AggregateError) throw error;
					}),
				});
			},
			{
				checkCancelled: () => assertOsStageToken(control),
				approveMetered: (transport) => {
					const allowed =
						!transport.candidate.metered || control.cellularApproved === true;
					if (!allowed) approvalRequired = true;
					return allowed;
				},
				refreshSelection: async () => {
					await admit();
					const selection = await deps.selection();
					await admit();
					return selection;
				},
			},
		);
		void pinned.then(
			() => drainage.resolve({}),
			(error: unknown) => drainage.resolve({ error }),
		);
		await Promise.race([pinned, unsafe.promise]);
		await admit();
		const commit = await deps.prepareReceipt();
		await admit();
		proof = await observeAdmission(capture, baseline);
		await admit();
		if (!proof) throw new OsStageError("rauc_recovery_unproven");
		let result: T | undefined;
		await owner.release(proof, true, () => {
			assertOsStageToken(control);
			try {
				result = commit();
			} catch (cause) {
				throw new OsStageError("rauc_recovery_unproven", { cause });
			}
		});
		if (result === undefined) throw new OsStageError("rauc_recovery_unproven");
		return result;
	} catch (cause) {
		await settleUnlaunchedOsStageFailure(failure, cause);
		if (
			cause instanceof AggregateError ||
			(cause instanceof OsStageError && cause.mode === "unsafe")
		)
			throw new OsStageError("rauc_recovery_unproven", { cause });
		if (!proof) throw new OsStageError("rauc_recovery_unproven", { cause });
		const fresh = await capture();
		if (!fresh) throw new OsStageError("rauc_recovery_unproven", { cause });
		await owner.release(fresh, true);
		assertOsStageToken(control);
		if (cause instanceof OsStageError) throw cause;
		if (
			approvalRequired &&
			(cause instanceof UpdateTransferError || cause instanceof UpdatePinError)
		)
			throw new OsStageError("os_cellular_approval_required", { cause });
		if (cause instanceof UpdateTransferError)
			throw new OsStageError("os_transport_failed", {
				cause,
				diagnostics: { attemptedPairs: cause.attemptedPairs.join(",") },
			});
		throw new OsStageError("rauc_install_failed", { cause });
	}
}

export const defaultOsStageRunEffects = {
	acquireControl: acquireOsStageControlLease,
	pin: updatePinController,
	owner: createOsStageJobOwner,
	attempt: beginOsStageAttempt,
	observe: observeRaucStage,
	restart: killAndRestartRaucForStream,
	blocked: async () =>
		getIsStreaming() ||
		currentLifecycleHolder() === "streaming" ||
		(await Bun.file("/run/ceralive/streaming").exists()),
	now: () => performance.now(),
	sleep: (ms: number) => Bun.sleep(ms),
};
