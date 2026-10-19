import { stat } from "node:fs/promises";
import { readOsLockKernelDevice } from "./os-stage-lock-device.ts";
import { observationAbsent } from "./os-stage-read-errors.ts";
import {
	createRecoveryProbes,
	defaultRecoveryProbeIo,
	type RecoveryProbeIo,
} from "./recovery-probes.ts";
import type { OrchestratorState } from "./types.ts";

export type PackageRecoveryEvidence = {
	readonly unitAbsent: boolean;
	readonly packagesIdle: boolean;
	readonly locksIdle: boolean;
	readonly auditClean: boolean;
	readonly updatesEmpty: boolean;
	readonly bootId: string;
	readonly slot: string;
};

const PACKAGE_LOCKS = [
	"/var/lib/dpkg/lock",
	"/var/lib/dpkg/lock-frontend",
	"/var/lib/apt/lists/lock",
	"/var/cache/apt/archives/lock",
] as const;

export async function packageLocksIdle(
	paths: readonly string[] = PACKAGE_LOCKS,
	readTable: () => Promise<string> = () =>
		defaultRecoveryProbeIo.read("/proc/locks"),
): Promise<boolean> {
	const keys: string[] = [];
	for (const path of paths) {
		try {
			const identity = await stat(path);
			const device = await readOsLockKernelDevice(path, identity);
			if (!device) return false;
			keys.push(`${device}:${identity.ino}`);
		} catch (error) {
			if (observationAbsent(error, "path")) continue;
			throw error;
		}
	}
	const table = await readTable();
	for (const line of table.trim().split("\n")) {
		if (line === "") continue;
		const row =
			/^\d+:\s+(?:->\s+)?(?:POSIX|FLOCK|OFDLCK|LEASE)\s+(?:ADVISORY|MANDATORY|ACTIVE|BREAKING)\s+(?:READ|WRITE|UNLCK)\s+-?\d+\s+([0-9a-f]+:[0-9a-f]+:\d+)\s+\d+\s+(?:EOF|\d+)$/.exec(
				line,
			);
		if (!row?.[1] || keys.includes(row[1])) return false;
	}
	return true;
}

export async function readPackageConsistency(
	io: RecoveryProbeIo = defaultRecoveryProbeIo,
	locksIdle: () => Promise<boolean> = packageLocksIdle,
): Promise<Omit<PackageRecoveryEvidence, "bootId" | "slot">> {
	const probes = createRecoveryProbes(io);
	const unitAbsent = await probes.unitAbsent();
	const packagesIdle = await probes.operationsIdle();
	const audit = await io.run(["dpkg", "--audit"]);
	return {
		unitAbsent,
		packagesIdle,
		locksIdle: await locksIdle(),
		auditClean: audit.code === 0 && audit.stdout.trim() === "",
		updatesEmpty: (await io.list("/var/lib/dpkg/updates")).length === 0,
	};
}

export function packageRecoveryProven(
	state: OrchestratorState,
	proof: PackageRecoveryEvidence,
): boolean {
	const began = state.packageAttempt;
	return (
		proof.unitAbsent &&
		proof.packagesIdle &&
		proof.locksIdle &&
		proof.auditClean &&
		proof.updatesEmpty &&
		began !== undefined &&
		proof.bootId !== "" &&
		proof.slot !== "" &&
		(proof.bootId !== began.bootId || proof.slot !== began.slot)
	);
}
