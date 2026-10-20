import { expect, test } from "bun:test";
import {
	SpawnTimeoutError,
	type spawnWithTimeout,
} from "../helpers/spawn-policy.ts";
import { beginOsStageAttempt } from "../modules/system/update-orchestrator/os-stage-attempt.ts";
import {
	OS_PIN_HTTPS_POLL_MS,
	probePinnedBundle,
} from "../modules/system/update-orchestrator/os-stage-path.ts";
import { rankTransports } from "../modules/system/update-transport/core.ts";

const selection = rankTransports([
	{
		candidate: { ifname: "wlan0", kind: "wifi", metered: false },
		family: 4,
		hosts: [{ host: "fixture", state: "clear", latencyMs: 1 }],
	},
]);
if (selection.status !== "selected") throw new Error("fixture ranking");
const transport = selection.selected;
const url = "https://images.ceralive.tv/releases/bundle.raucb";

test.each(["launcher", "curl"] as const)(
	"%s deadline uses the real watcher threshold",
	async (deadline) => {
		// Given a live CLI with only the launch/probe boundary injected.
		const cli = Promise.withResolvers<{
			exitCode: number;
			stdout: string;
			stderr: string;
		}>();
		const timers = new Map<number, () => void>();
		const run: typeof spawnWithTimeout = async () => {
			if (deadline === "launcher") throw new SpawnTimeoutError("runuser curl");
			return { exitCode: 28, stdout: "000", stderr: "curl transport deadline" };
		};
		const attempt = beginOsStageAttempt(
			{
				url,
				transport,
				control: { attemptId: "attempt", signal: new AbortController().signal },
			},
			{
				run: () => cli.promise,
				topology: async () => ({ kind: "healthy" }),
				https: () => probePinnedBundle(url, transport, run),
				every: (ms, action) => {
					timers.set(ms, action);
					return () => timers.delete(ms);
				},
			},
		);
		// When two probe deadlines arrive independently of the install CLI.
		for (let count = 0; count < 2; count++) {
			timers.get(OS_PIN_HTTPS_POLL_MS)?.();
			for (let turn = 0; turn < 8; turn++) await Promise.resolve();
		}
		const stillWatching = timers.has(OS_PIN_HTTPS_POLL_MS);
		cli.resolve({ exitCode: 0, stdout: "", stderr: "" });
		// Then an unavailable launcher never spends the failure threshold; curl 28 does.
		expect(stillWatching).toBe(deadline === "launcher");
		expect(await attempt.outcome).toMatchObject(
			deadline === "launcher"
				? { kind: "succeeded" }
				: {
						kind: "failed",
						error: { reason: "os_transport_failed" },
						transfer: { reason: "blocked" },
					},
		);
		await attempt.cli;
	},
);

test("curl can report exit 28 before the launcher supervision deadline", async () => {
	// Given a runner that observes both real command deadlines.
	let headroom = 0;
	// When the adapter submits its HEAD.
	await probePinnedBundle(url, transport, async (argv, options) => {
		headroom =
			(options?.timeoutMs ?? 0) -
			Number(argv[argv.indexOf("--max-time") + 1]) * 1000;
		return { exitCode: 28, stdout: "000", stderr: "" };
	});
	// Then curl's attributable exit can arrive before the outer wrapper is killed.
	expect(headroom).toBeGreaterThan(0);
});
