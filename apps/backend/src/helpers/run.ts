/*
    CeraUI - web UI for the CERALIVE project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
 * Typed, argv-only OS command runner.
 *
 * This is the security foundation for the backend's interaction with the host
 * OS. Every command is executed argv-only (NO shell), so SSID/password/service
 * values can never be interpreted as shell syntax — there is no `sh -c` in the
 * path, so `;`, `&&`, `$(...)`, backticks, etc. are inert. The set of binaries
 * that may be invoked is fixed by an ALLOWLIST.
 *
 * Design constraints (deliberate):
 *  - run() is THIN and GENERIC. It does not know about per-binary flag grammars.
 *    Callers validate their own dynamic arguments with argMatch() + the shared
 *    SERVICE_RE / ID_RE regexes before passing them in.
 *  - run() does NOT global-charset-validate argv. Unicode SSIDs and base64
 *    passwords are legitimate argv values and must pass through untouched.
 *  - Mock interception (shouldMockWifi()/shouldMockModems()) does NOT live here.
 *    It stays in the domain module wrappers that call run(); run() always talks
 *    to the real OS.
 *  - runWithStdin() never places a secret on argv — the secret is written to the
 *    child's stdin only.
 */

import { logger } from "./logger.ts";

/** Default stdout/stderr ceiling for buffered (execFile) commands: 10 MiB. */
export const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Default wall-clock budget for a single OS command: 30 s. Sane for the one-shot
 * host queries this runner is built for (nmcli/mmcli/systemctl/ip/…). Long-lived
 * or streaming work (apt-get progress, bcrpt relay) deliberately does NOT go
 * through run()/runWithStdin() — see modules' direct-spawn sites.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

export type RunOpts = {
	/** Max bytes captured from stdout/stderr before the child is killed. */
	maxBuffer?: number;
	/**
	 * Wall-clock budget in ms before the child is killed and the call rejects
	 * with {@link RunTimeoutError}. Defaults to {@link DEFAULT_TIMEOUT_MS} (30 s).
	 * Every side-effect child process MUST carry a bounded timeout (Standard S1).
	 */
	timeout?: number;
	/**
	 * Optional cancellation signal. Aborting it kills the child and rejects the
	 * call with {@link RunAbortError}. An already-aborted signal rejects before
	 * the child is ever spawned.
	 */
	signal?: AbortSignal;
};

/**
 * Rejection raised when a command exceeds its {@link RunOpts.timeout} budget.
 * The child is killed; whatever stdout/stderr was captured before the kill is
 * preserved on the error so callers can surface a partial diagnostic.
 */
export class RunTimeoutError extends Error {
	constructor(
		public readonly cmd: string,
		public readonly partialStdout: string,
		public readonly partialStderr: string,
	) {
		super(`Command timed out: ${cmd}`);
		this.name = "RunTimeoutError";
	}
}

/**
 * Rejection raised when a command is cancelled via {@link RunOpts.signal}. The
 * child is killed; partial stdout/stderr captured before the kill is preserved.
 */
export class RunAbortError extends Error {
	constructor(
		public readonly cmd: string,
		public readonly partialStdout: string = "",
		public readonly partialStderr: string = "",
	) {
		super(`Command aborted: ${cmd}`);
		this.name = "RunAbortError";
	}
}

/** Error shape carried on a non-zero exit — parity with exec.ts execFileP. */
type RunFailureError = Error & {
	stdout: string;
	stderr: string;
	code: number;
};

/**
 * Binaries the backend is permitted to execute. This is the single source of
 * truth for every Wave 2 hardening task (network, modems, system, sensors,
 * logs, updates, power). Adding a binary here is a security decision — keep it
 * minimal and intentional.
 */
export const ALLOWED: Set<string> = new Set<string>([
	"nmcli",
	"mmcli",
	"systemctl",
	"journalctl",
	"ip",
	"apt-get",
	"grep",
	"killall",
	"sensors",
	"ifconfig",
	"passwd",
	"reboot",
	"dmesg",
]);

/**
 * Validation pattern for systemd-style service / unit names.
 * Allows letters, digits and the unit punctuation set `@ . _ : -`.
 */
export const SERVICE_RE: RegExp = /^[A-Za-z0-9@._:-]+$/;

/**
 * Validation pattern for generic identifiers (interface names, modem ids,
 * connection ids, etc.). Stricter than SERVICE_RE — no `@` or `:`.
 */
export const ID_RE: RegExp = /^[A-Za-z0-9_.-]+$/;

/**
 * Validate a single dynamic argv value against `re` and return it unchanged.
 *
 * Throws if the value does not match `re`, OR if it begins with `-` (which a
 * downstream binary could otherwise mis-parse as a flag — argument injection).
 * The returned value is the same string, so call sites can inline it:
 *
 *   run("systemctl", ["restart", argMatch(SERVICE_RE, unit)]);
 */
export function argMatch(re: RegExp, v: string): string {
	if (!re.test(v) || v.startsWith("-")) {
		throw new Error(`invalid argument: ${v}`);
	}
	return v;
}

/** Argv tokens whose *following* token is a secret and must not be logged. */
const SECRET_FLAG_RE = /pass(word)?|secret|psk|token|key|pin|puk/i;

/**
 * Produce a log-safe rendering of argv: any token that immediately follows a
 * secret-looking flag is replaced with `***`. Best-effort only — callers that
 * handle secrets should also prefer runWithStdin().
 */
function redactArgs(args: string[]): string {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const prev = i > 0 ? args[i - 1] : undefined;
		if (prev !== undefined && SECRET_FLAG_RE.test(prev)) {
			out.push("***");
		} else {
			out.push(args[i] ?? "");
		}
	}
	return out.join(" ");
}

type CollectResult = { stdout: string; stderr: string; code: number };

/**
 * Spawn a child argv-only and collect stdout/stderr INCREMENTALLY into mutable
 * accumulators, so a timeout/abort kill still leaves whatever arrived so far
 * readable. Races the natural exit against the timeout timer and the abort
 * signal; the loser is killed and the accumulated output is handed back to the
 * caller for the typed-error path. Also enforces the `maxBuffer` ceiling
 * (parity with exec.ts readCapped) by killing the child on overflow.
 */
async function spawnCollect(
	cmd: string,
	argv: string[],
	opts: {
		maxBuffer: number;
		timeout: number;
		signal?: AbortSignal;
		input?: string;
	},
): Promise<CollectResult> {
	const { maxBuffer, timeout, signal, input } = opts;
	const acc = { stdout: "", stderr: "" };

	if (signal?.aborted) {
		throw new RunAbortError(cmd);
	}

	const child = Bun.spawn(argv, {
		stdin: input === undefined ? "ignore" : "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	if (input !== undefined) {
		// Secret goes to stdin ONLY — never to argv.
		child.stdin.write(input);
		child.stdin.end();
	}

	const kill = () => {
		try {
			child.kill();
		} catch {
			// best-effort: the process may have already exited
		}
	};

	let overflow: Error | undefined;
	const drain = async (
		stream: ReadableStream<Uint8Array> | undefined,
		key: "stdout" | "stderr",
	): Promise<void> => {
		if (!stream) return;
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let total = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value) continue;
				total += value.byteLength;
				if (total > maxBuffer) {
					overflow = new Error(`${key} maxBuffer length exceeded`);
					kill();
					break;
				}
				acc[key] += decoder.decode(value, { stream: true });
			}
			acc[key] += decoder.decode();
		} finally {
			reader.releaseLock();
		}
	};

	const stdoutDone = drain(child.stdout, "stdout");
	const stderrDone = drain(child.stderr, "stderr");

	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		const outcome = await new Promise<"exit" | "timeout" | "abort">(
			(resolve) => {
				void child.exited.then(() => resolve("exit"));
				timer = setTimeout(() => resolve("timeout"), timeout);
				if (signal) {
					onAbort = () => resolve("abort");
					signal.addEventListener("abort", onAbort, { once: true });
				}
			},
		);

		if (outcome !== "exit") {
			kill();
			await Promise.allSettled([stdoutDone, stderrDone, child.exited]);
			if (outcome === "timeout") {
				throw new RunTimeoutError(cmd, acc.stdout, acc.stderr);
			}
			throw new RunAbortError(cmd, acc.stdout, acc.stderr);
		}

		await Promise.allSettled([stdoutDone, stderrDone]);
		if (overflow) throw overflow;
		return {
			stdout: acc.stdout,
			stderr: acc.stderr,
			code: child.exitCode ?? 0,
		};
	} finally {
		if (timer) clearTimeout(timer);
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Run an allowlisted binary argv-only (NO shell) and resolve with its stdout.
 *
 * @throws if `bin` is not in {@link ALLOWED}.
 * @throws {@link RunTimeoutError} if the command exceeds its timeout budget.
 * @throws {@link RunAbortError} if `opts.signal` is aborted.
 * @throws on non-zero exit (error carries `stdout`/`stderr`/`code`) or maxBuffer overflow.
 */
export async function run(
	bin: string,
	args: string[],
	opts?: RunOpts,
): Promise<string> {
	if (!ALLOWED.has(bin)) {
		throw new Error(`binary not allowlisted: ${bin}`);
	}

	const redacted = `${bin} ${redactArgs(args)}`.trim();
	logger.debug(`run: ${redacted}`);

	const { stdout, stderr, code } = await spawnCollect(
		redacted,
		[bin, ...args],
		{
			maxBuffer: opts?.maxBuffer ?? DEFAULT_MAX_BUFFER,
			timeout: opts?.timeout ?? DEFAULT_TIMEOUT_MS,
			...(opts?.signal ? { signal: opts.signal } : {}),
		},
	);

	if (code !== 0) {
		const err = new Error(`Command failed: ${redacted}`) as RunFailureError;
		err.stdout = stdout;
		err.stderr = stderr;
		err.code = code;
		throw err;
	}
	return stdout;
}

/**
 * Run an allowlisted binary argv-only and feed `input` to its stdin.
 *
 * The secret `input` is written to the child's stdin and is NEVER placed on
 * argv (so it cannot leak via the process table / `ps`). Resolves with stdout
 * when the child exits 0; rejects with stderr (or the spawn error) otherwise.
 *
 * @throws if `bin` is not in {@link ALLOWED}.
 * @throws {@link RunTimeoutError} / {@link RunAbortError} on timeout / abort.
 */
export async function runWithStdin(
	bin: string,
	args: string[],
	input: string,
	opts?: RunOpts,
): Promise<string> {
	if (!ALLOWED.has(bin)) {
		throw new Error(`binary not allowlisted: ${bin}`);
	}

	const redacted = `${bin} ${redactArgs(args)}`.trim();
	logger.debug(`runWithStdin: ${redacted} <stdin redacted>`);

	const { stdout, stderr, code } = await spawnCollect(
		redacted,
		[bin, ...args],
		{
			maxBuffer: opts?.maxBuffer ?? DEFAULT_MAX_BUFFER,
			timeout: opts?.timeout ?? DEFAULT_TIMEOUT_MS,
			input,
			...(opts?.signal ? { signal: opts.signal } : {}),
		},
	);

	if (code === 0) {
		return stdout;
	}
	throw new Error(
		`${bin} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
	);
}
