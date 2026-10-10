import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { classifySlotSyncProbe } from "../modules/system/update-orchestrator/lock.ts";
import { setOrchestratorStateFilePathForTest } from "../modules/system/update-orchestrator/persistence.ts";
import {
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import {
	evidence,
	fixture,
	pastGrace,
	statusSha256,
} from "./helpers/slot-sync-runtime-harness.ts";

let root: string | undefined;

afterEach(async () => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

describe("reboot-proven slot mirror orchestration", () => {
	describe("the real probe classifier decides whether the receipt may settle", () => {
		const text = (props: Record<string, string>): string =>
			Object.entries(props)
				.map(([key, value]) => `${key}=${value}`)
				.join("\n");

		const settleFrom = async (
			result: { exitCode: number; stdout: string },
			receiptStateSha256: string,
		) => {
			resetOrchestratorRuntimeForTest();
			const h = fixture({
				now: () => pastGrace(7_000),
				inspectSlotSync: async () => classifySlotSyncProbe(result),
			});
			h.setEvidence({ ...evidence, receiptStateSha256 });
			setOrchestratorStateForTest({
				...initialOrchestratorState(0),
				phase: "syncing",
			});
			await runOrchestratorTick();
			return { state: getOrchestratorState(), cleanup: h.cleanup };
		};

		test("the oracle's reproductions never settle synced from a matching receipt", async () => {
			const reproductions: ReadonlyArray<{
				exitCode: number;
				stdout: string;
			}> = [
				{
					exitCode: 1,
					stdout: text({
						LoadState: "loaded",
						ActiveState: "inactive",
						SubState: "dead",
						ExecMainCode: "1",
						ExecMainStatus: "0",
					}),
				},
				{
					exitCode: 0,
					stdout: text({ LoadState: "loaded", ExecMainCode: "1" }),
				},
				{
					exitCode: 0,
					stdout: text({
						LoadState: "loaded",
						ActiveState: "inactive",
						SubState: "dead",
						ExecMainCode: "0",
						ExecMainStatus: "1",
					}),
				},
			];
			for (const result of reproductions) {
				const { state, cleanup } = await settleFrom(result, statusSha256);
				expect(state.phase).toBe("failed");
				expect(state.failureReason).toBe("slot-sync-unit-absent");
				expect(cleanup).toEqual([]);
			}
		});

		test("the captured post-GC text with exit 0 settles synced on a matching receipt", async () => {
			const { state, cleanup } = await settleFrom(
				{
					exitCode: 0,
					stdout: text({
						ExecMainCode: "0",
						ExecMainStatus: "0",
						LoadState: "loaded",
						ActiveState: "inactive",
						SubState: "dead",
					}),
				},
				statusSha256,
			);
			expect(state.phase).toBe("synced");
			expect(cleanup).toEqual(["apt", "downloads", "quarantine", "slots"]);
		});

		test("a genuine complete exit-0 success settles only with this run's receipt", async () => {
			const genuine = {
				exitCode: 0,
				stdout: text({
					LoadState: "loaded",
					ActiveState: "inactive",
					SubState: "dead",
					ExecMainCode: "1",
					ExecMainStatus: "0",
				}),
			};
			const stale = await settleFrom(genuine, "b".repeat(64));
			expect(stale.state.phase).toBe("syncing");
			expect(stale.cleanup).toEqual([]);
			const matching = await settleFrom(genuine, statusSha256);
			expect(matching.state.phase).toBe("synced");
		});
	});
});
