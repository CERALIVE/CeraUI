import type { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import { SOFTWARE_UPDATE_LOCK } from "./lock.ts";
import { OsStageError } from "./os-stage-error.ts";
import {
	OS_STAGE_GUARD_HELPER,
	OS_STAGE_GUARD_UNIT,
} from "./os-stage-job-files.ts";
import { parseOsStageSystemdProperties } from "./os-stage-systemd.ts";

export const OS_STAGE_GUARD_DESCRIPTION = "CeraLive OS stage lock";
export const OS_STAGE_GUARD_PROPERTIES =
	"Id,FragmentPath,Description,Transient,Type,RemainAfterExit,User,DropInPaths,ExecStart,ExecStartPre,ExecStartPost,ExecStop,ExecStopPost,ActiveState,MainPID,ExecMainStatus";
export const OS_STAGE_GUARD_OBSERVATION_PROPERTIES = `LoadState,ControlPID,ControlGroup,Restart,ExecMainCode,InvocationID,${OS_STAGE_GUARD_PROPERTIES}`;

export function isOwnedOsStageGuard(
	output: string,
	attemptId: string,
): boolean {
	if (!/^[a-f0-9-]{36}$/.test(attemptId)) return false;
	const rows = parseOsStageSystemdProperties(output);
	if (!rows) return false;
	return ownedProperties(rows, attemptId);
}

function ownedProperties(
	rows: ReadonlyMap<string, string>,
	attemptId: string,
): boolean {
	const expected = {
		Id: OS_STAGE_GUARD_UNIT,
		FragmentPath: `/run/systemd/transient/${OS_STAGE_GUARD_UNIT}`,
		Description: OS_STAGE_GUARD_DESCRIPTION,
		Transient: "yes",
		Type: "exec",
		RemainAfterExit: "yes",
		User: "",
		DropInPaths: "",
	};
	if (
		!Object.entries(expected).every(([key, value]) => rows.get(key) === value)
	)
		return false;
	// systemd 257 omits empty exec lists, but any configured hook is foreign.
	if (
		!["ExecStartPre", "ExecStartPost", "ExecStop", "ExecStopPost"].every(
			(key) => (rows.get(key) ?? "") === "",
		)
	)
		return false;
	const prefix = `{ path=/usr/bin/flock ; argv[]=/usr/bin/flock -n -E 75 -x ${SOFTWARE_UPDATE_LOCK} ${OS_STAGE_GUARD_HELPER} ${attemptId}`;
	const exec = rows.get("ExecStart") ?? "";
	return (
		exec.startsWith(prefix) &&
		/^ ; ignore_errors=no ; start_time=\[[^\]\n]*\] ; stop_time=\[[^\]\n]*\] ; pid=\d+ ; code=(?:\(null\)|exited|killed|dumped) ; status=\d+(?:\/[A-Za-z0-9_-]+)? }$/.test(
			exec.slice(prefix.length),
		)
	);
}

export type OsStageGuardObservation =
	| { readonly kind: "absent" }
	| {
			readonly kind: "live";
			readonly pid: string;
			readonly invocationId: string;
	  }
	| { readonly kind: "starting"; readonly invocationId: string }
	| {
			readonly kind: "terminal";
			readonly cleanExit: boolean;
			readonly invocationId: string;
			readonly exitStatus: number;
	  };

/** Reads the guardian through the exact property set the parser below expects. */
export async function observeOsStageGuard(
	run: typeof spawnWithTimeout,
	attemptId: string,
): Promise<OsStageGuardObservation> {
	const result = await run(
		[
			"systemctl",
			"show",
			OS_STAGE_GUARD_UNIT,
			`--property=${OS_STAGE_GUARD_OBSERVATION_PROPERTIES}`,
		],
		{ timeoutMs: 2_000 },
	);
	if (result.exitCode !== 0)
		throw new OsStageError("rauc_recovery_unproven", { cause: result });
	return parseOsStageGuardObservation(result.stdout, attemptId);
}

const GUARD_OBJECT = `/org/freedesktop/systemd1/unit/${OS_STAGE_GUARD_UNIT.replaceAll("-", "_2d").replaceAll(".", "_2e")}`;

/** True only for systemd's exact typed zero-job tuple on the loaded guardian. */
export async function isOsStageGuardJobIdle(
	run: typeof spawnWithTimeout,
): Promise<boolean> {
	const result = await run(
		[
			"busctl",
			"get-property",
			"org.freedesktop.systemd1",
			GUARD_OBJECT,
			"org.freedesktop.systemd1.Unit",
			"Job",
		],
		{ timeoutMs: 2_000 },
	);
	if (result.exitCode !== 0)
		throw new OsStageError("rauc_recovery_unproven", { cause: result });
	return result.stdout.trim() === '(uo) 0 "/"';
}

// Unknown, transitional (deactivating, reloading) or foreign shapes are unsafe.
export function parseOsStageGuardObservation(
	output: string,
	attemptId: string,
): OsStageGuardObservation {
	const rows = parseOsStageSystemdProperties(output);
	if (!rows) throw new OsStageError("rauc_recovery_unproven");
	if (rows.get("LoadState") === "not-found") return { kind: "absent" };
	if (rows.get("LoadState") !== "loaded" || !ownedProperties(rows, attemptId))
		throw new OsStageError("rauc_recovery_unproven");
	const pid = rows.get("MainPID") ?? "";
	const invocationId = rows.get("InvocationID") ?? "";
	if (
		!/^[a-f0-9]{32}$/.test(invocationId) ||
		rows.get("Restart") !== "no" ||
		rows.get("ControlPID") !== "0"
	)
		throw new OsStageError("rauc_recovery_unproven");
	const active = rows.get("ActiveState");
	if (
		active === "active" &&
		/^[1-9][0-9]*$/.test(pid) &&
		rows.get("ControlGroup") === `/system.slice/${OS_STAGE_GUARD_UNIT}`
	)
		return { kind: "live", pid, invocationId };
	if (active === "activating" && /^(?:0|[1-9][0-9]*)$/.test(pid))
		return { kind: "starting", invocationId };
	if (pid === "0" && ["failed", "inactive", "active"].includes(active ?? "")) {
		const cleanExit =
			rows.get("ExecMainCode") === "1" &&
			rows.get("ExecMainStatus") === "0" &&
			/ ; code=exited ; status=0(?:\/SUCCESS)? }$/.test(
				rows.get("ExecStart") ?? "",
			);
		if (active === "active" && !cleanExit)
			throw new OsStageError("rauc_recovery_unproven");
		const status = rows.get("ExecMainStatus") ?? "";
		if (!/^\d+$/.test(status)) throw new OsStageError("rauc_recovery_unproven");
		return {
			kind: "terminal",
			cleanExit,
			invocationId,
			exitStatus: Number(status),
		};
	}
	throw new OsStageError("rauc_recovery_unproven");
}
