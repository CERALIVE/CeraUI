import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	readOsStageJob,
	retireOsStageJob,
} from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import { reconcileOsStageStartup } from "../modules/system/update-orchestrator/os-stage-startup.ts";
import { cleanupRecovery } from "./helpers/os-recovery-harness.ts";
import { harness } from "./helpers/os-stage-startup-harness.ts";

afterEach(cleanupRecovery);

async function ready(
	stream: ReadableStream<Uint8Array>,
	marker: string,
): Promise<void> {
	const reader = stream.getReader();
	let text = "";
	try {
		while (!text.includes(marker)) {
			const row = await reader.read();
			if (row.done)
				throw new Error(`child ended before ${marker}: ${text.slice(-2000)}`);
			text += new TextDecoder().decode(row.value);
		}
	} finally {
		reader.releaseLock();
	}
}

test.each(["restart request", "after proof", "during wait", "successful CLI"])(
	"SIGKILL at %s preserves guardian/private ownership and startup never guesses install success",
	async (boundary) => {
		// Given real independent flock ownership and a disk-backed producer record.
		const root = await mkdtemp(join(tmpdir(), "os-helper-crash-"));
		const directory = join(root, "job");
		const lock = join(root, "lock");
		const guardian = Bun.spawn(
			[
				"flock",
				"-x",
				lock,
				"bash",
				"-c",
				'printf "GUARD_READY\\n"; read -r release',
			],
			{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		);
		let child: ReturnType<typeof Bun.spawn> | undefined;
		try {
			await ready(guardian.stdout, "GUARD_READY");
			child = Bun.spawn(
				[
					process.execPath,
					"test",
					fileURLToPath(
						new URL(
							"./helpers/os-stage-helper-crash-child.ts",
							import.meta.url,
						),
					),
				],
				{
					cwd: fileURLToPath(new URL("../../", import.meta.url)),
					env: {
						...process.env,
						OS_STAGE_CRASH_DIRECTORY: directory,
						OS_STAGE_CRASH_BOUNDARY: boundary,
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			if (!(child.stdout instanceof ReadableStream))
				throw new Error("child stdout unavailable");
			await ready(child.stdout, "OS_STAGE_CRASH_READY");
			// When the backend is killed, not gracefully disposed or freshly recreated in memory.
			child.kill("SIGKILL");
			await child.exited;
			const record = await readOsStageJob(directory, process.getuid?.() ?? 0);
			const contender = Bun.spawn(["flock", "-n", "-E", "75", lock, "true"]);
			expect(await contender.exited).toBe(75);
			expect(record?.launched).toBe(true);
			if (!record) throw new Error("crashed producer record missing");
			const h = harness();
			const result = await reconcileOsStageStartup({
				...h.deps,
				readJob: () => readOsStageJob(directory, process.getuid?.() ?? 0),
				cliGone: async () => true,
				observe: async () => ({
					...record.baseline,
					instance: "fresh:100",
					processes: ["fresh:100"],
				}),
				owner: (input) => ({
					...h.deps.owner(input),
					beginAttempt: () => {
						throw new Error("startup must not install");
					},
					release: async () => {
						guardian.kill();
						await guardian.exited;
						await retireOsStageJob(directory);
						h.calls.push("release");
					},
				}),
			});
			// Then fresh physical reconciliation closes residue but never publishes staged success.
			expect(result).toEqual({
				kind: "reconciled",
				attemptId: record.attemptId,
				reason: "os_stage_outcome_unknown_after_restart",
			});
			expect(h.calls).toEqual([
				"restart-submission",
				"settled",
				"drain",
				"sweep",
				"release",
			]);
		} finally {
			child?.kill();
			guardian.kill();
			await guardian.exited;
			await rm(root, { recursive: true, force: true });
		}
	},
	15_000,
);
