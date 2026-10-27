import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import { KernelUpdateError } from "./kernel-state.ts";
import { SOFTWARE_UPDATE_LOCK } from "./lock.ts";
import {
	parseOsStageSystemdProperties,
	parseSystemdExitFields,
} from "./os-stage-systemd.ts";
import type { OrchestratorState } from "./types.ts";

export type KernelAttempt = NonNullable<OrchestratorState["kernelAttempt"]>;
const STAGER = "/usr/lib/ceralive/ceralive-kernel-stage";
export function kernelStageUnit(attempt: KernelAttempt): string {
	return `ceralive-kernel-stage-${attempt.id}.service`;
}
export function kernelStageGuardArgv(attempt: KernelAttempt): string[] {
	if (!attempt.deb) throw new KernelUpdateError("kernel_staging_failed");
	return [
		"/usr/bin/flock",
		"-n",
		"-E",
		"75",
		"-x",
		SOFTWARE_UPDATE_LOCK,
		STAGER,
		"--attempt",
		attempt.id,
		"--deb",
		attempt.deb,
		"--package",
		attempt.package,
		"--version",
		attempt.version,
		"--sha256",
		attempt.deb_sha256,
	];
}
export function kernelStageCommand(attempt: KernelAttempt): string[] {
	return [
		"systemd-run",
		`--unit=${kernelStageUnit(attempt)}`,
		"--description=CeraLive kernel stage",
		"--service-type=exec",
		"--property=RemainAfterExit=yes",
		"--property=StandardOutput=null",
		"--property=StandardError=journal",
		"--property=RuntimeMaxSec=1800",
		...kernelStageGuardArgv(attempt),
	];
}

export async function launchKernelStage(
	attempt: KernelAttempt,
	run = spawnWithTimeout,
): Promise<void> {
	const result = await run(kernelStageCommand(attempt), { timeoutMs: 10_000 });
	if (result.exitCode !== 0)
		throw new KernelUpdateError("kernel_staging_failed");
}
export type KernelStageObservation =
	| { readonly kind: "absent" }
	| { readonly kind: "running" }
	| { readonly kind: "terminal"; readonly exitCode: number };

export function parseKernelStageObservation(
	output: string,
	attempt: KernelAttempt,
): KernelStageObservation {
	const rows = parseOsStageSystemdProperties(output);
	if (!rows) throw new KernelUpdateError("kernel_stage_ownership_unknown");
	if (rows.get("LoadState") === "not-found") return { kind: "absent" };
	const expected = {
		LoadState: "loaded",
		Id: kernelStageUnit(attempt),
		FragmentPath: `/run/systemd/transient/${kernelStageUnit(attempt)}`,
		Description: "CeraLive kernel stage",
		Transient: "yes",
		Type: "exec",
		RemainAfterExit: "yes",
		User: "",
		DropInPaths: "",
		Restart: "no",
	};
	const prefix = `{ path=/usr/bin/flock ; argv[]=${kernelStageGuardArgv(attempt).join(" ")}`;
	const exec = rows.get("ExecStart") ?? "";
	if (
		!Object.entries(expected).every(
			([key, value]) => rows.get(key) === value,
		) ||
		!["ExecStartPre", "ExecStartPost", "ExecStop", "ExecStopPost"].every(
			(key) => (rows.get(key) ?? "") === "",
		) ||
		!exec.startsWith(prefix) ||
		!/^ ; ignore_errors=no ; start_time=\[[^\]\n]*\] ; stop_time=\[[^\]\n]*\] ; pid=\d+ ; code=(?:\(null\)|exited|killed|dumped) ; status=\d+(?:\/[A-Za-z0-9_-]+)? }$/.test(
			exec.slice(prefix.length),
		)
	)
		throw new KernelUpdateError("kernel_stage_ownership_unknown");
	if (
		![
			"active",
			"inactive",
			"failed",
			"activating",
			"deactivating",
			"reloading",
		].includes(rows.get("ActiveState") ?? "")
	)
		throw new KernelUpdateError("kernel_stage_ownership_unknown");
	if (
		["activating", "deactivating", "reloading"].includes(
			rows.get("ActiveState") ?? "",
		) ||
		rows.get("MainPID") !== "0" ||
		rows.get("ControlPID") !== "0"
	)
		return { kind: "running" };
	const exit = parseSystemdExitFields(rows);
	if (!exit) throw new KernelUpdateError("kernel_stage_ownership_unknown");
	if (
		rows.get("ActiveState") === "failed" &&
		exit.mainCode === 1 &&
		exit.mainStatus === 0
	)
		throw new KernelUpdateError("kernel_stage_ownership_unknown");
	return {
		kind: "terminal",
		exitCode: exit.mainCode === 1 ? exit.mainStatus : 128 + exit.mainStatus,
	};
}

export async function inspectKernelStage(
	attempt: KernelAttempt,
	run = spawnWithTimeout,
): Promise<KernelStageObservation> {
	if (!attempt.deb) return { kind: "absent" };
	const result = await run(
		[
			"systemctl",
			"show",
			kernelStageUnit(attempt),
			"--property=LoadState,Id,FragmentPath,Description,Transient,Type,RemainAfterExit,User,DropInPaths,ExecStart,ExecStartPre,ExecStartPost,ExecStop,ExecStopPost,Restart,ActiveState,MainPID,ControlPID,ExecMainCode,ExecMainStatus",
		],
		{ timeoutMs: 2_000 },
	);
	if (result.exitCode !== 0)
		throw new KernelUpdateError("kernel_stage_ownership_unknown");
	return parseKernelStageObservation(result.stdout, attempt);
}

export async function armKernelActivation(
	now: boolean,
	run = spawnWithTimeout,
): Promise<void> {
	const result = await run(
		["systemctl", "start", `ceralive-rauc-arm@${now ? "now" : "arm"}.service`],
		{ timeoutMs: 30_000 },
	);
	if (result.exitCode !== 0)
		throw new KernelUpdateError("kernel_activation_failed");
}
