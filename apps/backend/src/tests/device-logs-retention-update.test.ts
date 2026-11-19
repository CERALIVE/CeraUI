import { afterEach, expect, test } from "bun:test";
import { clearAll } from "../modules/device-logs/retention.ts";
import {
	getOrchestratorState,
	installUpdatesNow,
} from "../modules/system/update-orchestrator/runtime.ts";
import { bounded, historyFixture } from "./helpers/history-clear.ts";
import {
	cleanScopedFixture,
	scopedFixture,
} from "./helpers/package-scoped-install.ts";

let h: ReturnType<typeof historyFixture>;
afterEach(async () => {
	try {
		await h?.dispose();
	} finally {
		cleanScopedFixture();
	}
});

test("native clear excludes update admission until rotation and vacuum settle", async () => {
	h = historyFixture(false);
	const update = scopedFixture();
	h.f.phase.mockRestore();
	const rotation = h.holdRotate();
	const vacuum = h.ownedLatch();
	let phaseAtVacuum: string | undefined;
	h.journal.vacuum = async () => {
		phaseAtVacuum = getOrchestratorState().phase;
		await vacuum.hold();
	};
	const clearing = h.own(clearAll());
	try {
		await bounded(rotation.entered);
		const duringRotation = await bounded(
			installUpdatesNow({ scope: "packages" }),
		);
		rotation.release();
		await bounded(vacuum.entered);
		const duringVacuum = await bounded(
			installUpdatesNow({ scope: "packages" }),
		);
		vacuum.release();
		expect((await bounded(clearing)).ok).toBe(true);
		expect(phaseAtVacuum).toBe("available");
		expect(duringRotation).toEqual({ started: false, reason: "busy" });
		expect(duringVacuum).toEqual({ started: false, reason: "busy" });
		expect(update.launches()).toBe(0);
		expect(await bounded(installUpdatesNow({ scope: "packages" }))).toEqual({
			started: true,
		});
		expect(update.launches()).toBe(1);
	} finally {
		rotation.release();
		vacuum.release();
		await bounded(clearing);
	}
});
