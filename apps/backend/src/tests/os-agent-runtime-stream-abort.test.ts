import { afterEach, describe, expect, test } from "bun:test";
import {
	admitAndPrepareStreamStart,
	getOrchestratorState,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	runOrchestratorTick,
} from "../modules/system/update-orchestrator/runtime.ts";
import { settings, setup } from "./helpers/os-agent-runtime-harness.ts";

afterEach(() => resetOrchestratorRuntimeForTest());

describe("stream start during an in-flight OS stage", () => {
	function inFlightStage(onAbortWindow: () => Promise<void> = async () => {}) {
		let rejectStage: (error: Error) => void = () => {};
		let stages = 0;
		setup({
			stageOs: () => {
				stages += 1;
				return new Promise<void>((_resolve, reject) => {
					rejectStage = reject;
				});
			},
			killAndRestartRaucForStream: async () => {
				rejectStage(new Error("rauc_install_failed"));
				await new Promise((resolve) => setTimeout(resolve, 5));
				await onAbortWindow();
			},
		});
		return { stages: () => stages };
	}

	test("the interrupted stage returns to os-available, not a sticky failure", async () => {
		inFlightStage();
		const install = installUpdatesNow();
		while (getOrchestratorState().phase !== "os-staging")
			await new Promise((resolve) => setTimeout(resolve, 1));
		expect(await admitAndPrepareStreamStart()).toEqual({ allowed: true });
		await install;
		expect(getOrchestratorState().phase).toBe("os-available");
		expect(getOrchestratorState().failureReason).toBeNull();
	});

	test("no tick starts a second stage while the abort is still restarting RAUC", async () => {
		const { stages } = inFlightStage(async () => {
			await runOrchestratorTick();
		});
		const install = installUpdatesNow();
		while (getOrchestratorState().phase !== "os-staging")
			await new Promise((resolve) => setTimeout(resolve, 1));
		await admitAndPrepareStreamStart();
		await install;
		expect(stages()).toBe(1);
		expect(getOrchestratorState().phase).toBe("os-available");
	});

	type PreflightRead =
		| "onlyMeteredCandidateExists"
		| "isIdle"
		| "loadCapabilities"
		| "loadSettings";

	const pausedPreflights: ReadonlyArray<readonly [PreflightRead, number]> = [
		["onlyMeteredCandidateExists", 2],
		["isIdle", 1],
		["loadCapabilities", 1],
		["loadSettings", 2],
	];

	for (const [read, pausedCall] of pausedPreflights) {
		test(`a tick paused in its ${read} preflight cannot start a second stage across a manual stage and its stream abort`, async () => {
			let releaseTick: () => void = () => {};
			const tickPaused = new Promise<void>((resolve) => {
				releaseTick = resolve;
			});
			let calls = 0;
			const pauseOnce =
				<T>(value: T) =>
				async (): Promise<T> => {
					calls += 1;
					if (calls === pausedCall) await tickPaused;
					return value;
				};
			const settleStage: Array<(error?: Error) => void> = [];
			let stages = 0;
			const baseReads = {
				onlyMeteredCandidateExists: false,
				isIdle: true,
				loadCapabilities: {
					mode: "capable" as const,
					features: [
						"apt-all-packages" as const,
						"rauc-verity-streaming" as const,
					],
				},
				loadSettings: settings,
			};
			const pause = { [read]: pauseOnce(baseReads[read]) };
			const wait = (ms: number) =>
				new Promise((resolve) => setTimeout(resolve, ms));
			setup({
				...pause,
				stageOs: () => {
					stages += 1;
					return new Promise<void>((resolve, reject) => {
						settleStage.push((error) => (error ? reject(error) : resolve()));
					});
				},
				killAndRestartRaucForStream: async () => {
					// Inside the kill/restart window: the paused tick resumes, the
					// SIGTERM then fails stage 1, and only afterwards would any
					// second stage have finished.
					releaseTick();
					await wait(5);
					settleStage[0]?.(new Error("rauc_install_failed"));
					await wait(5);
					for (const settle of settleStage.slice(1)) settle();
				},
			});
			const tick = runOrchestratorTick();
			while (calls < pausedCall) await wait(1);
			const install = installUpdatesNow();
			while (getOrchestratorState().phase !== "os-staging") await wait(1);
			expect(await admitAndPrepareStreamStart()).toEqual({ allowed: true });
			await Promise.all([tick, install]);
			expect(stages).toBe(1);
			expect(getOrchestratorState().phase).toBe("os-available");
			expect(getOrchestratorState().failureReason).toBeNull();
		});
	}

	for (const [label, kill] of [
		[
			"rejects",
			async () => {
				throw new Error("rauc restart failed");
			},
		],
		[
			"throws synchronously",
			() => {
				throw new Error("rauc restart failed");
			},
		],
	] as const) {
		test(`a kill/restart that ${label} propagates, leaves os-available and releases both fences`, async () => {
			let rejectStage: (error: Error) => void = () => {};
			let stages = 0;
			setup({
				stageOs: () => {
					stages += 1;
					if (stages > 1) return Promise.resolve();
					return new Promise<void>((_resolve, reject) => {
						rejectStage = reject;
					});
				},
				killAndRestartRaucForStream: () => {
					rejectStage(new Error("rauc_install_failed"));
					return kill();
				},
			});
			const install = installUpdatesNow();
			while (getOrchestratorState().phase !== "os-staging")
				await new Promise((resolve) => setTimeout(resolve, 1));
			await expect(admitAndPrepareStreamStart()).rejects.toThrow(
				"rauc restart failed",
			);
			expect(getOrchestratorState().phase).toBe("os-available");
			await install;
			expect(getOrchestratorState().phase).toBe("os-available");
			expect(getOrchestratorState().failureReason).toBeNull();
			await runOrchestratorTick();
			expect(stages).toBe(2);
			expect(getOrchestratorState().phase).toBe("os-staged");
		});
	}
});
