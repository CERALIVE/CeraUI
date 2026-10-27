import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
	UpdateCapabilities,
	UpdateDetails,
	UpdateSettings,
} from "@ceraui/rpc/schemas";
import {
	hasKernelAptStage,
	readUpdateCapabilityFile,
} from "../update-capabilities.ts";
import {
	downloadKernelPackage,
	type KernelPackageRecord,
	readAuthenticatedKernelPackages,
	readBootedKernel,
	selectKernelPackage,
} from "./kernel-packages.ts";
import { judgeKernelState } from "./kernel-recovery.ts";
import {
	armKernelActivation,
	inspectKernelStage,
	type KernelAttempt,
	launchKernelStage,
} from "./kernel-stage-job.ts";
import {
	acknowledgeKernelState,
	KernelUpdateError,
	kernelPending,
	readKernelQuarantine,
	readKernelState,
	readSlotOverlay,
} from "./kernel-state.ts";
import { notifyUpdate } from "./notifications.ts";
import { decideCellularGate } from "./schedule.ts";
import type { OrchestratorPhase, OrchestratorState } from "./types.ts";

export const KERNEL_ACTIVATION_ESCALATION_MS = 7 * 24 * 60 * 60_000;
export const defaultKernelEffects = {
	readState: readKernelState,
	readOverlay: readSlotOverlay,
	readBooted: readBootedKernel,
	discover: async (caps: UpdateCapabilities) => {
		if (!hasKernelAptStage(caps)) return null;
		return selectKernelPackage(
			caps,
			await readAuthenticatedKernelPackages(),
			await readBootedKernel(),
			await readKernelQuarantine(),
		);
	},
	download: async (record: KernelPackageRecord, signal: AbortSignal) => {
		const caps = await readUpdateCapabilityFile();
		if (!caps?.features.includes("kernel-apt-stage"))
			throw new KernelUpdateError("kernel_download_failed");
		const directory = await mkdtemp(join(tmpdir(), "ceraui-kernel-"));
		try {
			return await downloadKernelPackage(
				record,
				caps.apt_uid,
				directory,
				signal,
			);
		} catch (error) {
			await rm(directory, { recursive: true, force: true });
			throw error;
		}
	},
	launch: launchKernelStage,
	inspect: inspectKernelStage,
	arm: armKernelActivation,
	acknowledge: acknowledgeKernelState,
	removeDownload: async (attempt: KernelAttempt) => {
		if (!attempt.deb) return;
		const directory = dirname(attempt.deb);
		if (
			resolve(attempt.deb) !== attempt.deb ||
			dirname(directory) !== tmpdir() ||
			!/^ceraui-kernel-[A-Za-z0-9]+$/.test(basename(directory))
		)
			throw new KernelUpdateError("kernel_download_ownership_unknown");
		await rm(directory, { recursive: true, force: true });
	},
	notify: notifyUpdate,
};
export type KernelEffects = typeof defaultKernelEffects;
export type KernelRuntimePort = {
	readonly effects: () => KernelEffects;
	readonly state: () => OrchestratorState;
	readonly set: (patch: Partial<OrchestratorState>) => void;
	readonly now: () => number;
	readonly capabilities: () => Promise<UpdateCapabilities>;
	readonly settings: () => Promise<UpdateSettings>;
	readonly idle: (schedule: UpdateSettings["schedule"]) => Promise<boolean>;
	readonly metered: () => Promise<boolean>;
	readonly busy: () => boolean;
	readonly bootedSlot: () => Promise<string>;
	readonly activate: (
		now: boolean,
		action: () => Promise<void>,
	) => Promise<boolean>;
};
const openPhases: readonly OrchestratorPhase[] = [
	"kernel-downloading",
	"kernel-staging",
	"kernel-staged",
	"kernel-verifying",
];

export function createKernelRuntime(port: KernelRuntimePort) {
	let candidate: KernelPackageRecord | null = null;
	let flight: AbortController | null = null;
	let record: Awaited<ReturnType<KernelEffects["readState"]>> = null;
	let forced: string | null = null;
	let reconciling: Promise<boolean> | null = null;
	const publish = (
		phase: OrchestratorPhase,
		failureReason: string | null = null,
	) => {
		if (
			port.state().phase !== phase ||
			port.state().failureReason !== failureReason
		)
			port.set({ phase, failureReason, progress: null, enteredAt: port.now() });
	};
	async function check(): Promise<void> {
		const before = port.state();
		const caps = await port.capabilities();
		const found = hasKernelAptStage(caps)
			? await port.effects().discover(caps)
			: null;
		if (port.state() === before) candidate = found;
	}
	async function install(manual: boolean): Promise<boolean> {
		if (
			flight ||
			port.busy() ||
			!["idle", "available", "os-available"].includes(port.state().phase)
		)
			return false;
		if (!manual && !candidate) return false;
		const caps = await port.capabilities();
		if (!hasKernelAptStage(caps)) return false;
		const settings = await port.settings();
		if (
			!manual &&
			(!settings.systemAuto || !(await port.idle(settings.schedule)))
		)
			return false;
		// Re-read authenticated records and quarantine; an old offer is not install authority.
		const fresh = await port.effects().discover(caps);
		if (!fresh || kernelPending(await port.effects().readState())) return false;
		const gate = decideCellularGate({
			onlyMeteredCandidateExists: await port.metered(),
			kind: "os",
			stage: "install",
			allowPackagesOverCellular: settings.allowPackagesOverCellular,
			allowSystemOverCellular: settings.allowSystemOverCellular,
			cellularOverrideId: port.state().cellularOverrideId,
			candidateId: fresh.version,
		});
		if (!gate.allowed) {
			if (gate.needsOverride)
				port.effects().notify({
					kind: "cellular-approval",
					id: fresh.version,
					size: String(fresh.size),
				});
			return false;
		}
		if (
			flight ||
			port.busy() ||
			!["idle", "available", "os-available"].includes(port.state().phase)
		)
			return false;
		candidate = fresh;
		const controller = new AbortController();
		flight = controller;
		let attempt: KernelAttempt = {
			id: randomUUID(),
			package: fresh.package,
			version: fresh.version,
			deb_sha256: fresh.deb_sha256,
			deb: null,
		};
		try {
			port.set({
				kernelAttempt: attempt,
				phase: "kernel-downloading",
				enteredAt: port.now(),
				failureReason: null,
				progress: null,
				cellularOverrideId: null,
			});
			const deb = await port.effects().download(fresh, controller.signal);
			attempt = { ...attempt, deb };
			if (
				controller.signal.aborted ||
				flight !== controller ||
				port.state().phase !== "kernel-downloading"
			) {
				await port.effects().removeDownload(attempt);
				return false;
			}
			// Persist exact argv identity before PID 1 can create the writer.
			port.set({
				kernelAttempt: attempt,
				phase: "kernel-staging",
				enteredAt: port.now(),
			});
			await port.effects().launch(attempt);
			candidate = null;
			return true;
		} catch (error) {
			if (!controller.signal.aborted && flight === controller) {
				candidate = null;
				if (attempt.deb && port.state().phase === "kernel-staging") {
					// A lost submission reply cannot prove that PID 1 did not start the writer.
					publish("kernel-staging", "kernel_stage_ownership_unknown");
					return false;
				}
				const reason =
					error instanceof KernelUpdateError
						? error.reason
						: "kernel_download_failed";
				publish("kernel-failed", reason);
				port.effects().notify({ kind: "refused", id: attempt.id, reason });
			}
			return false;
		} finally {
			if (flight === controller) flight = null;
		}
	}
	async function reconcile(): Promise<boolean> {
		if (flight) return true;
		const effects = port.effects();
		record = await effects.readState();
		const phase = port.state().phase;
		const attempt = port.state().kernelAttempt;
		const matching = record && (!attempt || record.attempt === attempt.id);
		const observation = attempt?.deb
			? await effects.inspect(attempt)
			: { kind: "absent" as const };
		if (observation.kind === "running") {
			publish("kernel-staging");
			return true;
		}
		if (!matching || !record) {
			if (openPhases.includes(phase))
				publish(
					"kernel-failed",
					observation.kind === "terminal"
						? "kernel_staging_failed"
						: "kernel_interrupted",
				);
			else if (phase.startsWith("kernel-")) publish("idle");
			return openPhases.includes(port.state().phase);
		}
		if (record.acknowledged && !kernelPending(record)) {
			if (phase.startsWith("kernel-")) publish("idle");
			return false;
		}
		if (!phase.startsWith("kernel-") && port.busy())
			return kernelPending(record);
		const overlay = await effects.readOverlay(record.target_slot);
		const verdict = judgeKernelState(
			record,
			await port.bootedSlot(),
			await effects.readBooted(),
			overlay,
		);
		if (record.state === "staging" && observation.kind === "absent") {
			publish("kernel-failed", "kernel_interrupted");
			return true; // Device startup recovery must invalidate the slot before reopening admission.
		}
		if (
			record.state === "staged" &&
			observation.kind === "terminal" &&
			observation.exitCode !== 0
		) {
			publish("kernel-failed", "kernel_staging_failed");
			return true;
		}
		const alreadyTerminal =
			phase === verdict.phase &&
			["kernel-succeeded", "kernel-rolled-back", "kernel-failed"].includes(
				phase,
			);
		publish(verdict.phase, verdict.reason);
		if (verdict.phase === "kernel-staged") {
			effects.notify({
				kind: "kernel-staged",
				id: record.attempt,
				version: record.version,
			});
			const staged = record.timestamps.staged;
			if (staged === undefined)
				throw new KernelUpdateError("kernel_staged_timestamp_missing");
			const now =
				port.now() - Date.parse(staged) >= KERNEL_ACTIVATION_ESCALATION_MS &&
				forced !== record.attempt;
			if (record.state === "staged" || now) {
				const submitted = await port.activate(now, () => effects.arm(now));
				if (now && submitted) forced = record.attempt;
			}
		}
		if (!kernelPending(record) && verdict.phase !== "kernel-verifying") {
			if (
				verdict.phase === "kernel-succeeded" ||
				verdict.phase === "kernel-rolled-back"
			)
				effects.notify({
					kind: verdict.phase,
					id: record.attempt,
					version: record.version,
				});
			else
				effects.notify({
					kind: "refused",
					id: record.attempt,
					reason: verdict.reason ?? "kernel_staging_failed",
				});
			if (alreadyTerminal) {
				effects.acknowledge(record.attempt);
				if (attempt) await effects.removeDownload(attempt);
				publish("idle");
				return false;
			}
		}
		return true;
	}
	return {
		check,
		install,
		reconcile: () => {
			reconciling ??= reconcile().finally(() => {
				reconciling = null;
			});
			return reconciling;
		},
		cancelDownload: () => {
			if (port.state().phase !== "kernel-downloading") return;
			flight?.abort();
			publish("idle");
		},
		busy: () =>
			flight !== null ||
			kernelPending(record) ||
			openPhases.includes(port.state().phase),
		summary: async (): Promise<NonNullable<UpdateDetails["kernel"]>> => ({
			booted: await port.effects().readBooted(),
			candidate: candidate
				? {
						package: candidate.package,
						version: candidate.version,
						sizeBytes: candidate.size,
					}
				: null,
			state: record?.state ?? null,
			version: record?.version ?? null,
			reason: record?.reason ?? null,
		}),
		reset: () => {
			flight?.abort();
			flight = null;
			candidate = null;
			record = null;
			forced = null;
		},
	};
}
