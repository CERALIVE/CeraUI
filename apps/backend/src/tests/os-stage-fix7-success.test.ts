import { afterEach, expect, test } from "bun:test";
import { spawnWithTimeout } from "../helpers/spawn-policy.ts";
import {
	setOsStageEntryDepsForTest,
	stageOsBundle,
} from "../modules/system/update-orchestrator/os-agent.ts";
import { beginOsStageAttempt } from "../modules/system/update-orchestrator/os-stage-attempt.ts";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import {
	checkUpdatesNow,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	setOrchestratorRuntimeDepsForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import {
	fakeDeps,
	testQuarantine,
} from "./helpers/orchestrator-runtime-harness.ts";
import { settings, trustedEntry } from "./helpers/os-stage-fix6-trust.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { manifest } from "./helpers/os-stage-run-inputs.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	setOsStageEntryDepsForTest(null);
});

test("never replays a positive CLI exit after same-tick topology loss", async () => {
	// Given Atlas's real zero-exit/open-output scenario through the runtime and production stage chain.
	const h = await harness();
	let dispatches = 0;
	let jobs = 0;
	const exits: number[] = [];
	setOsStageEntryDepsForTest({
		...trustedEntry,
		runJob: async (offer, control) => {
			jobs++;
			return runOsStageJob(offer, control, {
				...h.deps,
				attempt: (input) => {
					const dispatch = ++dispatches;
					let watch: (() => void) | undefined;
					return beginOsStageAttempt(input, {
						run: (_argv, opts) =>
							spawnWithTimeout(
								dispatch === 1
									? ["bash", "-c", "sleep 0.2 & exit 0"]
									: ["true"],
								{
									...opts,
									onExit: (code) => {
										opts?.onExit?.(code);
										exits.push(code);
										if (dispatch === 1) watch?.();
									},
								},
							),
						topology: async () => ({ kind: "lost", reason: "admin-down" }),
						https: async () => ({ kind: "unavailable" }),
						every: (ms, action) => {
							if (ms === 3_000) watch = action;
							return () => {};
						},
					});
				},
				prepareReceipt: async () => () => {
					control.commit?.(offer);
					return offer;
				},
			});
		},
	});
	setOrchestratorRuntimeDepsForTest(
		fakeDeps({
			loadSettings: async () => settings,
			loadCapabilities: async () => ({
				mode: "capable",
				features: ["apt-all-packages", "rauc-verity-streaming"],
			}),
			quarantine: testQuarantine(),
			checkOsManifest: async () => ({
				available: true,
				rateLimited: false,
				failed: false,
				reason: "",
				manifest,
			}),
			stageOs: async (...args) => {
				await stageOsBundle(...args);
			},
			isOsStageReady: async () => true,
			readOsStageJob: async () => null,
			armOs: async () => {},
		}),
	);
	await checkUpdatesNow();
	// When the positive-exit callback runs the production topology-loss evaluator before drainage.
	await installUpdatesNow();
	// Then this successful but unpublished install is terminal, not a second transport attempt.
	expect(dispatches).toBe(1);
	expect(exits).toEqual([0]);
	expect(getOrchestratorState()).toMatchObject({
		phase: "failed",
		osStageRecovery: { mode: "unsafe", failedRounds: 1, nextRetryAt: null },
	});
	await installUpdatesNow();
	expect(jobs).toBe(1);
});
