import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { OsStageError } from "./os-stage-error.ts";
import {
	OS_STAGE_GUARD_OBSERVATION_PROPERTIES,
	parseOsStageGuardObservation,
} from "./os-stage-guard-observation.ts";
import {
	OS_STAGE_GUARD_UNIT,
	type OsStageJobRecord,
	readOsJobFile,
} from "./os-stage-job-files.ts";
import type { OsOrphanDeps } from "./os-stage-orphan.ts";
import { parseOsStageSystemdProperties } from "./os-stage-systemd.ts";

export async function inspectOsStageOrphan(
	record: OsStageJobRecord | null,
	deps: Pick<OsOrphanDeps, "run" | "directory" | "uid">,
): Promise<boolean> {
	const directory = deps.directory;
	const unit = await deps.run(
		[
			"systemctl",
			"show",
			OS_STAGE_GUARD_UNIT,
			`--property=${OS_STAGE_GUARD_OBSERVATION_PROPERTIES}`,
		],
		{ timeoutMs: 2_000 },
	);
	if (unit.exitCode !== 0)
		throw new OsStageError("rauc_recovery_unproven", { cause: unit });
	const properties = parseOsStageSystemdProperties(unit.stdout);
	if (!properties) throw new OsStageError("rauc_recovery_unproven");
	const absent = properties.get("LoadState") === "not-found";
	const ready = await readOsJobFile("ready", directory, deps.uid);
	const release = await readOsJobFile("release", directory, deps.uid);
	if (!record) {
		if (!absent || ready !== null || release !== null)
			throw new OsStageError("rauc_recovery_unproven");
		const token = await readOsJobFile("token", directory, deps.uid);
		if (token !== null && !/^[a-f0-9-]{36}\n$/.test(token))
			throw new OsStageError("rauc_recovery_unproven");
		for (const name of await readdir(directory)) {
			if (
				name !== "token" &&
				!/^\.(?:token|job\.json)\.[a-f0-9-]{36}$/.test(name)
			)
				throw new OsStageError("rauc_recovery_unproven");
			const file = await lstat(join(directory, name));
			if (
				!file.isFile() ||
				file.isSymbolicLink() ||
				file.uid !== deps.uid ||
				file.nlink !== 1 ||
				(file.mode & 0o777) !== 0o600 ||
				file.size > 262144
			)
				throw new OsStageError("rauc_recovery_unproven");
		}
	} else {
		for (const name of await readdir(directory)) {
			if (
				!["token", "job.json", "ready", "release"].includes(name) &&
				!/^\.(?:token|job\.json|release)\.[a-f0-9-]{36}$/.test(name)
			)
				throw new OsStageError("rauc_recovery_unproven");
		}
		const preparing =
			!record.launched &&
			record.cliSettled &&
			ready === null &&
			release === null &&
			(record.lifecycle === undefined || record.lifecycle === "acquiring");
		const acknowledged =
			record.cliSettled &&
			ready === `${record.attemptId}\n` &&
			release === ready &&
			(record.lifecycle === undefined || record.lifecycle === "releasing");
		const observation = parseOsStageGuardObservation(
			unit.stdout,
			record.attemptId,
		);
		const exited =
			observation.kind === "terminal" &&
			observation.cleanExit &&
			["active", "inactive"].includes(properties.get("ActiveState") ?? "");
		if (!(absent && preparing) && !(acknowledged && (absent || exited)))
			throw new OsStageError("rauc_recovery_unproven", {
				diagnostics: { refusal: "orphan-lifecycle-unproven" },
			});
	}
	return absent;
}
