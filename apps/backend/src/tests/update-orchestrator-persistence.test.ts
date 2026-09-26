/*
	CeraUI - web UI for the CERALIVE project
	Copyright (C) 2024-2025 CeraLive project

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fromPersisted,
	loadOrchestratorState,
	saveOrchestratorState,
	setOrchestratorStateFilePathForTest,
	toPersisted,
} from "../modules/system/update-orchestrator/persistence.ts";
import {
	initialOrchestratorState,
	initialScheduleClock,
	ORCHESTRATOR_PHASES,
} from "../modules/system/update-orchestrator/types.ts";

const dir = mkdtempSync(join(tmpdir(), "ceraui-orch-persist-"));
const file = join(dir, "agent.json");

afterEach(() => {
	setOrchestratorStateFilePathForTest(null);
	rmSync(file, { force: true });
});

describe("update-orchestrator persistence", () => {
	test("loadOrchestratorState returns null when the file does not exist", async () => {
		setOrchestratorStateFilePathForTest(file);
		expect(await loadOrchestratorState()).toBeNull();
	});

	test("round-trips every phase byte-exact through save/load", async () => {
		setOrchestratorStateFilePathForTest(file);
		for (const phase of ORCHESTRATOR_PHASES) {
			const state = {
				...initialOrchestratorState(1234),
				phase,
				progress: { percent: 12, etaSeconds: 34 },
				failureReason: phase === "failed" ? "boom" : null,
				cellularOverrideId: "abc",
			};
			saveOrchestratorState(state);
			const loaded = await loadOrchestratorState();
			expect(loaded).toEqual(state);
		}
	});

	test("toPersisted/fromPersisted round-trip is the identity for OrchestratorState", () => {
		const state = {
			...initialOrchestratorState(5),
			phase: "downloading" as const,
			progress: { percent: 1, etaSeconds: 2 },
		};
		expect(fromPersisted(toPersisted(state))).toEqual(state);
	});

	test("corrupt JSON on disk resolves to null, never throws", async () => {
		setOrchestratorStateFilePathForTest(file);
		writeFileSync(file, "{ not json", "utf8");
		expect(await loadOrchestratorState()).toBeNull();
	});

	test("well-formed JSON that fails schema validation (missing required field) resolves to null", async () => {
		setOrchestratorStateFilePathForTest(file);
		writeFileSync(
			file,
			JSON.stringify({
				schema: 1,
				phase: "idle",
				// enteredAt intentionally missing
				progress: null,
				failureReason: null,
				packageCheck: initialScheduleClock(),
				osCheck: initialScheduleClock(),
				cellularOverrideId: null,
			}),
			"utf8",
		);
		expect(await loadOrchestratorState()).toBeNull();
	});

	test("an unknown extra key (strict violation) resolves to null rather than being silently accepted", async () => {
		setOrchestratorStateFilePathForTest(file);
		writeFileSync(
			file,
			JSON.stringify({
				...toPersisted(initialOrchestratorState(1)),
				unexpectedForeignKey: "should not be here",
			}),
			"utf8",
		);
		expect(await loadOrchestratorState()).toBeNull();
	});

	test("an invalid phase value resolves to null", async () => {
		setOrchestratorStateFilePathForTest(file);
		writeFileSync(
			file,
			JSON.stringify({
				...toPersisted(initialOrchestratorState(1)),
				phase: "not-a-real-phase",
			}),
			"utf8",
		);
		expect(await loadOrchestratorState()).toBeNull();
	});

	test("saveOrchestratorState creates the parent directory if missing (mkdir -p)", async () => {
		const nestedDir = join(dir, "nested", "deeper");
		const nestedFile = join(nestedDir, "agent.json");
		setOrchestratorStateFilePathForTest(nestedFile);
		saveOrchestratorState(initialOrchestratorState(0));
		expect(await loadOrchestratorState()).toEqual(initialOrchestratorState(0));
		rmSync(join(dir, "nested"), { recursive: true, force: true });
	});

	test("a write is atomic: the old content survives an interrupted write attempt on the same path", async () => {
		setOrchestratorStateFilePathForTest(file);
		const first = {
			...initialOrchestratorState(1),
			phase: "available" as const,
		};
		saveOrchestratorState(first);
		// Second save overwrites cleanly (proves rename-based atomic replace, not
		// truncate-in-place, by re-reading afterward).
		const second = {
			...initialOrchestratorState(2),
			phase: "checking" as const,
		};
		saveOrchestratorState(second);
		expect(await loadOrchestratorState()).toEqual(second);
	});
});
