import { expect, spyOn, test } from "bun:test";
import type { EventCode } from "@ceraui/rpc/events";
import * as engine from "../modules/streaming/engine-reconnect.ts";
import * as sources from "../modules/streaming/sources.ts";
import * as srtla from "../modules/streaming/srtla.ts";
import {
	StreamStartFailure,
	typedStartFailure,
} from "../modules/streaming/start-failure-taxonomy.ts";
import * as restoration from "../modules/streaming/stream-restoration.ts";
import * as ownership from "../modules/streaming/stream-session-orchestrator.ts";
import { streamSessionProductionDeps } from "../modules/streaming/stream-session-production.ts";
import * as streaming from "../modules/streaming/streaming.ts";
import {
	AUTOSTART_MAX_LINK_ATTEMPTS,
	autoStartStream,
} from "../modules/streaming/streamloop/autostart.ts";
import * as hardware from "../modules/system/hardware-kind.ts";
import {
	clearedEventTimer,
	eventRecording,
} from "./helpers/stream-event-recording.ts";

const cases = [
	{ name: "start", code: "stream_started", action: "start-stop" },
	{ name: "stop", code: "stream_stopped", action: "start-stop" },
	{ name: "all start and stop emissions", code: "all", action: "start-stop" },
	{ name: "failed stop", code: "stream_stop_failed", action: "stop-failure" },
	{ name: "retry", code: "stream_start_retrying", action: "retry" },
	{ name: "terminal refusal", code: "stream_start_failed", action: "terminal" },
	{
		name: "applied configuration",
		code: "stream_reconfigured",
		action: "config-applied",
	},
	{
		name: "reverted configuration",
		code: "stream_reconfigured",
		action: "config-reverted",
	},
	{
		name: "failed configuration",
		code: "stream_reconfigured",
		action: "config-failed",
	},
	{
		name: "unknown configuration",
		code: "stream_reconfigured",
		action: "config-unknown",
	},
	{
		name: "successful restoration",
		code: "stream_restored",
		action: "restore-success",
	},
	{
		name: "failed restoration",
		code: "stream_restore_failed",
		action: "restore-failure",
	},
	{
		name: "unknown restoration",
		code: "stream_restore_failed",
		action: "restore-unknown",
	},
	{ name: "restoration adoption", code: "all", action: "restore-adopt" },
	{ name: "owner adoption", code: "all", action: "owner-adopt" },
	{ name: "live engine loss", code: "engine_lost", action: "reconnect-live" },
	{
		name: "live engine recovery",
		code: "engine_recovered",
		action: "reconnect-live",
	},
	{ name: "idle engine loss", code: "engine_lost", action: "reconnect-idle" },
	{
		name: "idle engine recovery",
		code: "engine_recovered",
		action: "reconnect-idle",
	},
	{
		name: "autostart link refusal",
		code: "stream_autostart_failed",
		action: "auto-links",
	},
	{
		name: "autostart config refusal",
		code: "stream_autostart_failed",
		action: "auto-config",
	},
] as const satisfies readonly {
	name: string;
	code: EventCode | "all";
	action: string;
}[];

async function runScenario(spec: (typeof cases)[number], throwing: boolean) {
	const action = spec.action;
	const h = eventRecording(throwing ? spec.code : undefined, {
		...(action === "stop-failure"
			? {
					stopRuntime: async () => {
						throw new Error("runtime stop failed");
					},
				}
			: {}),
		...(action === "retry"
			? {
					retryPolicy: {
						maxAttempts: 2,
						totalBudgetMs: 1000,
						baseDelayMs: 1,
						maxDelayMs: 1,
					},
				}
			: {}),
		changeRuntimeConfig: async () => ({
			phase:
				action === "config-reverted"
					? "reverted"
					: action === "config-failed" || action === "config-unknown"
						? "rollback_failed"
						: "applied",
			...(action === "config-unknown"
				? { reason: "engine_connection_lost" }
				: {}),
		}),
	});
	const values: unknown[] = [];
	const errors: string[] = [];
	async function observe(operation: () => Promise<unknown>) {
		try {
			values.push(await operation());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(message);
			values.push({ thrown: message });
		}
	}
	try {
		switch (action) {
			case "start-stop":
				await observe(() => h.start());
				break;
			case "stop-failure":
				await observe(() => h.start());
				await observe(() => h.session.stop("engine_loss"));
				h.setRuntime("idle");
				await observe(() => h.session.reconcile());
				break;
			case "retry": {
				let launches = 0;
				await observe(() =>
					h.start(async ({ attemptId }) => {
						if (++launches === 1)
							throw new StreamStartFailure(
								typedStartFailure(
									attemptId,
									"connect",
									"engine_unavailable",
									"unavailable",
								),
							);
					}),
				);
				break;
			}
			case "terminal":
				await observe(() =>
					h.start(async ({ attemptId }) => {
						throw new StreamStartFailure(
							typedStartFailure(
								attemptId,
								"start-rpc",
								"start_invalid",
								"invalid",
							),
						);
					}),
				);
				await observe(() => h.start());
				break;
			case "config-applied":
			case "config-reverted":
			case "config-failed":
			case "config-unknown":
				await observe(() => h.start());
				await observe(() => h.session.changeConfig({ resolution: "720p" }));
				break;
			case "owner-adopt":
				h.setRuntime("streaming");
				await observe(() => h.session.reconcile());
				break;
			case "restore-success":
			case "restore-failure":
			case "restore-unknown":
			case "restore-adopt": {
				let marker = JSON.stringify({
					armedAt: 1,
					bootId: "11111111-1111-4111-8111-111111111111",
					config: { pipeline: "hdmi" },
				});
				if (action === "restore-adopt") h.setRuntime("streaming");
				await observe(() =>
					restoration.runStreamRestoration({
						marker: {
							markerPath: "unused",
							readBootId: () => "11111111-1111-4111-8111-111111111111",
							readMarker: () => marker,
							writeMarker: (_path, text) => {
								h.trace.push("restore-marker");
								marker = text;
							},
							removeMarker: () => {
								marker = "";
							},
						},
						runtimeState: async () =>
							action === "restore-unknown"
								? "unknown"
								: (await h.session.reconcile()) === "streaming"
									? "streaming"
									: "idle",
						lifecycleState: () => h.session.snapshot().state,
						awaitRecovery: async () => {},
						now: () => 10000,
						unknownDeadlineMs: 0,
						logger: { info() {}, warn() {} },
						launch: async () => {
							if (action === "restore-failure")
								return { ok: false, reason: "start_failed" };
							const result = await h.start();
							return result.result === "started"
								? { ok: true }
								: { ok: false, reason: "start_failed" };
						},
					}),
				);
				if (action === "restore-failure" || action === "restore-unknown")
					await observe(() => h.start());
				break;
			}
			case "reconnect-live":
			case "reconnect-idle": {
				if (action === "reconnect-live") await observe(() => h.start());
				h.setRuntime(action === "reconnect-live" ? "idle" : "streaming");
				const kind = spyOn(hardware, "getHardwareKind").mockResolvedValue(
					"generic",
				);
				const refresh = spyOn(
					sources,
					"refreshAndBroadcastSources",
				).mockResolvedValue(undefined);
				const reconcile = spyOn(
					ownership,
					"reconcileStreamSession",
				).mockImplementation(() => h.session.reconcile());
				const restoring = spyOn(
					restoration,
					"runStreamRestoration",
				).mockResolvedValue({ result: "adopted" });
				h.restores.push(
					() => kind.mockRestore(),
					() => refresh.mockRestore(),
					() => reconcile.mockRestore(),
					() => restoring.mockRestore(),
				);
				let reachable = false;
				const jobs: (() => void)[] = [];
				await observe(() =>
					engine.initEngineConnection({
						refreshCapabilities: async () => {},
						isEngineReachable: () => reachable,
						logger: { info() {}, warn() {} },
						setTimer: (fn) => {
							jobs.push(fn);
							return clearedEventTimer();
						},
						clearTimer: clearTimeout,
					}),
				);
				reachable = true;
				jobs.shift()?.();
				await observe(() => engine.settleEngineReconnect());
				values.push({ remainingReconnects: jobs.length });
				break;
			}
			case "auto-links":
			case "auto-config": {
				const links = spyOn(srtla, "genSrtlaIpList").mockReturnValue(
					action === "auto-links" ? [] : ["192.0.2.1"],
				);
				const invalid = spyOn(streaming, "validateConfig").mockRejectedValue(
					new Error("invalid config"),
				);
				h.restores.push(
					() => links.mockRestore(),
					() => invalid.mockRestore(),
				);
				await observe(() => autoStartStream(AUTOSTART_MAX_LINK_ATTEMPTS));
				await observe(() => h.start());
				break;
			}
			default: {
				const exhaustive: never = action;
				throw new Error(`Unrecognized action ${exhaustive}`);
			}
		}
		await observe(() => h.session.stop("operator"));
		return {
			errors,
			values,
			...h.checkpoint(),
			trace: h.trace,
			notifications: h.notifications,
			attempts: h.attempts,
		};
	} finally {
		h.dispose();
	}
}

test.each(cases)(
	"$name emission failure preserves the real control path and later hooks",
	async (spec) => {
		const baseline = await runScenario(spec, false);
		expect(baseline.errors).toEqual([]);
		expect(baseline.owner.state).toBe("idle");
		expect(baseline.streaming).toBe(false);
		const selected = baseline.attempts.filter(
			(e) => spec.code === "all" || e.code === spec.code,
		);
		expect(selected).toHaveLength(
			spec.code === "all" && spec.action === "start-stop" ? 2 : 1,
		);
		const failing = await runScenario(spec, true);
		expect(failing).toEqual(baseline);
	},
);

test("recording emitter publishes the first failure edge before repeats, stays silent on exit, and publishes reentry once", async () => {
	const h = eventRecording(undefined, {
		stopRuntime: async () => {
			throw new Error("runtime stop failed");
		},
	});
	try {
		await h.start();
		expect(await h.session.stop("engine_loss")).toMatchObject({
			result: "stop_failed",
		});
		expect(h.failureEntries()).toEqual([
			{ code: "stream_stop_failed", params: {} },
		]);
		h.flush();
		expect(
			h.stored.filter((e) => e.code === "stream_stop_failed"),
		).toHaveLength(1);
		streamSessionProductionDeps.setLifecycleState?.("stop_failed");
		expect(h.failureEntries()).toHaveLength(1);
		h.setRuntime("streaming");
		await h.session.reconcile();
		expect(h.checkpoint().published).toBe("streaming");
		expect(h.failureEntries()).toHaveLength(1);
		expect(await h.session.stop("engine_loss")).toMatchObject({
			result: "stop_failed",
		});
		expect(h.failureEntries()).toHaveLength(2);
		h.flush();
		expect(
			h.stored.filter((e) => e.code === "stream_stop_failed"),
		).toHaveLength(2);
		streamSessionProductionDeps.setLifecycleState?.("stop_failed");
		expect(h.failureEntries()).toHaveLength(2);
		h.setRuntime("idle");
		await h.session.reconcile();
		expect(h.checkpoint().published).toBe("idle");
		expect(h.failureEntries()).toHaveLength(2);
	} finally {
		h.dispose();
	}
});

test("a throwing stop event cannot retain duration into a later adopted session", async () => {
	const h = eventRecording("stream_stopped");
	try {
		await h.start();
		expect(await h.session.stop("operator")).toEqual({ result: "stopped" });
		h.flush();
		h.setRuntime("streaming");
		await h.session.reconcile();
		expect(await h.session.stop("operator")).toEqual({ result: "stopped" });
		expect(
			h.attempts
				.filter((e) => e.code === "stream_stopped")
				.map((e) => e.params),
		).toEqual([
			{ cause: "operator", durationSec: 0 },
			{ cause: "operator", durationSec: 0 },
		]);
		expect(h.trace.filter((e) => e === "runtime-stop")).toHaveLength(2);
	} finally {
		h.dispose();
	}
});
