import { afterEach, describe, expect, test } from "bun:test";
import {
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	notificationExists,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { receipt, setup } from "./helpers/os-agent-runtime-harness.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	for (const kind of ["os-activated", "os-activation-requested"])
		notificationRemove(`update:${kind}:${receipt.version}`);
});

describe("activation notice outcome evidence", () => {
	for (const booted of ["2026.9.0", receipt.version, undefined]) {
		test(`same-boot forced arming never claims active with running version ${booted}`, async () => {
			// Given the staged receipt on the same boot and a completed arm command.
			let forced = false;
			setup({
				now: () => receipt.stagedAt + 7 * 24 * 60 * 60_000,
				readBootedVersion: async () => booted,
				armOs: async (now) => {
					forced = now;
				},
			});
			setOrchestratorStateForTest({
				...initialOrchestratorState(0),
				phase: "os-activation-armed",
			});
			// When the actual activation reconciler runs, then command completion is pending.
			await runOrchestratorTick();
			expect(forced).toBe(true);
			expect(
				notificationExists(`update:os-activated:${receipt.version}`),
			).toBeUndefined();
			expect(
				notificationExists(`update:os-activation-requested:${receipt.version}`),
			).toMatchObject({
				key: "notifications.updateSystemActivationRequested",
				type: "info",
			});
		});
	}
});
