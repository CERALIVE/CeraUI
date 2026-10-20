import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	readOsStageJob,
	retireOsStageJob,
} from "../modules/system/update-orchestrator/os-stage-job-files.ts";
import { reconcileOsStageStartup } from "../modules/system/update-orchestrator/os-stage-startup.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { cleanupRecovery } from "./helpers/os-recovery-harness.ts";
import { harness } from "./helpers/os-stage-startup-harness.ts";

useSessionOwnerForFile();
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

type CrashFixture = {
	readonly boundary: string;
	readonly root: string;
	readonly directory: string;
	readonly lock: string;
	readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">;
};
const fixtures: CrashFixture[] = [];
afterAll(async () => {
	for (const { child, root } of fixtures) {
		child.kill();
		await child.exited;
		await rm(root, { recursive: true, force: true });
	}
});

// Import each fresh VM before the crash guard; stdin still withholds all stage work.
for (const boundary of [
	"restart request",
	"after proof",
	"during wait",
	"successful CLI",
]) {
	const root = await mkdtemp(join(tmpdir(), "os-helper-crash-"));
	const directory = join(root, "job");
	const child = Bun.spawn(
		[
			process.execPath,
			"test",
			fileURLToPath(
				new URL("./helpers/os-stage-helper-crash-child.ts", import.meta.url),
			),
		],
		{
			cwd: fileURLToPath(new URL("../../", import.meta.url)),
			env: {
				...process.env,
				OS_STAGE_CRASH_DIRECTORY: directory,
				OS_STAGE_CRASH_BOUNDARY: boundary,
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	fixtures.push({ boundary, root, directory, lock: join(root, "lock"), child });
	await ready(child.stdout, "OS_STAGE_CHILD_LOADED");
}

for (const { boundary, directory, lock, child } of fixtures) {
	test(`SIGKILL at ${boundary} preserves guardian/private ownership and startup never guesses install success`, async () => {
		// Given real independent flock ownership and a fresh, import-ready producer VM.
		expect(await readOsStageJob(directory, process.getuid?.() ?? 0)).toBeNull();
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
		try {
			await ready(guardian.stdout, "GUARD_READY");
			child.stdin.end();
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
			child.kill();
			await child.exited;
			guardian.kill();
			await guardian.exited;
		}
	}, 15_000);
}
