import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { classifySlotSyncProbe } from "../modules/system/update-orchestrator/lock.ts";
import { setOrchestratorStateFilePathForTest } from "../modules/system/update-orchestrator/persistence.ts";
import {
	getOrchestratorState,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
	setOrchestratorRuntimeDepsForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	deps,
	lines,
	matching,
	settleThroughRuntime,
	statusSha256,
	syncing,
} from "./helpers/slot-sync-poll-harness.ts";

let root: string | undefined;

afterEach(async () => {
	resetOrchestratorRuntimeForTest();
	setOrchestratorStateFilePathForTest(null);
	if (root) await rm(root, { recursive: true, force: true });
	root = undefined;
});

describe("B3: each requested property must appear exactly once before the receipt is consulted", () => {
	const loaded = ["LoadState", "loaded"] as const;

	const inactive = ["ActiveState", "inactive"] as const;

	const dead = ["SubState", "dead"] as const;

	const exited = ["ExecMainCode", "1"] as const;

	const status0 = ["ExecMainStatus", "0"] as const;

	const duplicated: ReadonlyArray<readonly [string, ReturnType<typeof lines>]> =
		[
			[
				"ExecMainStatus 1 then 0",
				lines(loaded, inactive, dead, exited, ["ExecMainStatus", "1"], status0),
			],
			[
				"ActiveState active then inactive",
				lines(
					loaded,
					["ActiveState", "active"],
					inactive,
					dead,
					exited,
					status0,
				),
			],
			[
				"ActiveState twice, equal",
				lines(loaded, inactive, inactive, dead, exited, status0),
			],
			[
				"LoadState not-found then loaded",
				lines(
					["LoadState", "not-found"],
					loaded,
					inactive,
					dead,
					exited,
					status0,
				),
			],
			[
				"LoadState twice, equal",
				lines(loaded, loaded, inactive, dead, exited, status0),
			],
			[
				"inactive-clean with ExecMainStatus twice",
				lines(loaded, inactive, dead, ["ExecMainCode", "0"], status0, status0),
			],
			[
				"inactive-clean with ExecMainCode twice",
				lines(
					loaded,
					inactive,
					dead,
					["ExecMainCode", "0"],
					["ExecMainCode", "0"],
					status0,
				),
			],
			["SubState twice", lines(loaded, inactive, dead, dead, exited, status0)],
		];

	for (const [label, result] of duplicated) {
		test(`${label}: never classified as a receipt-consulting shape and never settles`, async () => {
			const verdict = classifySlotSyncProbe(result);
			expect(verdict.kind).not.toBe("succeeded");
			expect(verdict.kind).not.toBe("inactive-clean");
			const { state, cleanup } = await settleThroughRuntime(result);
			expect(state.phase).not.toBe("synced");
			expect(cleanup).toEqual([]);
		});
	}

	test("a single clean instance of each property still settles through the runtime", async () => {
		for (const result of [
			lines(loaded, inactive, dead, exited, status0),
			lines(loaded, inactive, dead, ["ExecMainCode", "0"], status0),
		]) {
			const { state } = await settleThroughRuntime(result);
			expect(state.phase).toBe("synced");
		}
	});
});

describe("B4: a validated terminal exit 75 is a typed refusal on either lifecycle", () => {
	const inactiveExit = (status: string) =>
		lines(
			["LoadState", "loaded"],
			["ActiveState", "inactive"],
			["SubState", "dead"],
			["ExecMainCode", "1"],
			["ExecMainStatus", status],
		);

	test("inactive/dead with ExecMainCode=1 ExecMainStatus=75 is refused, with or without a matching receipt", async () => {
		expect(classifySlotSyncProbe(inactiveExit("75"))).toEqual({
			kind: "refused",
			exitCode: 75,
		});
		for (const receiptStateSha256 of [statusSha256, "b".repeat(64), null]) {
			resetOrchestratorRuntimeForTest();
			const h = deps({
				inspectSlotSync: async () => classifySlotSyncProbe(inactiveExit("75")),
				readSlotSyncEvidence: async () => ({ ...matching, receiptStateSha256 }),
			});
			setOrchestratorRuntimeDepsForTest(h.value);
			syncing();
			await runOrchestratorTick();
			expect(getOrchestratorState().phase).toBe("failed");
			expect(getOrchestratorState().failureReason).toBe(
				"slot-sync refused (exit 75)",
			);
			expect(h.cleanup).toEqual([]);
		}
	});

	test("other nonzero statuses stay failed and status 0 stays succeeded", () => {
		for (const status of ["1", "74", "76"])
			expect(classifySlotSyncProbe(inactiveExit(status))).toEqual({
				kind: "failed",
				exitCode: Number(status),
			});
		expect(classifySlotSyncProbe(inactiveExit("0"))).toEqual({
			kind: "succeeded",
		});
	});
});
