import { expect, test } from "bun:test";
import { OsSettlementPersistence } from "../modules/system/update-orchestrator/os-settlement-persistence.ts";

test("cleanup callers join one flight while admission remains pending", async () => {
	// Given a cleanup operation held before its durability acknowledgement.
	const state = new OsSettlementPersistence();
	const held = Promise.withResolvers<boolean>();
	const first = state.intentCleanup.run(() => held.promise);
	expect(state.pending).toBe(true);
	// When another caller joins before the operation settles.
	const second = state.intentCleanup.run(async () => false);
	held.resolve(true);
	// Then both callers observe the same completion, with no early admission grant.
	expect(await first).toBe(true);
	expect(await second).toBe(true);
	expect(state.pending).toBe(false);
});

test("intent cleanup cannot clear independently pending snapshot storage", async () => {
	// Given a failed snapshot write, independently of intent cleanup.
	const state = new OsSettlementPersistence();
	expect(() =>
		state.persist(() => {
			throw new Error("snapshot IO");
		}),
	).toThrow();
	// When a separate intent cleanup completes successfully.
	await state.intentCleanup.run(async () => true);
	// Then snapshot admission remains closed until its own persistence succeeds.
	expect(state.snapshotPending).toBe(true);
	expect(state.pending).toBe(true);
});

test("an old cleanup completion cannot open a replacement flight after runtime reset", async () => {
	// Given an old pending flight and a replacement runtime's cleanup.
	const state = new OsSettlementPersistence();
	const old = Promise.withResolvers<boolean>();
	const replacement = Promise.withResolvers<boolean>();
	const oldFlight = state.intentCleanup.run(() => old.promise);
	state.resetForTest();
	const newFlight = state.intentCleanup.run(() => replacement.promise);
	// When the old completion arrives after the replacement is pending.
	old.resolve(true);
	await oldFlight;
	// Then it cannot release the replacement's admission closure.
	expect(state.pending).toBe(true);
	replacement.resolve(true);
	await newFlight;
	expect(state.pending).toBe(false);
});
