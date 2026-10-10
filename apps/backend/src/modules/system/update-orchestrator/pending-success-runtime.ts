import { pendingPackageSuccess } from "./pending-success-fence.ts";
import type { OrchestratorRuntimeDeps } from "./runtime.ts";

function effect<Args extends unknown[], Value>(
	run: (...args: Args) => Value,
): (...args: Args) => Value {
	return (...args) => {
		pendingPackageSuccess.assertEffectsAllowed();
		return run(...args);
	};
}

function probe<Args extends unknown[], Value>(
	read: (...args: Args) => Promise<Value>,
): (...args: Args) => Promise<Value> {
	return async (...args) => {
		pendingPackageSuccess.assertEffectsAllowed();
		const result = await read(...args);
		pendingPackageSuccess.assertEffectsAllowed();
		return result;
	};
}

export function fencePackageSuccessEffects(
	deps: OrchestratorRuntimeDeps,
): OrchestratorRuntimeDeps {
	return {
		...deps,
		loadSettings: probe(deps.loadSettings),
		loadCapabilities: probe(deps.loadCapabilities),
		isIdle: probe(deps.isIdle),
		onlyMeteredCandidateExists: probe(deps.onlyMeteredCandidateExists),
		runPackageCheck: probe(deps.runPackageCheck),
		startPackageInstall: effect(deps.startPackageInstall),
		checkOsManifest: probe(deps.checkOsManifest),
		stageOs: effect(deps.stageOs),
		armOs: effect(deps.armOs),
		startSlotSync: effect(deps.startSlotSync),
		resetSlotSyncFailure: effect(deps.resetSlotSyncFailure),
		cleanSlotSyncArchives: effect(deps.cleanSlotSyncArchives),
		removeRaucDownloads: effect(deps.removeRaucDownloads),
		dropSupersededQuarantine: effect(deps.dropSupersededQuarantine),
		refreshSlots: probe(deps.refreshSlots),
		restartStale: probe(deps.restartStale),
	};
}
