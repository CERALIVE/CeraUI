import { spawn } from "node:child_process";
import { open, readFile, rm, writeFile } from "node:fs/promises";
import {
	prepareSoftwareUpdateOutput,
	readSoftwareUpdateAttempt,
	SOFTWARE_UPDATE_OUTPUT_READ_BYTES,
	softwareUpdateOutputPaths,
	updateSoftwareUpdateAttempt,
} from "../../modules/system/software-update-output.ts";
import type { DetachedAptServiceDeps } from "../../modules/system/software-update-service.ts";

/** Exit status of a session ended by the finished update's own restart. */
export const RESTART_EXIT_CODE = 75;

// The detached unit as PID 1 runs it: started in its own session, outside
// every backend's process tree, so it keeps running when a backend dies; each
// backend sees it only through files they all share. Its real command runs
// with apt-get pointed at the scratch directory.
export function restartTestUnit(
	scratch: string,
	o: {
		readonly failFirstStdoutRead?: boolean;
		/** A FIFO the second stdout read waits on: the test's attached-but-unread window. */
		readonly holdSecondStdoutRead?: string;
		/** Retirement always fails, as a broken `systemctl stop` would. */
		readonly failCleanup?: boolean;
	} = {},
): DetachedAptServiceDeps {
	const fixed = softwareUpdateOutputPaths();
	const unit = `${scratch}/unit`;
	const local = {
		stdout: `${unit}.stdout`,
		stderr: `${unit}.stderr`,
	};
	const uid = process.getuid?.() ?? 0;
	const text = (file: string) => readFile(file, "utf8").catch(() => undefined);
	let stdoutReads = 0;
	return {
		outputPaths: fixed,
		readAttempt: () => readSoftwareUpdateAttempt(local, uid),
		updateAttempt: (change) => updateSoftwareUpdateAttempt(local, change, uid),
		prepareOutput: () => prepareSoftwareUpdateOutput(local, uid),
		start: async (command) => {
			const argv = command
				.slice(command.indexOf("--") + 1)
				.map((arg) => arg.replaceAll("/usr/bin/apt-get", `${scratch}/apt-get`));
			const child = spawn(
				"/bin/bash",
				[
					"-c",
					'"$@" >>"$0.stdout" 2>>"$0.stderr"; echo "$?" >"$0.exit.part" && mv "$0.exit.part" "$0.exit"',
					unit,
					...argv,
				],
				{ detached: true, stdio: "ignore" },
			);
			child.unref();
			await writeFile(`${unit}.pid`, String(child.pid));
		},
		inspect: async () => {
			// systemd's InvocationID: one per started unit (a fixed one for a seeded unit).
			const pid = await text(`${unit}.pid`);
			const invocation = (pid ? Number(pid.trim()).toString(16) : "f").padStart(
				32,
				"0",
			);
			const exit = await text(`${unit}.exit`);
			if (exit !== undefined) {
				const exitCode = Number(exit.trim());
				return {
					kind: "finished",
					exitCode,
					cleanup: exitCode === 0 ? "stop" : "reset-failed",
					invocation,
				};
			}
			return pid === undefined
				? { kind: "absent" }
				: { kind: "running", invocation };
		},
		cleanup: async () => {
			if (o.failCleanup) throw new Error("systemctl stop failed");
			await rm(`${unit}.exit`, { force: true });
			await rm(`${unit}.pid`, { force: true });
		},
		readOutput: async (file, offset) => {
			if (file === fixed.stdout && o.failFirstStdoutRead) {
				stdoutReads++;
				if (stdoutReads === 1)
					throw new Error("EIO: injected first read failure");
				if (stdoutReads === 2 && o.holdSecondStdoutRead)
					await readFile(o.holdSecondStdoutRead, "utf8");
			}
			const path = file === fixed.stdout ? local.stdout : local.stderr;
			const handle = await open(path, "r");
			try {
				const bytes = new Uint8Array(SOFTWARE_UPDATE_OUTPUT_READ_BYTES);
				const { bytesRead } = await handle.read(
					bytes,
					0,
					bytes.byteLength,
					offset,
				);
				return {
					bytes: bytes.subarray(0, bytesRead),
					nextOffset: offset + bytesRead,
				};
			} finally {
				await handle.close();
			}
		},
		sleep: (milliseconds) => Bun.sleep(milliseconds),
	};
}
