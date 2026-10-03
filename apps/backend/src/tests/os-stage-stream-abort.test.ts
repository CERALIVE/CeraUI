import { expect, test } from "bun:test";
import { killAndRestartRaucForStream } from "../modules/system/update-orchestrator/stream-abort.ts";

test("D8 waits only for restart submission, never for the captured five-minute daemon recovery", async () => {
	// Given a daemon that cannot finish stopping promptly, when D8 submits restart.
	const commands: string[][] = [];
	await killAndRestartRaucForStream(async (argv) => {
		commands.push(argv);
		return { exitCode: 0, stdout: "", stderr: "" };
	});
	// Then only argv submission is awaited; --no-block cannot wait on the daemon job.
	expect(commands).toEqual([
		["systemctl", "kill", "--signal=SIGTERM", "rauc.service"],
		["systemctl", "restart", "--no-block", "rauc.service"],
	]);
});

test("a real restart submission refusal still propagates", async () => {
	// Given PID 1 refuses the restart command, when D8 attempts submission.
	const result = killAndRestartRaucForStream(async (argv) => ({
		exitCode: argv.includes("restart") ? 1 : 0,
		stdout: "",
		stderr: "submission denied",
	}));
	// Then it is never confused with a successfully queued restart.
	await expect(result).rejects.toHaveProperty(
		"reason",
		"rauc_recovery_unproven",
	);
});
