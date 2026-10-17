import { expect, test } from "bun:test";
import { spawnWithTimeout } from "../helpers/spawn-policy.ts";
import { beginOsStageAttempt } from "../modules/system/update-orchestrator/os-stage-attempt.ts";
import { ranking } from "./helpers/os-stage-run-inputs.ts";

test("positive real CLI exit remains known when cancellation wins before output drainage", async () => {
	// Given an actual Bash exiting zero while its child retains stdout.
	const controller = new AbortController();
	const exited = Promise.withResolvers<void>();
	const transport = ranking(["wlan0"]).ranked[0];
	if (!transport) throw new Error("missing fixture transport");
	const attempt = beginOsStageAttempt(
		{
			url: "fixture",
			transport,
			control: { attemptId: "fixture", signal: controller.signal },
		},
		{
			run: (_argv, opts) =>
				spawnWithTimeout(["bash", "-c", "sleep 0.2 & exit 0"], {
					...opts,
					onExit: (code) => {
						opts?.onExit?.(code);
						controller.abort();
						exited.resolve();
					},
				}),
			topology: async () => ({ kind: "unknown" }),
			https: async () => ({ kind: "unavailable" }),
			every: () => () => {},
		},
	);
	// When cancellation overlaps successful exit and inherited-open output.
	await exited.promise;
	await attempt.cli;
	// Then success evidence survives the failed cancellation outcome independently.
	expect(attempt.cliSucceeded?.()).toBe(true);
	attempt.dispose();
});
