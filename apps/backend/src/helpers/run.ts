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

import { spawn } from "node:child_process";

import { execFileP } from "./exec.ts";
import { logger } from "./logger.ts";

/** Default stdout/stderr ceiling for buffered (execFile) commands: 10 MiB. */
export const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

export type RunOpts = {
	/** Max bytes captured from stdout/stderr before the child is killed. */
	maxBuffer?: number;
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
const SECRET_FLAG_RE = /pass(word)?|secret|psk|token|key|pin/i;

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

/**
 * Run an allowlisted binary argv-only (NO shell) and resolve with its stdout.
 *
 * @throws if `bin` is not in {@link ALLOWED}.
 * @throws (via execFileP) if the process exits non-zero or exceeds maxBuffer.
 */
export async function run(
	bin: string,
	args: string[],
	opts?: RunOpts,
): Promise<string> {
	if (!ALLOWED.has(bin)) {
		throw new Error(`binary not allowlisted: ${bin}`);
	}

	const maxBuffer = opts?.maxBuffer ?? DEFAULT_MAX_BUFFER;
	logger.debug(`run: ${bin} ${redactArgs(args)}`);

	const { stdout } = await execFileP(bin, args, { maxBuffer });
	// String() handles both the default string stdout and a Buffer (if a future
	// caller sets an encoding) without a `never`-narrowed branch.
	return String(stdout);
}

/**
 * Run an allowlisted binary argv-only and feed `input` to its stdin.
 *
 * The secret `input` is written to the child's stdin and is NEVER placed on
 * argv (so it cannot leak via the process table / `ps`). Resolves with stdout
 * when the child exits 0; rejects with stderr (or the spawn error) otherwise.
 *
 * @throws if `bin` is not in {@link ALLOWED}.
 */
export function runWithStdin(
	bin: string,
	args: string[],
	input: string,
): Promise<string> {
	if (!ALLOWED.has(bin)) {
		return Promise.reject(new Error(`binary not allowlisted: ${bin}`));
	}

	logger.debug(`runWithStdin: ${bin} ${redactArgs(args)} <stdin redacted>`);

	return new Promise<string>((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });

		let stdout = "";
		let stderr = "";

		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		child.on("error", (err) => {
			reject(err);
		});

		child.on("close", (code) => {
			if (code === 0) {
				resolve(stdout);
			} else {
				reject(
					new Error(
						`${bin} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
					),
				);
			}
		});

		// Secret goes to stdin ONLY — never to argv.
		child.stdin?.write(input);
		child.stdin?.end();
	});
}
