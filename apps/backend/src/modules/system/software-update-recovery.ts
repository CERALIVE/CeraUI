/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

export type SoftwareUpdateRecoveryCoordinatorDeps = {
	readonly attempt: () => Promise<boolean>;
	readonly scheduleRetry: (retry: () => void) => void;
	readonly resumePeriodicChecks: () => void;
	readonly reportRetryError: (error: unknown) => void;
};

let recoveryInconclusive = false;
let recoveryPromise: Promise<boolean> | undefined;

export function isSoftwareUpdateRecoveryInconclusive(): boolean {
	return recoveryInconclusive;
}

export function resetSoftwareUpdateRecovery(): void {
	recoveryPromise = undefined;
	recoveryInconclusive = false;
}

async function runRecovery(
	deps: SoftwareUpdateRecoveryCoordinatorDeps,
): Promise<boolean> {
	recoveryInconclusive = true;
	try {
		const recovered = await deps.attempt();
		recoveryInconclusive = false;
		return recovered;
	} catch (error) {
		deps.scheduleRetry(() => {
			void recoverSoftwareUpdateWithCoordination(deps)
				.then(() => deps.resumePeriodicChecks())
				.catch(deps.reportRetryError);
		});
		throw error;
	}
}

export function recoverSoftwareUpdateWithCoordination(
	deps: SoftwareUpdateRecoveryCoordinatorDeps,
): Promise<boolean> {
	if (recoveryPromise) return recoveryPromise;
	const completion = runRecovery(deps);
	recoveryPromise = completion;
	const clear = () => {
		if (recoveryPromise === completion) recoveryPromise = undefined;
	};
	void completion.then(clear, clear);
	return completion;
}
