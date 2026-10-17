import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OsAttemptIntentStore } from "../../modules/system/update-orchestrator/os-attempt-intent-store.ts";
import type { OrchestratorRuntimeDeps } from "../../modules/system/update-orchestrator/runtime.ts";
import type { OrchestratorState } from "../../modules/system/update-orchestrator/types.ts";

const roots: string[] = [];
process.once("exit", () => {
	for (const root of roots) rmSync(root, { recursive: true });
});

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
	roots.push(root);
	return {
		...deps,
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
