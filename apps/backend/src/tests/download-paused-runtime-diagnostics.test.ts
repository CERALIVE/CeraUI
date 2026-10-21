import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../helpers/logger.ts";
import { DownloadPausedLedger } from "../modules/system/update-orchestrator/download-paused-ledger.ts";
import { DownloadPausedNotices } from "../modules/system/update-orchestrator/download-paused-notices.ts";
import { notifyUpdate } from "../modules/system/update-orchestrator/notifications.ts";
import {
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { resetDismissalStoreForTests } from "../modules/ui/notification-dismissals.ts";
import { getPersistentNotifications } from "../modules/ui/notifications.ts";
import { resetNotificationState } from "./helpers/notification-state.ts";
import {
	fakeDeps,
	quarantineDirs,
} from "./helpers/orchestrator-runtime-harness.ts";

test("tick catch isolates a throwing logger while download hold hydration completes", async () => {
	// Given a persisted hold and a rejecting credential observer beside the notice worker.
	const root = mkdtempSync(join(tmpdir(), "download-tick-diagnostics-"));
	const oldDismissals = process.env.CERALIVE_DISMISSALS_FILE;
	process.env.CERALIVE_DISMISSALS_FILE = join(root, "dismissals.json");
	resetDismissalStoreForTests();
	resetNotificationState();
	const ledger = new DownloadPausedLedger(join(root, "ledger.json"));
	const fact = {
		id: "packages:11111111-1111-4111-8111-111111111111",
		candidate: "a".repeat(64),
	};
	ledger.write([{ ...fact, status: "active" }]);
	const worker = new DownloadPausedNotices({
		ledger,
		publish: (value) => {
			notifyUpdate({ kind: "download-paused", id: value.id });
		},
		clear: () => undefined,
		report: () => undefined,
	});
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			downloadNotices: worker,
			isUpdateAdmissionReady: async () => false,
			observeCredentials: () =>
				Promise.reject(new Error("synthetic observer failure")),
		}),
	);
	setOrchestratorStateForTest(initialOrchestratorState(0));
	const markers = ["-----BEGIN PRIVATE KEY-----", "/etc/apt/certs/client.key"];
	const log = spyOn(logger, "warn").mockImplementation(() => {
		throw new Error(markers.join(" "));
	});
	const rejections: unknown[] = [];
	const exceptions: unknown[] = [];
	const onRejection = (error: unknown) => rejections.push(error);
	const onException = (error: unknown) => exceptions.push(error);
	process.on("unhandledRejection", onRejection);
	process.on("uncaughtException", onException);
	try {
		// When the tick's detached catch calls the throwing logger.
		await expect(runOrchestratorTick()).resolves.toBeUndefined();
		await worker.settled();
		await new Promise<void>((resolve) => setImmediate(resolve));
		// Then the tick and independent hold publication finish without process-level faults.
		expect(log).toHaveBeenCalledTimes(1);
		expect(getPersistentNotifications(true).show).toMatchObject([
			{
				name: `update:download-paused:${fact.id}`,
				key: "notifications.updatePausedForStream",
			},
		]);
		expect(ledger.read()).toEqual([{ ...fact, status: "active" }]);
		expect(exceptions).toEqual([]);
		expect(rejections).toEqual([]);
		const payload = JSON.stringify(
			getPersistentNotifications(true).show.map(({ name, params }) => ({
				name,
				params,
			})),
		);
		for (const marker of markers) expect(payload).not.toContain(marker);
	} finally {
		worker.dispose();
		resetOrchestratorRuntimeForTest();
		process.off("unhandledRejection", onRejection);
		process.off("uncaughtException", onException);
		log.mockRestore();
		resetNotificationState();
		if (oldDismissals === undefined)
			delete process.env.CERALIVE_DISMISSALS_FILE;
		else process.env.CERALIVE_DISMISSALS_FILE = oldDismissals;
		resetDismissalStoreForTests();
		rmSync(root, { recursive: true });
		for (const dir of quarantineDirs.splice(0))
			rmSync(dir, { recursive: true });
	}
});
