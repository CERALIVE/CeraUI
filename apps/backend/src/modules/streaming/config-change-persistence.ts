import { logger } from "../../helpers/logger.ts";
import { getConfig, saveConfig } from "../config.ts";
import {
	clearStagedConfigChange,
	type EngineEncodeSnapshot,
	getStagedConfigChange,
	judgeInflightMarker,
	readInflightMarker,
	type StagedConfigFields,
	type StagingDeps,
} from "./config-change-staging.ts";

type MutableConfig = Record<string, unknown>;

function writeFields(fields: StagedConfigFields): void {
	const config = getConfig() as unknown as MutableConfig;
	for (const [key, value] of Object.entries(fields)) {
		if (value !== undefined) config[key] = value;
	}
	saveConfig();
}

/**
 * `applied` is the ONLY path that touches `config.json`. Every other outcome
 * leaves the persisted values exactly as they were, because those values are
 * still what the engine is running.
 */
export function commitStagedConfigChange(): StagedConfigFields | undefined {
	const marker = getStagedConfigChange();
	if (marker === undefined) return undefined;
	writeFields(marker.candidate);
	clearStagedConfigChange();
	return marker.candidate;
}

export function abandonStagedConfigChange(): void {
	if (getStagedConfigChange() === undefined) return;
	clearStagedConfigChange();
}

export type InflightReconciliation =
	| "no_marker"
	| "persisted_candidate"
	| "retained_previous"
	| "deferred";

/**
 * Crash-window recovery — MARKER-ONLY, and that scoping is the entire safety
 * property. A params-vs-config mismatch with NO marker is a legitimate
 * "apply on next start" the operator chose, and reconciling it would silently
 * overwrite their intent on every boot. Only a marker proves a transaction was
 * in flight when the process died.
 */
export function reconcileInflightConfigChange(
	engine: EngineEncodeSnapshot | undefined,
	deps?: StagingDeps,
): InflightReconciliation {
	const marker = deps ? readInflightMarker(deps) : readInflightMarker();
	if (marker === undefined) return "no_marker";

	const verdict = judgeInflightMarker(marker, engine);
	if (verdict.action === "wait") {
		logger.debug("config-change marker kept — engine state not yet decisive", {
			module: "streaming",
			attemptId: marker.attemptId,
		});
		return "deferred";
	}

	// `warn`, not `info` — the SAME reason `parkStop()` uses it. The production
	// console transport runs at `warn`, so an `info` reaches the log FILE but
	// never the journal the in-app Logs dialog downloads. Measured on a board:
	// the reconciliation ran correctly and left ZERO journal evidence that a
	// crash-window marker had ever been judged. This event happens at most once
	// per crashed transaction and is the only record that a config write was
	// completed (or deliberately not) on the operator's behalf.
	if (verdict.action === "persist_candidate") {
		writeFields(marker.candidate);
		logger.warn("config-change marker resolved — candidate persisted", {
			module: "streaming",
			attemptId: marker.attemptId,
		});
	} else {
		logger.warn("config-change marker resolved — previous values retained", {
			module: "streaming",
			attemptId: marker.attemptId,
		});
	}

	if (deps) clearStagedConfigChange(deps);
	else clearStagedConfigChange();

	return verdict.action === "persist_candidate"
		? "persisted_candidate"
		: "retained_previous";
}
