import { afterEach, expect, spyOn, test } from "bun:test";
import * as directorySync from "../modules/system/update-orchestrator/orchestrator-directory-sync.ts";
import { pendingPackageSuccess } from "../modules/system/update-orchestrator/pending-success-fence.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import { pendingSuccessFixture } from "./helpers/pending-success-fixture.ts";

afterEach(() => pendingPackageSuccess.resetForTest());

test("repeat completion requires an acknowledged re-persist when parent fsync failed after rename", async () => {
	// Given the production atomic writer with its directory sync failing after rename.
	using h = pendingSuccessFixture();
	const sync = spyOn(
		directorySync,
		"syncOrchestratorDirectory",
	).mockImplementation(() => {
		throw new Error("fixture directory fsync failed");
	});
	try {
		expect(() =>
			pendingPackageSuccess.invoke(() => {
				h.memory = h.success;
				h.writes++;
				// The production persistence funnel renames before this injected sync throws.
				saveOrchestratorState(h.success, h.file);
			}),
		).toThrow("fsync failed");
		expect((await loadOrchestratorState(h.file))?.phase).toBe(
			"restarting-services",
		);
		// When a repeated hook changes nothing while directory sync still fails.
		await expect(pendingPackageSuccess.invoke(() => {})).rejects.toThrow(
			"fsync failed",
		);
		// Then readable equality does not release the fence; successful re-persistence does.
		expect(pendingPackageSuccess.pending).toBe(true);
		expect(sync).toHaveBeenCalledTimes(2);
		sync.mockRestore();
		expect(await pendingPackageSuccess.invoke(() => {})).toBe(true);
		expect(pendingPackageSuccess.pending).toBe(false);
	} finally {
		sync.mockRestore();
	}
});

test("a later different success cannot replace or acknowledge the retained completion", async () => {
	// Given one observed transaction and a later success with a different discovery identity.
	using h = pendingSuccessFixture();
	pendingPackageSuccess.observe();
	const replacement = {
		...h.success,
		packageCheck: { ...h.success.packageCheck, lastAttemptAt: 99 },
	};
	// When a later owner tries both retention and terminal acknowledgement.
	expect(() =>
		pendingPackageSuccess.retain(replacement, replacement),
	).toThrow();
	pendingPackageSuccess.acknowledge(replacement);
	// Then the original permission remains closed and replay persists only its original intent.
	expect(pendingPackageSuccess.pending).toBe(true);
	await pendingPackageSuccess.retry();
	expect(await loadOrchestratorState(h.file)).toEqual(h.success);
});
