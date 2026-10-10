import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
	consumeOsUnlaunchedWitness,
	readOsUnlaunchedWitness,
} from "../modules/system/update-orchestrator/os-stage-unlaunched-witness.ts";
import { saveOrchestratorState } from "../modules/system/update-orchestrator/persistence.ts";
import { startUpdateOrchestrator } from "../modules/system/update-orchestrator/runtime.ts";
import {
	identifiedState,
	runtimeFixture,
} from "./helpers/os-unlaunched-runtime-fixture.ts";

const fixtures: ReturnType<typeof runtimeFixture>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

test("syncs the state directory before consuming physical settlement evidence", async () => {
	// Given real witness/state files with only the fsync boundary observed.
	const f = runtimeFixture();
	fixtures.push(f);
	f.writeWitness();
	saveOrchestratorState(identifiedState(), f.file);
	const sync = fs.fsyncSync;
	const effects: string[] = [];
	const observer = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
		effects.push(
			fs.fstatSync(fd).isDirectory() ? "directory-sync" : "file-sync",
		);
		sync(fd);
	});
	try {
		// When production startup persists and consumes, observe the consume boundary.
		await startUpdateOrchestrator({
			...f.deps,
			consumeOsUnlaunchedWitness: (id) => {
				effects.push("consume");
				consumeOsUnlaunchedWitness(id, f.witnessDeps);
			},
		});
		// Then durable directory publication precedes unlink, not only the file fsync.
		expect(effects.slice(0, 3)).toEqual([
			"directory-sync",
			"consume",
			"directory-sync",
		]);
	} finally {
		observer.mockRestore();
	}
});

test("retains the witness when parent directory durability fails", async () => {
	// Given valid recovery proof with a failing directory fsync after rename.
	const f = runtimeFixture();
	fixtures.push(f);
	f.writeWitness();
	saveOrchestratorState(identifiedState(), f.file);
	const sync = fs.fsyncSync;
	const fault = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
		if (fs.fstatSync(fd).isDirectory()) throw new Error("directory sync fault");
		sync(fd);
	});
	try {
		// When the actual state writer cannot make its rename durable.
		await expect(startUpdateOrchestrator(f.deps)).rejects.toThrow(
			"directory sync fault",
		);
		// Then cleanup never consumes the witness despite the visible renamed file.
		expect(readOsUnlaunchedWitness(f.witnessDeps)).not.toBeNull();
	} finally {
		fault.mockRestore();
	}
});
