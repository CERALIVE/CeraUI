import { expect, test } from "bun:test";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { withMemoryPersistence } from "./helpers/orchestrator-memory-persistence.ts";

test("a supplied restart baseline is committed evidence independent of fixture memory", async () => {
	// Given a store initialized from an explicit persisted snapshot.
	const committed = {
		...initialOrchestratorState(1),
		progress: { percent: 10, etaSeconds: 0 },
	};
	const store = withMemoryPersistence({}, committed);
	// When the fixture's local input changes without persistence.
	committed.progress.percent = 90;
	// Then authoritative evidence remains the original committed snapshot.
	expect((await store.readPersistedState?.())?.progress?.percent).toBe(10);
});

test("reads only the last successful persist instead of current runtime memory", async () => {
	// Given a fixture persistence adapter and an initial committed record.
	const store = withMemoryPersistence({});
	const committed = initialOrchestratorState(1);
	store.persist(committed);
	// When runtime memory changes without another persist.
	const current = { ...committed, phase: "failed" as const };
	// Then its authoritative read still returns the committed record, independently.
	expect(await store.readPersistedState?.()).toEqual(committed);
	expect(await store.readPersistedState?.()).not.toEqual(current);
});

test("retains the prior persisted record when the fixture write throws", async () => {
	// Given a recorder that rejects the replacement write only.
	const store = withMemoryPersistence({
		persist: (state: ReturnType<typeof initialOrchestratorState>) => {
			if (state.phase === "failed") throw new Error("write fault");
		},
	});
	const committed = initialOrchestratorState(1);
	store.persist(committed);
	// When the replacement write fails.
	expect(() => store.persist({ ...committed, phase: "failed" })).toThrow(
		"write fault",
	);
	// Then rejected writes never become authoritative fixture evidence.
	expect(await store.readPersistedState?.()).toEqual(committed);
});
