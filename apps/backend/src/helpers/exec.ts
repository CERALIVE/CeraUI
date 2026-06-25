import fs from "node:fs";

import { logger } from "./logger.ts";
import { DEFAULT_SPAWN_TIMEOUT_MS } from "./spawn-policy.ts";

export type ExecResult = { stdout: string; stderr: string };

type ExecFileError = Error & { stdout: string; stderr: string; code: number };

// util.promisify(exec) replacement: runs cmd through Bun's shell (string parsed
// as written) and REJECTS on non-zero exit (Bun.$ throws ShellError).
export const execP = async (cmd: string): Promise<ExecResult> => {
	const res = await Bun.$`${{ raw: cmd }}`.quiet();
	return { stdout: res.stdout.toString(), stderr: res.stderr.toString() };
};

// util.promisify(execFile) replacement: argv-only (NO shell) via Bun.spawn.
// REJECTS on non-zero exit with an error carrying stdout/stderr/code, the shape
// ssh.ts probeSshActive reads off the rejection.
export const execFileP = async (
	file: string,
	args: readonly string[] = [],
	opts?: { maxBuffer?: number; timeout?: number },
): Promise<ExecResult> => {
	const maxBuffer = opts?.maxBuffer ?? 1024 * 1024;
	const timeout = opts?.timeout ?? DEFAULT_SPAWN_TIMEOUT_MS;

	const proc = Bun.spawn([file, ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	const kill = () => {
		try {
			proc.kill();
		} catch {}
	};

	// bounded-command (spawn-policy): a hung one-shot is killed at the wall-clock
	// budget so a stuck host binary can never wedge the call forever.
	const timer = setTimeout(kill, timeout);

	const [stdout, stderr, code] = await Promise.all([
		readCapped(proc.stdout, maxBuffer, kill),
		readCapped(proc.stderr, maxBuffer, kill),
		proc.exited,
	]);
	clearTimeout(timer);

	if (code !== 0) {
		const err = new Error(
			`Command failed: ${file} ${args.join(" ")}`,
		) as ExecFileError;
		err.stdout = stdout;
		err.stderr = stderr;
		err.code = code;
		throw err;
	}

	return { stdout, stderr };
};

/**
 * Drain a piped child stream to a string, killing the child (via `onOverflow`)
 * and throwing once `maxBuffer` bytes are exceeded — preserving the Node
 * `execFile` "maxBuffer length exceeded" protection. Killing the child lets the
 * sibling stream + `proc.exited` settle so the surrounding `Promise.all` cannot
 * leak the subprocess.
 */
async function readCapped(
	stream: ReadableStream<Uint8Array> | undefined,
	maxBuffer: number,
	onOverflow: () => void,
): Promise<string> {
	if (!stream) return "";

	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBuffer) {
				onOverflow();
				throw new Error("stdout maxBuffer length exceeded");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks).toString();
}

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
		const code =
			typeof shellErr.exitCode === "number" ? shellErr.exitCode : 1;
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
