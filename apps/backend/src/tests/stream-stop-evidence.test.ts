import { expect, test } from "bun:test";
import { createStreamSessionOrchestrator } from "../modules/streaming/stream-session-orchestrator.ts";
import { confirmUnownedEngineStop } from "../modules/streaming/streamloop/stop-evidence.ts";

test.each(["idle", "unknown", "streaming"] as const)(
	"unowned engine Stop requires positive evidence: %s",
	async (runtime) => {
		// Given a real factory whose stop adapter has no locally owned client.
		let marked = false;
		let stops = 0;
		const session = createStreamSessionOrchestrator({
			createAttemptId: () => "unowned",
			setStreamingStatus: () => {},
			queryRuntime: async () => "unknown",
			markStreamingForOta: () => {
				marked = true;
			},
			unmarkStreamingForOta: () => {
				marked = false;
			},
			stopRuntime: () =>
				new Promise<void>((resolve, reject) => {
					confirmUnownedEngineStop(
						async (outcome) => {
							if (outcome.ok) resolve();
							else reject(outcome.error);
						},
						{
							query: async () => runtime,
							stop: (onStopped) => {
								stops++;
								onStopped?.();
								return true;
							},
						},
					);
				}),
		});
		await session.reconcile();
		// When Stop must distinguish client absence from actual engine idle.
		const result = await session.stop("operator");
		// Then unknown retains protection, while live evidence requires an actual stop.
		expect(result.result).toBe(
			runtime === "unknown" ? "stop_failed" : "stopped",
		);
		expect(marked).toBe(runtime === "unknown");
		expect(stops).toBe(runtime === "streaming" ? 1 : 0);
	},
);
