/*
    CeraUI - web UI for the CeraLive project
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

/**
 * One read-only AT exchange on a port ModemManager has released (see
 * `free-at-port.ts`). Unlike a `mmcli --command` reply, a serial reply keeps
 * the modem's echo and its final result code, so a reply counts only once a
 * complete `OK` line has arrived; `ERROR`, `+CME ERROR`, `+CMS ERROR` or no
 * final code before the deadline mean no reading.
 *
 * Only the query below can ever be written. There is no `ATE0`, no
 * other setter and no way to pass anything else: a command outside the list is
 * refused before the port is touched.
 */

import { TtyIoError, type TtyPort } from "./free-at-tty.ts";

/** Every byte sequence this session may write, without its trailing CR. */
export const READ_ONLY_AT_QUERIES = Object.freeze([
	'AT+QENG="servingcell"',
] as const);
export type ReadOnlyAtQuery = (typeof READ_ONLY_AT_QUERIES)[number];

export function isReadOnlyAtQuery(
	command: unknown,
): command is ReadOnlyAtQuery {
	return (
		typeof command === "string" &&
		(READ_ONLY_AT_QUERIES as readonly string[]).includes(command)
	);
}

/** A caller asked for a command outside the read-only list. Nothing was sent. */
export class ReadOnlyAtRefusedError extends Error {
	constructor() {
		super("AT command not in the read-only allowlist");
		this.name = "ReadOnlyAtRefusedError";
	}
}

export type FreeAtReadFailure =
	| "timeout"
	| "modem-error"
	| "port-failed"
	| "port-not-quiet"
	| "reply-too-long";

/** No reading this time. `reason` is a fixed code, never modem text. */
export class FreeAtReadError extends Error {
	constructor(readonly reason: FreeAtReadFailure) {
		super(`free AT read failed: ${reason}`);
		this.name = "FreeAtReadError";
	}
}

export const MAX_REPLY_BYTES = 16384;
const POLL_MS = 5;
const QUIET_MS = 50;
const DRAIN_LIMIT_MS = 300;
const FINAL_ERROR = /^(ERROR|\+CME ERROR\b|\+CMS ERROR\b)/;

export interface SessionClock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

const realClock: SessionClock = {
	now: () => performance.now(),
	sleep: (ms) => Bun.sleep(ms),
};

export class ReadOnlyAtSession {
	/**
	 * True until the port is known to be idle: on a fresh open (the kernel may
	 * still hold a reply to a query a previous holder timed out on) and after any
	 * query that ended without a final result code. A dirty port is drained
	 * before the next write.
	 */
	dirty = true;

	constructor(
		private readonly port: TtyPort,
		private readonly clock: SessionClock = realClock,
	) {}

	/**
	 * Discard pending input, then wait until the port has been silent for
	 * QUIET_MS. A port that keeps talking for DRAIN_LIMIT_MS is not used.
	 */
	async drain(): Promise<void> {
		try {
			this.port.flushInput();
			const end = this.clock.now() + DRAIN_LIMIT_MS;
			let quietSince = this.clock.now();
			while (this.clock.now() - quietSince < QUIET_MS) {
				if (this.clock.now() >= end)
					throw new FreeAtReadError("port-not-quiet");
				const chunk = this.port.read();
				if (chunk && chunk.length === 0)
					throw new FreeAtReadError("port-failed");
				if (chunk) quietSince = this.clock.now();
				// Always yield between reads: a port that never stops talking must
				// not hold the backend's event loop for the whole drain limit.
				await this.clock.sleep(POLL_MS);
			}
		} catch (error) {
			throw asReadError(error);
		}
		this.dirty = false;
	}

	/** Send one allowlisted query; return the reply up to and including its final OK. */
	async query(command: ReadOnlyAtQuery, timeoutMs: number): Promise<string> {
		if (!isReadOnlyAtQuery(command)) throw new ReadOnlyAtRefusedError();
		if (this.dirty) await this.drain();
		const end = this.clock.now() + timeoutMs;
		this.dirty = true; // until a final result code proves the port idle again
		try {
			let pending = new TextEncoder().encode(`${command}\r`);
			while (pending.length) {
				if (this.clock.now() >= end) throw new FreeAtReadError("timeout");
				const n = this.port.write(pending);
				pending = pending.subarray(n);
				if (pending.length) await this.clock.sleep(POLL_MS);
			}
			let text = "";
			let bytes = 0;
			for (;;) {
				const chunk = this.port.read();
				if (chunk && chunk.length === 0)
					throw new FreeAtReadError("port-failed");
				if (chunk) {
					bytes += chunk.length;
					if (bytes > MAX_REPLY_BYTES)
						throw new FreeAtReadError("reply-too-long");
					text += new TextDecoder("latin1").decode(chunk);
					const final = finalCode(text, command);
					if (final === "ok") {
						this.dirty = false;
						return text.replace(/\r\n?/g, "\n");
					}
					if (final === "error") {
						this.dirty = false;
						throw new FreeAtReadError("modem-error");
					}
				}
				if (this.clock.now() >= end) throw new FreeAtReadError("timeout");
				await this.clock.sleep(POLL_MS);
			}
		} catch (error) {
			throw asReadError(error);
		}
	}
}

/** Only complete lines count: a final code split across reads waits for its end. */
function finalCode(
	text: string,
	command: ReadOnlyAtQuery,
): "ok" | "error" | undefined {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	lines.pop(); // the unterminated tail, possibly a final code still arriving
	let correlated = false;
	const prefix = "+QENG:";
	for (const raw of lines) {
		const line = raw.trim();
		if (line === command || line.startsWith(prefix)) correlated = true;
		if (!correlated) continue;
		if (line === "OK") return "ok";
		if (FINAL_ERROR.test(line)) return "error";
	}
	return undefined;
}

function asReadError(error: unknown): Error {
	if (
		error instanceof FreeAtReadError ||
		error instanceof ReadOnlyAtRefusedError
	)
		return error;
	if (error instanceof TtyIoError) return new FreeAtReadError("port-failed");
	return new FreeAtReadError("port-failed");
}
