import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { reconcileAptChannel } from "../modules/system/update-apt-channel.ts";
import { pendingPackageSuccess } from "../modules/system/update-orchestrator/pending-success-fence.ts";
import * as stored from "../modules/system/update-orchestrator/stored-state-file.ts";
import { pendingSuccessFixture } from "./helpers/pending-success-fixture.ts";

test("APT channel reconciliation rechecks pending success after reading its source file", async () => {
	// Given the real source file and a controlled read already admitted before observation.
	using h = pendingSuccessFixture();
	const file = join(h.file, "..", "ceralive.sources");
	await Bun.write(file, "original sources");
	const read = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const originalRead = stored.readStoredStateFile;
	const reader = spyOn(stored, "readStoredStateFile").mockImplementation(
		async (path, limit) => {
			const value = await originalRead(path, limit);
			if (path === file) {
				read.resolve();
				await release.promise;
			}
			return value;
		},
	);
	try {
		const channel = reconcileAptChannel("capable", "beta", file, "arm64");
		await read.promise;
		// When package completion is observed before the source read returns.
		pendingPackageSuccess.observe();
		release.resolve();
		// Then no new channel write occurs; after acknowledgement normal reconciliation resumes.
		expect(await channel).toBe(false);
		reader.mockRestore();
		expect(await Bun.file(file).text()).toBe("original sources");
		pendingPackageSuccess.acknowledge(h.success);
		expect(await reconcileAptChannel("capable", "beta", file, "arm64")).toBe(
			true,
		);
	} finally {
		release.resolve();
		reader.mockRestore();
	}
});
