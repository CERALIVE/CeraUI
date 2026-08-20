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
 * The two MUTATION ports the certified USB-mode transaction needs and that
 * `@ceralive/modem-control` deliberately ships only as interfaces: an MM
 * inhibit/uninhibit pair, and a raw AT sender.
 *
 * WHY MM INHIBIT IS A LONG-RUNNING CHILD RATHER THAN A D-BUS CALL. ModemManager's
 * inhibition is scoped to the CALLER's bus connection — it ends when that caller
 * goes away, which is what makes it safe (a crashed maintenance tool cannot leave
 * the fleet's modems permanently unmanaged). `mmcli --inhibit-device=<uid>` holds
 * exactly such a connection open until it is signalled, so the lease IS the child
 * process and releasing it is killing that child. A one-shot D-Bus method call
 * would return, drop its connection, and un-inhibit immediately.
 *
 * WHY THE AT SENDER TALKS TO THE TTY DIRECTLY. The transaction sends its AT
 * command only while the modem is inhibited, and an inhibited modem is precisely
 * one ModemManager has RELEASED its ports for — so there is no daemon to route
 * through, and `mmcli --command` would be answered by a daemon that is no longer
 * holding the device. The port is opened, written, read with a bounded deadline,
 * and closed; the caller's own watchdog (`AtCommandLease`) is the outer bound.
 *
 * Both ports are argv-only and take no shell. Every path here is reachable only
 * from inside a held mutation lease on a provisioned device.
 */

import { constants as fsConstants, open } from "node:fs/promises";
import type {
	AtCommandSender,
	AtResponse,
	InhibitLease,
} from "@ceralive/modem-control";

import { logger } from "../../helpers/logger.ts";
import { spawnWatcher } from "../../helpers/spawn-policy.ts";

const INHIBIT_SETTLE_MS = 750;
const INHIBIT_READY_TIMEOUT_MS = 20_000;
const INHIBIT_READY_POLL_MS = 500;
const AT_READ_TIMEOUT_MS = 10_000;
const AT_POLL_MS = 100;

export type InhibitPort = {
	inhibit(uid: string): Promise<InhibitLease>;
	uninhibit(lease: InhibitLease): Promise<void>;
};

export interface InhibitPortDeps {
	spawn(uid: string): { kill(): void; readonly exited: Promise<unknown> };
	wait(ms: number): Promise<void>;
	now(): number;
	/**
	 * Positive evidence that ModemManager has actually LET GO of the AT port.
	 *
	 * `INHIBIT_SETTLE_MS` alone is a guess, and board measurement showed the
	 * guess is wrong for this SKU in its MBIM composition: 750 ms after the
	 * child starts MM still holds `ttyUSB7`, an open+read on it never returns,
	 * and the transaction dies on its own 30 s watchdog with
	 * `AT command timed out` — while the modem had in fact answered, so the
	 * reply was still queued for whoever drained the port next. The same probe
	 * under a 3 s wait answered in 7 ms. Absent, the settle delay alone is used,
	 * which is the pre-measurement behaviour.
	 */
	confirmPortFree?: () => Promise<boolean>;
}

export const defaultInhibitPortDeps: InhibitPortDeps = {
	spawn: (uid) => {
		const handle = spawnWatcher(["mmcli", `--inhibit-device=${uid}`]);
		return { kill: handle.abort, exited: handle.proc.exited };
	},
	wait: (ms) =>
		new Promise((resolve) => {
			setTimeout(resolve, ms);
		}),
	now: () => Date.now(),
};

/**
 * An inhibit port whose lease is a live `mmcli --inhibit-device` child.
 *
 * `uninhibit` is idempotent and never throws: the transaction calls it from a
 * `finally` and from its own watchdog, and an inhibition that outlives the
 * transaction is far worse than one released twice.
 */
export function createInhibitPort(
	deps: InhibitPortDeps = defaultInhibitPortDeps,
): InhibitPort {
	const children = new Map<string, { kill(): void }>();
	return {
		async inhibit(uid) {
			const child = deps.spawn(uid);
			children.set(uid, child);
			// MM releases the device asynchronously after the call is accepted, so
			// the AT port is not free the instant the child starts.
			await deps.wait(INHIBIT_SETTLE_MS);
			await deps.confirmPortFree?.();
			return { uid, acquiredAt: deps.now() as InhibitLease["acquiredAt"] };
		},
		uninhibit(lease) {
			const child = children.get(lease.uid);
			children.delete(lease.uid);
			try {
				child?.kill();
			} catch (err) {
				logger.warn("releasing a modem inhibition failed", {
					module: "modems",
					uid: lease.uid,
					err,
				});
			}
			return Promise.resolve();
		},
	};
}

/**
 * Poll a bare `AT` handshake until the port answers, bounded.
 *
 * O_NONBLOCK is what makes this SAFE to call against a port ModemManager may
 * still be holding: the failure mode being probed for is precisely an open/read
 * that never returns, so a blocking probe would wedge on the first attempt
 * instead of reporting it. It answers `false` rather than throwing — a port that
 * never frees is the transaction's own AT timeout to report, not this probe's.
 */
export async function waitForAtPortReady(
	path: string,
	deps: Pick<AtSenderDeps, "now" | "wait"> = defaultAtSenderDeps,
): Promise<boolean> {
	const deadline = deps.now() + INHIBIT_READY_TIMEOUT_MS;
	while (deps.now() < deadline) {
		if (await probeAtPort(path)) return true;
		await deps.wait(INHIBIT_READY_POLL_MS);
	}
	return false;
}

async function probeAtPort(path: string): Promise<boolean> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(
			path,
			fsConstants.O_RDWR | fsConstants.O_NOCTTY | fsConstants.O_NONBLOCK,
		);
		await handle.write("AT\r");
		for (let attempt = 0; attempt < 10; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			const buffer = Buffer.alloc(512);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (buffer.subarray(0, bytesRead).toString("utf8").includes("OK")) {
				return true;
			}
		}
		return false;
	} catch {
		return false;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export interface AtSenderDeps {
	openPort(path: string): Promise<{
		write(data: string): Promise<void>;
		read(): Promise<string>;
		close(): Promise<void>;
	}>;
	now(): number;
	wait(ms: number): Promise<void>;
}

async function openTty(path: string): Promise<{
	write(data: string): Promise<void>;
	read(): Promise<string>;
	close(): Promise<void>;
}> {
	// O_NOCTTY IS LOAD-BEARING, NOT HYGIENE. A systemd service has no controlling
	// terminal, so opening a tty without it makes THAT tty the controlling one —
	// and the AT command this port exists to send is the one that resets the
	// modem, which tears its own tty down. Board-measured on `ceralive2`: the
	// kernel logged `option1 ttyUSB7 … now disconnected` and 2.9 s later
	// `ceralive.service: Deactivated successfully` — the backend was hung up by
	// the device it had just told to restart, mid-transaction, leaving the
	// journal entry for systemd's replay to quarantine even though the hardware
	// switch had actually succeeded.
	const handle = await open(path, fsConstants.O_RDWR | fsConstants.O_NOCTTY);
	return {
		write: async (data) => {
			await handle.write(data);
		},
		read: async () => {
			const buffer = Buffer.alloc(4096);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			return buffer.subarray(0, bytesRead).toString("utf8");
		},
		close: () => handle.close(),
	};
}

export const defaultAtSenderDeps: AtSenderDeps = {
	openPort: openTty,
	now: () => Date.now(),
	wait: (ms) =>
		new Promise((resolve) => {
			setTimeout(resolve, ms);
		}),
};

/** `OK` / `ERROR` are the only AT terminators; anything else is still in flight. */
function terminatorOf(raw: string): "ok" | "error" | undefined {
	if (/\r?\nOK\r?\n?$/.test(raw) || raw.trimEnd().endsWith("OK")) return "ok";
	if (/ERROR/.test(raw)) return "error";
	return undefined;
}

export function createAtSender(
	portPath: string,
	deps: AtSenderDeps = defaultAtSenderDeps,
): AtCommandSender {
	return {
		async send(command: string): Promise<AtResponse> {
			const port = await deps.openPort(portPath);
			try {
				await port.write(`${command}\r`);
				const deadline = deps.now() + AT_READ_TIMEOUT_MS;
				let raw = "";
				while (deps.now() < deadline) {
					raw += await port.read();
					const terminator = terminatorOf(raw);
					if (terminator !== undefined) {
						return { ok: terminator === "ok", raw };
					}
					await deps.wait(AT_POLL_MS);
				}
				return { ok: false, raw };
			} finally {
				await port.close().catch(() => undefined);
			}
		},
	};
}
