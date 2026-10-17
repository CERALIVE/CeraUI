import fs from "node:fs";

import {
	collectBoundedChild,
	SpawnAbortError,
	SpawnTimeoutError,
} from "./bounded-spawn.ts";
import { logger } from "./logger.ts";
import { DEFAULT_SPAWN_TIMEOUT_MS } from "./spawn-policy.ts";

export type ExecResult = { stdout: string; stderr: string };

// util.promisify(exec) replacement: runs cmd through Bun's shell (string parsed
// as written) and REJECTS on non-zero exit (Bun.$ throws ShellError).
export const execP = async (cmd: string): Promise<ExecResult> => {
	const res = await Bun.$`${{ raw: cmd }}`.quiet();
	return { stdout: res.stdout.toString(), stderr: res.stderr.toString() };
};

// util.promisify(execFile) replacement: argv-only (NO shell) via Bun.spawn.
// REJECTS on non-zero exit with an error carrying stdout/stderr/code, the shape
// ssh.ts probeSshActive reads off the rejection. Aborting `signal` kills the
// child (run() maps that rejection to RunTimeoutError/RunAbortError).
export const execFileP = async (
	file: string,
	args: readonly string[] = [],
	opts?: { maxBuffer?: number; timeout?: number; signal?: AbortSignal },
): Promise<ExecResult> => {
	const maxBuffer = opts?.maxBuffer ?? 1024 * 1024;
	const timeout = opts?.timeout ?? DEFAULT_SPAWN_TIMEOUT_MS;
	const signal = opts?.signal;

	const command = `${file} ${args.join(" ")}`;
	if (signal?.aborted) {
		throw Object.assign(new SpawnAbortError(command), {
			stdout: "",
			stderr: "",
			code: 1,
		});
	}
	const proc = Bun.spawn([file, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	let stdout: string;
	let stderr: string;
	let exitCode: number;
	try {
		({ stdout, stderr, exitCode } = await collectBoundedChild(proc, command, {
			timeoutMs: timeout,
			maxBuffer,
			...(signal ? { signal } : {}),
		}));
	} catch (error) {
		if (error instanceof SpawnTimeoutError) {
			Object.assign(error, {
				stdout: error.partialStdout,
				stderr: error.partialStderr,
				code: proc.exitCode || 1,
			});
		}
		throw error;
	}

	if (exitCode !== 0) {
		throw Object.assign(new Error(`Command failed: ${command}`), {
			stdout,
			stderr,
			code: exitCode,
		});
	}

	return { stdout, stderr };
};

// Promise-based exec(), but without rejections
export async function execPNR(cmd: string) {
	try {
		const res = await execP(cmd);
		return { stdout: res.stdout, stderr: res.stderr, code: 0 };
	} catch (err) {
		// Bun.$ throws on non-zero exit but the ShellError still carries the
		// captured streams + real exit code: preserve them rather than blanking
		// the output, and log so the failure is never silently swallowed.
		const shellErr = err as {
			stdout?: unknown;
			stderr?: unknown;
			exitCode?: unknown;
		};
		const stdout = shellErr.stdout != null ? String(shellErr.stdout) : "";
		const stderr = shellErr.stderr != null ? String(shellErr.stderr) : "";
		const code = typeof shellErr.exitCode === "number" ? shellErr.exitCode : 1;
		logger.debug(`execPNR: command exited non-zero: ${cmd}`, { code, stderr });
		return { stdout, stderr, code };
	}
}

export function checkExecPathSafe(path: string) {
	try {
		fs.accessSync(path, fs.constants.R_OK);
		return true;
	} catch (_err) {
		logger.error(
			`\n\n${path} not found, double check the settings in setup.json`,
		);
		return false;
	}
}

export function checkExecPath(path: string) {
	if (!checkExecPathSafe(path)) process.exit(1);
}
