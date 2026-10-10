// allow: SIZE_OK — One leased stage lifetime shares cancellation, pin drainage and release authority across this coordinated loop.
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
import {
	type ReceiptFileIdentity,
	readReceiptFile,
} from "./os-receipt-file-identity.ts";
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
import { withinStageDeadline } from "./os-stage-deadline.ts";
import { OsStageError } from "./os-stage-error.ts";
import { createOsStageJobOwner } from "./os-stage-job.ts";
import { observeRaucStage } from "./os-stage-observation.ts";
import { OsStageUnpublishedSuccessError } from "./os-stage-outcome-error.ts";
import {
	type RaucStageSnapshot,
	raucQuiescenceRefusal,
} from "./os-stage-recovery.ts";
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
	readonly readReceiptBaseline?: () => ReceiptFileIdentity | null;
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
	const baseline = await observeAdmission(
		(report) => deps.observe(UNTRACKED_OBSERVATION, undefined, report),
		undefined,
		{
			...deps,
			deadline: deps.now() + 10_000,
			assert: async () => {
				if (!deps.lease.held())
					throw new OsStageError("rauc_recovery_unproven");
				assertOsStageToken(control);
			},
		},
	);
	assertOsStageToken(control);
	const receiptBaseline = (
		deps.readReceiptBaseline ?? (() => readReceiptFile()?.identity ?? null)
	)();
	const owner = deps.owner({
		schema: 1,
		attemptId: control.attemptId,
		candidateKey: JSON.stringify(manifest),
		bundleUrl: manifest.bundle.url,
		baseline,
		receiptBaseline,
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
	let recoveryDeadline: number | undefined;
	let proofDeadline = deps.now() + 10_000;
	let cliSucceeded = false;
	const assertDispatch = () => {
		if (cliSucceeded)
			throw new OsStageUnpublishedSuccessError(
				new OsStageError("rauc_recovery_unproven"),
			);
		assertOsStageToken(control);
	};
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
		await owner.assertAuthority?.();
		if (generation !== observationGeneration) return null;
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
	const freshProof = async (
		transport?: RankedTransport,
		checkDispatch = true,
	) => {
		const deadline = recoveryDeadline ?? deps.now() + 10_000;
		proofDeadline = deadline;
		let lockHeld = false;
		let episodeLogs = 0;
		const assert = async () => {
			await owner.assertAuthority?.();
			lockHeld = await owner.held();
			if (!deps.lease.held() || !lockHeld)
				throw new OsStageError("rauc_recovery_unproven");
			if (checkDispatch) await admit();
		};
		let deferred = false;
		let current: RaucStageSnapshot;
		do {
			deferred = false;
			current = await observeAdmission(capture, baseline, {
				...deps,
				deadline,
				assert,
				logEpisode: () => ++episodeLogs <= 16,
				invalidate: () => {
					++observationGeneration;
				},
				finalAssert: () => {
					if (!deps.lease.held())
						throw new OsStageError("rauc_recovery_unproven");
					if (checkDispatch) assertOsStageToken(control);
				},
				previousInstance: owner.record().baseline.instance,
				deferred: () => {
					deferred = true;
				},
				quiescence: async (snapshot) => {
					const record = owner.record();
					return raucQuiescenceRefusal({
						ownership: {
							baseline: record.baseline,
							processes: new Set(record.processes),
							resources: new Set(record.resources),
						},
						current: snapshot,
						cliSettled: record.cliSettled,
						lockHeld: await owner.held(),
						requireNewInstance: record.requireNewInstance,
					});
				},
				finalQuiescence: (snapshot) => {
					const record = owner.record();
					return raucQuiescenceRefusal({
						ownership: {
							baseline: record.baseline,
							processes: new Set(record.processes),
							resources: new Set(record.resources),
						},
						current: snapshot,
						cliSettled: record.cliSettled,
						lockHeld,
						requireNewInstance: record.requireNewInstance,
					});
				},
			});
			if (deferred && transport) {
				const budget = {
					deadline,
					now: deps.now,
					invalidate: () => {
						++observationGeneration;
					},
				};
				await withinStageDeadline(budget, deps.revalidate);
				const selection = await withinStageDeadline(budget, deps.selection);
				if (
					!selection.ranked.some(
						(row) =>
							row.healthy &&
							row.candidate.ifname === transport.candidate.ifname &&
							row.family === transport.family,
					)
				)
					throw new OsStageError("os_transport_failed");
				await withinStageDeadline(budget, assert);
			}
		} while (deferred && transport);
		if (deps.now() >= deadline)
			throw new OsStageError("rauc_recovery_unproven", {
				diagnostics: { refusal: "deadline-expired" },
			});
		return current;
	};
	try {
		await admit();
		const initial = await deps.selection();
		await admit();
		const pinned = deps.pin.run(
			"os",
			initial,
			async (transport: RankedTransport) => {
				assertDispatch();
				await admit();
				try {
					await deps.revalidate();
				} catch (cause) {
					assertOsStageToken(control);
					if (cause instanceof OsStageError) throw cause;
					throw new OsStageError("rauc_install_failed", { cause });
				}
				await admit();
				const before = await freshProof(transport);
				assertDispatch();
				if (!deps.lease.held())
					throw new OsStageError("rauc_recovery_unproven");
				if (deps.now() >= proofDeadline)
					throw new OsStageError("rauc_recovery_unproven", {
						diagnostics: { refusal: "deadline-expired" },
					});
				if (Date.now() >= Date.parse(manifest.expires_at))
					throw new OsStageError("rauc_install_failed", {
						diagnostics: { refusal: "signed-candidate-expired" },
					});
				owner.beginAttempt(
					before,
					`${transport.candidate.ifname}/${transport.family}`,
				);
				proof = null;
				recoveryDeadline = undefined;
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
					confirmed: (snapshot, deadline) => {
						proof = snapshot;
						recoveryDeadline = deadline;
					},
					unsafe: (error) => unsafe.reject(error),
					successful: () => {
						cliSucceeded = true;
					},
					drain: drainage.promise.then(({ error }) => {
						if (error instanceof AggregateError) throw error;
					}),
				});
			},
			{
				checkCancelled: assertDispatch,
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
		proof = await freshProof();
		await admit();
		if (!proof) throw new OsStageError("rauc_recovery_unproven");
		let result: T | undefined;
		await owner.release(proof, true, () => {
			assertOsStageToken(control);
			if (recoveryDeadline !== undefined && deps.now() >= recoveryDeadline)
				throw new OsStageError("rauc_recovery_unproven", {
					diagnostics: { refusal: "deadline-expired" },
				});
			try {
				result = commit();
			} catch (cause) {
				throw new OsStageError("rauc_recovery_unproven", { cause });
			}
		});
		if (result === undefined) throw new OsStageError("rauc_recovery_unproven");
		return result;
	} catch (cause) {
		++observationGeneration;
		await settleUnlaunchedOsStageFailure(failure, cause);
		if (
			cause instanceof AggregateError ||
			(cause instanceof OsStageError && cause.mode === "unsafe")
		)
			throw cliSucceeded
				? new OsStageUnpublishedSuccessError(cause)
				: new OsStageError("rauc_recovery_unproven", { cause });
		const settled = owner.record();
		const unpublishedSuccess =
			cliSucceeded ||
			(settled.launched && settled.cliSettled && !settled.requireNewInstance);
		if (!proof) throw new OsStageError("rauc_recovery_unproven", { cause });
		const fresh = await freshProof(undefined, false);
		await owner.release(fresh, true, () => {
			if (!deps.lease.held() || deps.now() >= proofDeadline)
				throw new OsStageError("rauc_recovery_unproven");
		});
		if (unpublishedSuccess) throw new OsStageUnpublishedSuccessError(cause);
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
