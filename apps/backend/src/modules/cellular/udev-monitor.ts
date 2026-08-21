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
 * The supervised `udevadm monitor --property` child behind the optimistic rows.
 *
 * It is the DIRECT TWIN of `NmcliMonitorManager` (`modules/network/monitor/`):
 * one long-lived child, stdout streamed line-by-line through a `TextDecoder`
 * with the partial tail carried across chunk boundaries, respawned under
 * `retryWithBackoff` when it dies, and stopped explicitly at teardown. Both are
 * `watcher`-class spawn sites in `helpers/spawn-policy.ts` — no timeout, a
 * registered shutdown abort — for the same reason: they never return by design.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SUBPROCESS AND NOT A NETLINK LIBRARY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The npm `udev` binding is a native addon that has to be compiled against the
 * running ABI, which is a non-starter for a `bun build --compile` single binary
 * shipped to a device with no toolchain — and it is unmaintained besides.
 * `udevadm` is part of systemd, so it is present on every image that boots one,
 * and the `--property` output is a stable, documented contract. This is the
 * same trade `nmcli monitor` already makes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO ARGUMENTS ARE LOAD-BEARING
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `--udev` selects the events udev emits AFTER rule processing. The `--kernel`
 * events that precede them carry NO `ID_*` properties at all — no `ID_PATH`, no
 * `ID_SERIAL_SHORT`, no `ID_USB_INTERFACES` — so a monitor without it would see
 * every attach and be able to say nothing about any of them.
 *
 * `--subsystem-match=usb/usb_device` narrows the feed to exactly the node this
 * module reads. Without it the monitor is a whole-system firehose (every input,
 * block, sound and net event on the board), and a composite modem alone fans out
 * to a `usb_device` plus one `usb_interface` per function plus each tty/net
 * child. The filter is a cost decision, not a correctness one — the parser
 * re-checks `SUBSYSTEM`/`DEVTYPE` from the properties regardless, so an older
 * udev that ignored the filter would still behave correctly.
 */

import { logger } from "../../helpers/logger.ts";
import { retryWithBackoff } from "../../helpers/retry.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { isRealDevice } from "../system/device-detection.ts";

import {
	cellularAttachFromUdev,
	detachIdPathFromUdev,
	parseUdevPropertyBlock,
} from "./udev-cellular-events.ts";
import {
	getUdevProvisionalCache,
	type UdevProvisionalCache,
} from "./udev-provisional-cache.ts";

const UDEVADM = "udevadm";
const UDEVADM_MONITOR_ARGS = [
	"monitor",
	"--property",
	"--udev",
	"--subsystem-match=usb/usb_device",
] as const;

/**
 * Restart backoff. Effectively unbounded attempts (this is a long-lived
 * supervisor), 100 ms base growing exponentially but capped at 2 s between
 * restarts — identical to the nmcli monitor's, so the two supervisors cannot
 * drift into different recovery behaviour.
 */
const RESTART_BACKOFF = {
	maxAttempts: Number.MAX_SAFE_INTEGER,
	baseDelayMs: 100,
	maxDelayMs: 2000,
} as const;

/** The subset of Bun's `Subprocess` this supervisor depends on. */
export interface UdevMonitorProcess {
	stdout: AsyncIterable<Uint8Array>;
	exited: Promise<number>;
	kill(signal?: number): void;
}

export type SpawnUdevMonitor = () => UdevMonitorProcess;

function spawnUdevMonitor(): UdevMonitorProcess {
	return Bun.spawn([UDEVADM, ...UDEVADM_MONITOR_ARGS], {
		stdout: "pipe",
		stderr: "ignore",
	}) as unknown as UdevMonitorProcess;
}

/**
 * Supervises one `udevadm monitor` child and feeds its events to the cache.
 */
export class UdevMonitorSupervisor {
	#running = false;
	#proc: UdevMonitorProcess | null = null;

	constructor(
		private readonly cache: UdevProvisionalCache = getUdevProvisionalCache(),
		private readonly spawn: SpawnUdevMonitor = spawnUdevMonitor,
	) {}

	start(): void {
		if (this.#running) {
			return;
		}
		this.#running = true;
		void this.#supervise();
	}

	stop(): void {
		this.#running = false;
		const proc = this.#proc;
		this.#proc = null;
		if (proc) {
			try {
				proc.kill();
			} catch (error) {
				logger.debug(`udev monitor kill failed: ${String(error)}`);
			}
		}
		this.cache.clear();
	}

	get isRunning(): boolean {
		return this.#running;
	}

	/**
	 * Supervisor loop. Each attempt runs one child to death; throwing afterwards
	 * triggers the next (backed-off) attempt. Every restart CLEARS the cache
	 * first — the monitor has no historical replay, so a detach that happened
	 * while the child was down would otherwise leave a row nothing can retire.
	 */
	async #supervise(): Promise<void> {
		let attempt = 0;
		try {
			await retryWithBackoff(
				async () => {
					if (!this.#running) {
						return;
					}
					if (attempt > 0) {
						logger.warn("udev monitor restarted; dropping provisional rows");
						this.cache.clear();
					}
					attempt++;
					await this.#runOnce();
					if (!this.#running) {
						return;
					}
					throw new Error("udevadm monitor process exited");
				},
				{ ...RESTART_BACKOFF, shouldRetry: () => this.#running },
			);
		} catch (error) {
			if (this.#running) {
				logger.error(`udev monitor supervisor terminated: ${String(error)}`);
			}
		}
	}

	/**
	 * Stream one child's stdout until it exits, decoding `--property` blocks.
	 *
	 * A block ends at a BLANK line, so the accumulator holds the current block's
	 * lines and flushes on one. The final block before EOF is flushed too: a
	 * child killed at teardown can leave one without its trailing blank line, and
	 * dropping it would silently lose the last event.
	 */
	async #runOnce(): Promise<void> {
		const proc = this.spawn();
		this.#proc = proc;

		const decoder = new TextDecoder();
		let buffer = "";
		let block: string[] = [];

		const consume = (line: string): void => {
			if (line.trim().length === 0) {
				this.#handleBlock(block);
				block = [];
				return;
			}
			block.push(line);
		};

		try {
			for await (const chunk of proc.stdout) {
				buffer += decoder.decode(chunk, { stream: true });
				let newline = buffer.indexOf("\n");
				while (newline !== -1) {
					consume(buffer.slice(0, newline));
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
				}
			}
			buffer += decoder.decode();
			if (buffer.length > 0) {
				consume(buffer);
			}
			this.#handleBlock(block);
		} finally {
			await proc.exited.catch(() => undefined);
			if (this.#proc === proc) {
				this.#proc = null;
			}
		}
	}

	/** Decode one block and apply it. A malformed block never breaks the stream. */
	#handleBlock(lines: readonly string[]): void {
		if (lines.length === 0) {
			return;
		}
		try {
			const event = parseUdevPropertyBlock(lines);
			if (event === undefined) {
				return;
			}
			const attach = cellularAttachFromUdev(event);
			if (attach !== undefined) {
				logger.debug(
					`udev: cellular-class attach at ${attach.idPath} (${attach.evidence})`,
				);
				this.cache.noteAttach(attach);
				return;
			}
			const detached = detachIdPathFromUdev(event);
			if (detached !== undefined) {
				this.cache.noteDetach(detached);
			}
		} catch (error) {
			logger.debug(`udev monitor block parse failed: ${String(error)}`);
		}
	}
}

let supervisor: UdevMonitorSupervisor | null = null;

/**
 * Boot hook: start the monitor on a real device.
 *
 * `isRealDevice()`-gated, and skipped under mocks, for the reason
 * `initEncoderLoad`/`initFan` are: a dev host has no cellular hardware to
 * announce, so publishing nothing is the honest answer AND is what keeps the
 * mock scenarios the single seam for this signal in development. Never throws —
 * the optimistic row is a latency improvement, and a failure here must cost that
 * and nothing else.
 */
export async function initUdevProvisionalMonitor(): Promise<void> {
	if (shouldUseMocks() || !(await isRealDevice())) {
		return;
	}
	supervisor ??= new UdevMonitorSupervisor();
	supervisor.start();
}

/** Stop the monitor and drop every provisional row (teardown / tests). */
export function stopUdevProvisionalMonitor(): void {
	supervisor?.stop();
	supervisor = null;
}
