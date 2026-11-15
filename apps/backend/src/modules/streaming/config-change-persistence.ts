import { logger } from "../../helpers/logger.ts";
import { getConfig, saveConfig } from "../config.ts";
import {
	clearStagedConfigChange,
	defaultStagingDeps,
	type EngineEncodeSnapshot,
	getStagedConfigChange,
	judgeInflightMarker,
	readInflightMarker,
	releaseStagedConfigChange,
	type StagedConfigFields,
	type StagingDeps,
} from "./config-change-staging.ts";

type MutableConfig = Record<string, unknown>;

function writeFields(fields: StagedConfigFields): void {
	const config = getConfig() as unknown as MutableConfig;
	for (const [key, value] of Object.entries(fields)) {
		if (key === "composition" && value === null) delete config[key];
		else if (value !== undefined) config[key] = value;
	}
	saveConfig();
}

/**
 * `applied` is the ONLY path that touches `config.json`. Every other outcome
 * leaves the persisted values exactly as they were, because those values are
 * still what the engine is running.
 *
 * Both retire only `attemptId`'s stage: an attempt that never held it has
 * nothing to commit or abandon, whatever another attempt has staged.
 */
export function commitStagedConfigChange(
	attemptId: string,
): StagedConfigFields | undefined {
	const marker = getStagedConfigChange();
	if (marker?.attemptId !== attemptId) return undefined;
	try {
		writeFields(marker.candidate);
	} catch (err) {
		// The engine already runs the candidate and the in-memory config holds it;
		// only the disk write failed. The finished attempt must not keep the stage,
		// but its marker stays so reconciliation can still complete the write.
		releaseStagedConfigChange();
		throw err;
	}
	clearStagedConfigChange();
	return marker.candidate;
}

export function abandonStagedConfigChange(attemptId: string): void {
	if (getStagedConfigChange()?.attemptId !== attemptId) return;
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
	deps: StagingDeps = defaultStagingDeps,
): InflightReconciliation {
	const marker = readInflightMarker(deps);
	if (marker === undefined) return "no_marker";
	// A marker this process staged belongs to a change still running here, not to
	// a crashed one; that change's own outcome retires it.
	if (marker.attemptId === getStagedConfigChange()?.attemptId)
		return "no_marker";

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

	// Retire only the judged marker; a change running now keeps its stage.
	deps.removeMarker(deps.markerPath);

	return verdict.action === "persist_candidate"
		? "persisted_candidate"
		: "retained_previous";
}
