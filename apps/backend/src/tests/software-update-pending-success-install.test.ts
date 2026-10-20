import { expect, spyOn, test } from "bun:test";
import * as updates from "../modules/system/software-updates.ts";
import * as capabilities from "../modules/system/update-capabilities.ts";
import { pendingPackageSuccess } from "../modules/system/update-orchestrator/pending-success-fence.ts";
import { pendingSuccessFixture } from "./helpers/pending-success-fixture.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

for (const boundary of ["capabilities", "pre-clean"] as const) {
	test(`legacy install releases its latch without new commands when success arrives during ${boundary}`, async () => {
		// Given the real install continuation admitted before a controlled preparation boundary.
		await using h = await updateHarness();
		using _f = pendingSuccessFixture();
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const read = spyOn(
			capabilities,
			"readUpdateCapabilities",
		).mockImplementation(async () => {
			if (boundary === "capabilities") {
				reached.resolve();
				await release.promise;
			}
			return { mode: "legacy", features: [] };
		});
		h.beforeClean = async () => {
			reached.resolve();
			await release.promise;
		};
		let callback:
			| Parameters<
					Parameters<typeof updates.setSoftwareUpdateCheckRunner>[0]
			  >[0]
			| undefined;
		updates.setSoftwareUpdateCheckRunner((cb) => {
			callback = cb;
			return true;
		});
		try {
			expect(updates.startSoftwareUpdate()).toEqual({ started: true });
			const install = callback?.(null, 0);
			await reached.promise;
			// When completion is observed before the awaited preparation returns.
			pendingPackageSuccess.observe();
			release.resolve();
			await install;
			// Then no command after the held boundary nor detached install is submitted.
			expect(h.commands).toHaveLength(boundary === "pre-clean" ? 1 : 0);
			expect(h.launches).toHaveLength(0);
			expect(updates.isUpdating()).toBe(false);
			expect(await h.marker()).toBe(h.markerBefore);
		} finally {
			release.resolve();
			read.mockRestore();
		}
	});
}
