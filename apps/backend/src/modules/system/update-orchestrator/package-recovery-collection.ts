import { isDeepStrictEqual } from "node:util";
import type { FailedRecoveryPort } from "./failed-recovery.ts";
import type { OsStageControlLease } from "./os-stage-control-lease.ts";
import { packageRecoveryProven } from "./package-recovery-evidence.ts";
import { toPersisted } from "./persistence.ts";
import type { OrchestratorState } from "./types.ts";

export type PackageCollectionClock = {
	readonly now: () => number;
	readonly arm: (expire: () => void, ms: number) => () => void;
};

const defaultClock: PackageCollectionClock = {
	now: () => performance.now(),
	arm: (expire, ms) => {
		const timer = setTimeout(expire, ms);
		return () => clearTimeout(timer);
	},
};
const COLLECTION_TIMEOUT_MS = 30_000;

export class PackageCollectionTimeoutError extends Error {
	override readonly name = "PackageCollectionTimeoutError";
}

export async function collectPackageRecovery(
	port: FailedRecoveryPort,
	before: OrchestratorState,
	locks: OsStageControlLease,
): Promise<boolean> {
	const clock = port.packageCollectionClock ?? defaultClock;
	const deadline = clock.now() + COLLECTION_TIMEOUT_MS;
	let active = true;
	let cancel: (() => void) | undefined;
	const fence = () => {
		if (!active || clock.now() >= deadline)
			throw new PackageCollectionTimeoutError("package collection expired");
	};
	try {
		return await Promise.race([
			(async () => {
				fence();
				const persisted = await port.readPersisted();
				fence();
				if (
					!persisted ||
					!isDeepStrictEqual(toPersisted(before), toPersisted(persisted))
				)
					return false;
				const evidence = await port.readPackageEvidence(locks);
				fence();
				return packageRecoveryProven(before, evidence);
			})(),
			new Promise<never>((_resolve, reject) => {
				cancel = clock.arm(
					() => {
						active = false;
						reject(
							new PackageCollectionTimeoutError("package collection expired"),
						);
					},
					Math.max(0, deadline - clock.now()),
				);
			}),
		]);
	} finally {
		active = false;
		cancel?.();
	}
}
