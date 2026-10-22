import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DownloadPausedLedger } from "../../modules/system/update-orchestrator/download-paused-ledger.ts";
import { DownloadPausedNotices } from "../../modules/system/update-orchestrator/download-paused-notices.ts";
import {
	clearUpdateNotice,
	notifyUpdate,
} from "../../modules/system/update-orchestrator/notifications.ts";
import { OsAttemptIntentStore } from "../../modules/system/update-orchestrator/os-attempt-intent-store.ts";
import type { OrchestratorRuntimeDeps } from "../../modules/system/update-orchestrator/runtime.ts";
import type { OrchestratorState } from "../../modules/system/update-orchestrator/types.ts";

const roots = new Set<string>();

/**
 * Removes every fixture directory this helper created. Only registered roots
 * are touched, and the registry is emptied first so a repeated call is a
 * no-op and never re-deletes a path that was already removed.
 *
 * `bun test` does not run `process.once("exit")` handlers. A hook registered
 * while a test executes belongs to the file running that test, and this module
 * is shared by several files in a single-process run, so the hook is armed
 * lazily whenever the registry goes from empty to non-empty.
 */
export function disposeMemoryPersistenceRoots(): void {
	for (const root of roots) {
		roots.delete(root);
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// A directory already gone, or one whose handles are still draining,
			// must not turn a passing test into an environmental failure.
		}
	}
}

export function withMemoryPersistence<
	T extends Partial<OrchestratorRuntimeDeps>,
>(
	deps: T,
	initial: OrchestratorState | null = null,
): T &
	Pick<
		OrchestratorRuntimeDeps,
		"persist" | "readPersistedState" | "osAttemptIntentStore"
	> {
	let persisted: OrchestratorState | null = initial && structuredClone(initial);
	const root = mkdtempSync(join(tmpdir(), "orchestrator-intent-memory-"));
	if (roots.size === 0) afterEach(disposeMemoryPersistenceRoots);
	roots.add(root);
	return {
		...deps,
		downloadNotices:
			deps.downloadNotices ??
			new DownloadPausedNotices({
				ledger: new DownloadPausedLedger(join(root, "download-notices.json")),
				publish: (fact, onDismiss) => {
					notifyUpdate({ kind: "download-paused", id: fact.id }, { onDismiss });
				},
				clear: (id) => clearUpdateNotice("download-paused", id),
				report: () => undefined,
			}),
		osAttemptIntentStore:
			deps.osAttemptIntentStore ??
			new OsAttemptIntentStore({
				path: join(root, "intent.json"),
				uid: process.getuid?.() ?? 0,
			}),
		readPersistedState: deps.readPersistedState ?? (async () => persisted),
		persist: (state) => {
			deps.persist?.(state);
			persisted = structuredClone(state);
		},
	};
}
