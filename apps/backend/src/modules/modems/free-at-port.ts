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
 * A read-only AT lease on the RM520N-GL's second AT interface, used only while
 * ModemManager provably leaves that port alone.
 *
 * WHY NOT `mmcli --command`. Stock ModemManager answers `Modem.Command` only when
 * the daemon runs with `--debug` (or was built with `-Dat_command_via_dbus`).
 * Turning debug on restarts the daemon, which drops every bearer on the device, and
 * it opens arbitrary AT, setters included, to every authorised caller.
 *
 * WHY NOT INHIBIT. Inhibiting takes the modem's data path down for as long as it
 * is held; a temperature or serving-cell read must never cost the link.
 *
 * THE RELEASED PORT. `ceralive-modem-support` sets `ID_MM_PORT_IGNORE=1` on the tty
 * of USB interface 3 of 2c7c:0801 (ENV only). ModemManager then lists that port as
 * "(ignored)" or not at all and never opens it; it keeps the primary AT port on
 * interface 2, the QMI/MBIM control port and the data port.
 *
 * Before every open, all of these must hold; otherwise nothing is opened and the
 * read answers "unavailable" with a fixed reason:
 *   - ModemManager's physical device is the RM520 USB device (2c7c:0801);
 *   - exactly one tty sits on its interface 3;
 *   - ModemManager's port list does not name that tty, or names it "(ignored)";
 *   - the udev database carries ID_MM_PORT_IGNORE=1 for it;
 *   - no process holds it open.
 * After the exclusive open the same checks run again (our own descriptor
 * excluded) and the USB generation (busnum/devnum) must be unchanged.
 *
 * It never falls back to a ModemManager-owned port, to inhibition or to debug
 * mode, and it never writes anything but the two read-only queries.
 */

import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../../helpers/run.ts";
import { shouldMockModems } from "../../mocks/providers/modems.ts";
import {
	FreeAtReadError,
	type FreeAtReadFailure,
	isReadOnlyAtQuery,
	type ReadOnlyAtQuery,
	ReadOnlyAtRefusedError,
	ReadOnlyAtSession,
} from "./free-at-session.ts";
import {
	closeWithin,
	openExclusiveRawTty,
	TtyOpenError,
	type TtyPort,
} from "./free-at-tty.ts";
import { mmcliBinary, mmcliParseSep } from "./mmcli.ts";

export const RM520_VENDOR = "2c7c";
export const RM520_PRODUCT = "0801";
/** Configuration 1, bInterfaceNumber 03: ModemManager's "secondary" AT port. */
export const RM520_FREE_AT_INTERFACE = "1.3";
/** After an ownership refusal, look again this rarely (sysfs/udev/proc only). */
export const FREE_AT_RECHECK_MS = 600_000;
export const FREE_AT_TRANSIENT_RECHECK_MS = 30_000;
export const FREE_AT_TIMEOUT_LIMIT = 3;
export const FREE_AT_DEFAULT_TIMEOUT_MS = 2000;

export const FREE_AT_UNAVAILABLE_REASONS = [
	"not-rm520",
	"second-at-interface-absent",
	"owned-by-modemmanager",
	"not-released",
	"in-use",
	"device-changed",
	"cannot-open",
	"native-unavailable",
	"port-stuck",
	"repeated-timeouts",
] as const;
export type FreeAtUnavailableReason =
	(typeof FREE_AT_UNAVAILABLE_REASONS)[number];

/** The released port may not be used now. `reason` is fixed, never modem text. */
export class FreeAtUnavailableError extends Error {
	constructor(readonly reason: FreeAtUnavailableReason) {
		super(`free AT port unavailable: ${reason}`);
		this.name = "FreeAtUnavailableError";
	}
}

/** What ModemManager says about one modem: its physical device and its ports. */
export interface FreeAtFacts {
	/** `modem.generic.device`, the USB device's sysfs path. */
	readonly device: string;
	/** `modem.generic.ports`, e.g. `["ttyUSB2 (at)", "ttyUSB3 (ignored)"]`. */
	readonly ports: readonly string[];
}

export interface FreePort {
	readonly tty: string;
	/** `busnum:devnum` of the USB device; changes on every re-enumeration. */
	readonly generation: string;
}

async function text(path: string): Promise<string | undefined> {
	try {
		return (await readFile(path, "utf8")).trim();
	} catch {
		return undefined;
	}
}

/**
 * The tty of interface 3 when every ownership check passes. `root` prefixes
 * every filesystem path (tests); `selfPid` is excluded from the holder scan.
 */
export async function findFreeAtPort(
	facts: FreeAtFacts,
	root = "/",
	selfPid?: number,
): Promise<FreePort> {
	const device = facts.device;
	const name = device.split("/").pop() ?? "";
	if (
		!device.startsWith("/sys/devices/") ||
		device.split("/").some((part) => part === "." || part === "..") ||
		!/^\d+-\d+(\.\d+)*$/.test(name)
	)
		throw new FreeAtUnavailableError("not-rm520");
	const usb = join(root, device);
	if (
		(await text(join(usb, "idVendor"))) !== RM520_VENDOR ||
		(await text(join(usb, "idProduct"))) !== RM520_PRODUCT
	)
		throw new FreeAtUnavailableError("not-rm520");
	let ttys: string[] = [];
	try {
		ttys = (await readdir(join(usb, `${name}:${RM520_FREE_AT_INTERFACE}`)))
			.filter((entry) => /^ttyUSB\d+$/.test(entry))
			.sort();
	} catch {
		ttys = [];
	}
	const tty = ttys.length === 1 ? ttys[0] : undefined;
	if (!tty) throw new FreeAtUnavailableError("second-at-interface-absent");
	for (const entry of facts.ports) {
		const [port, kind] = entry.trim().split(/\s+/, 2);
		if (port === tty && kind !== "(ignored)")
			throw new FreeAtUnavailableError("owned-by-modemmanager");
	}
	const number = await text(join(root, "sys/class/tty", tty, "dev"));
	const udev =
		number && /^\d+:\d+$/.test(number)
			? await text(join(root, "run/udev/data", `c${number}`))
			: undefined;
	if (
		!udev?.split("\n").some((line) => line.trim() === "E:ID_MM_PORT_IGNORE=1")
	)
		throw new FreeAtUnavailableError("not-released");
	if (await heldByOthers(`/dev/${tty}`, root, selfPid))
		throw new FreeAtUnavailableError("in-use");
	const busnum = await text(join(usb, "busnum"));
	const devnum = await text(join(usb, "devnum"));
	if (!busnum || !devnum) throw new FreeAtUnavailableError("not-rm520");
	return { tty, generation: `${busnum}:${devnum}` };
}

/** Whether any process other than `selfPid` holds `target`. Unreadable counts as held. */
export async function heldByOthers(
	target: string,
	root = "/",
	selfPid?: number,
): Promise<boolean> {
	let processes: string[];
	try {
		processes = (await readdir(join(root, "proc"))).filter((p) =>
			/^\d+$/.test(p),
		);
	} catch {
		return true;
	}
	for (const pid of processes) {
		if (selfPid !== undefined && pid === String(selfPid)) continue;
		let fds: string[];
		try {
			fds = await readdir(join(root, "proc", pid, "fd"));
		} catch (error) {
			const code = (error as { code?: string }).code;
			if (code === "ENOENT" || code === "ESRCH") continue; // exited during the scan
			return true;
		}
		for (const fd of fds) {
			try {
				if ((await readlink(join(root, "proc", pid, "fd", fd))) === target)
					return true;
			} catch {
				/* closed during the scan */
			}
		}
	}
	return false;
}

export type FreeAtResult =
	| { readonly ok: true; readonly raw: string }
	| {
			readonly ok: false;
			readonly unavailable: true;
			readonly capturedAt?: number;
			readonly reason: FreeAtUnavailableReason;
	  }
	| {
			readonly ok: false;
			readonly unavailable: false;
			readonly reason: FreeAtReadFailure | "modem-unreadable";
	  };

export interface FreeAtPortDeps {
	/** ModemManager's view of one modem; undefined when it cannot be read. */
	facts(modemId: number): Promise<FreeAtFacts | undefined>;
	open(path: string): Promise<TtyPort>;
	root: string;
	pid: number;
	now(): number;
}

async function mmFreeAtFacts(
	modemId: number,
): Promise<FreeAtFacts | undefined> {
	if (shouldMockModems() || !Number.isSafeInteger(modemId) || modemId < 0)
		return undefined;
	try {
		const parsed = mmcliParseSep(
			await run(mmcliBinary, ["-K", "-m", String(modemId)], {
				timeout: 1500,
				maxBuffer: 65536,
			}),
		);
		const device = parsed["modem.generic.device"];
		const ports = parsed["modem.generic.ports"];
		if (typeof device !== "string") return undefined;
		return { device, ports: Array.isArray(ports) ? ports : [] };
	} catch {
		return undefined;
	}
}

export const defaultFreeAtPortDeps: FreeAtPortDeps = {
	facts: mmFreeAtFacts,
	open: openExclusiveRawTty,
	root: "/",
	pid: process.pid,
	now: () => Date.now(),
};

/**
 * The read-only lease. One read at a time across all modems; each read opens,
 * checks, queries and closes, restoring the line settings. An ownership refusal
 * is remembered per modem for FREE_AT_RECHECK_MS, during which nothing is read
 * or opened for it. Transient refusals and three consecutive timeouts back off
 * for 30 seconds. Close waiting is bounded; a pending cleanup blocks its
 * device/tty generation, independently of the manager ID.
 */
export class FreeAtPorts {
	private readonly deps: FreeAtPortDeps;
	private readonly refused = new Map<
		number,
		{
			reason: FreeAtUnavailableReason;
			at: number;
			until: number;
			identity: string | undefined;
		}
	>();
	private readonly timeouts = new Map<number, number>();
	private readonly closing = new Set<string>();
	private readonly uncertainClosing = new Set<string>();
	private readonly identities = new Map<number, string>();
	private readonly portKeys = new Map<number, string>();
	private queue: Promise<unknown> = Promise.resolve();

	constructor(deps: Partial<FreeAtPortDeps> = {}) {
		this.deps = { ...defaultFreeAtPortDeps, ...deps };
	}

	/** The remembered refusal for a modem, if one is still in force. */
	refusal(modemId: number): FreeAtUnavailableReason | undefined {
		const identity = this.identities.get(modemId);
		const portKey = this.portKeys.get(modemId);
		if (
			(identity && this.closing.has(identity)) ||
			(portKey && this.uncertainClosing.has(portKey))
		)
			return "port-stuck";
		const entry = this.refused.get(modemId);
		return entry && this.deps.now() < entry.until ? entry.reason : undefined;
	}

	read(
		modemId: number,
		query: ReadOnlyAtQuery,
		timeoutMs = FREE_AT_DEFAULT_TIMEOUT_MS,
	): Promise<FreeAtResult> {
		if (!isReadOnlyAtQuery(query))
			return Promise.reject(new ReadOnlyAtRefusedError());
		const result = this.queue.then(() =>
			this.readNow(modemId, query, timeoutMs),
		);
		this.queue = result.catch(() => undefined);
		return result;
	}

	private remember(modemId: number, reason: FreeAtUnavailableReason): void {
		const structural = [
			"not-rm520",
			"second-at-interface-absent",
			"owned-by-modemmanager",
			"not-released",
			"native-unavailable",
		].includes(reason);
		this.refused.set(modemId, {
			reason,
			at: this.deps.now(),
			identity: this.identities.get(modemId),
			until:
				this.deps.now() +
				(structural ? FREE_AT_RECHECK_MS : FREE_AT_TRANSIENT_RECHECK_MS),
		});
	}

	/** Both successful opens and failed setup retain cleanup until settlement. */
	private trackClose(
		identity: string,
		closing: Promise<void>,
		uncertainPort?: string,
	): void {
		this.closing.add(identity);
		if (uncertainPort) this.uncertainClosing.add(uncertainPort);
		void closing
			.finally(() => {
				this.closing.delete(identity);
				if (uncertainPort) this.uncertainClosing.delete(uncertainPort);
			})
			.catch(() => undefined);
	}

	private async readNow(
		modemId: number,
		query: ReadOnlyAtQuery,
		timeoutMs: number,
	): Promise<FreeAtResult> {
		const remembered = this.refused.get(modemId);
		if (
			remembered &&
			remembered.reason !== "port-stuck" &&
			this.deps.now() < remembered.until
		)
			return {
				ok: false,
				unavailable: true,
				reason: remembered.reason,
				capturedAt: remembered.at,
			};
		const facts = await this.deps.facts(modemId);
		if (!facts) {
			this.timeouts.delete(modemId);
			return { ok: false, unavailable: false, reason: "modem-unreadable" };
		}
		let port: TtyPort | undefined;
		let identity: string | undefined;
		let portKey: string | undefined;
		let verifiedOpen = false;
		const perform = async (): Promise<FreeAtResult> => {
			try {
				const before = await findFreeAtPort(facts, this.deps.root);
				// Manager IDs are replaceable. Only a freshly verified device/tty and
				// USB generation may bypass another generation's pending cleanup.
				identity = JSON.stringify([
					facts.device,
					before.tty,
					before.generation,
				]);
				this.identities.set(modemId, identity);
				portKey = JSON.stringify([facts.device, before.tty]);
				this.portKeys.set(modemId, portKey);
				if (
					this.closing.has(identity) ||
					this.uncertainClosing.has(portKey) ||
					(remembered?.reason === "port-stuck" &&
						remembered.identity === identity &&
						this.deps.now() < remembered.until)
				) {
					this.timeouts.delete(modemId);
					return {
						ok: false,
						unavailable: true,
						reason: "port-stuck",
						capturedAt:
							remembered?.reason === "port-stuck" &&
							remembered.identity === identity &&
							this.deps.now() < remembered.until
								? remembered.at
								: this.deps.now(),
					};
				}
				try {
					port = await this.deps.open(join(this.deps.root, "dev", before.tty));
				} catch (error) {
					if (error instanceof TtyOpenError && error.cleanup)
						this.trackClose(identity, error.cleanup, portKey);
					const failure =
						error instanceof TtyOpenError ? error.failure : "failed";
					throw new FreeAtUnavailableError(
						failure === "stuck"
							? "port-stuck"
							: failure === "busy"
								? "in-use"
								: failure === "native-unavailable"
									? "native-unavailable"
									: "cannot-open",
					);
				}
				const after = await findFreeAtPort(
					facts,
					this.deps.root,
					this.deps.pid,
				);
				if (after.tty !== before.tty || after.generation !== before.generation)
					throw new FreeAtUnavailableError("device-changed");
				verifiedOpen = true;
				const raw = await new ReadOnlyAtSession(port).query(query, timeoutMs);
				this.refused.delete(modemId);
				this.timeouts.delete(modemId);
				return { ok: true, raw };
			} catch (error) {
				if (!(error instanceof FreeAtReadError) || error.reason !== "timeout")
					this.timeouts.delete(modemId);
				if (error instanceof FreeAtUnavailableError) {
					this.remember(modemId, error.reason);
					return {
						ok: false,
						unavailable: true,
						reason: error.reason,
						capturedAt: this.refused.get(modemId)?.at ?? this.deps.now(),
					};
				}
				if (error instanceof FreeAtReadError) {
					const count =
						error.reason === "timeout"
							? (this.timeouts.get(modemId) ?? 0) + 1
							: 0;
					this.timeouts.set(modemId, count);
					if (count >= FREE_AT_TIMEOUT_LIMIT) {
						this.timeouts.delete(modemId);
						this.remember(modemId, "repeated-timeouts");
						return {
							ok: false,
							unavailable: true,
							reason: "repeated-timeouts",
							capturedAt: this.refused.get(modemId)?.at ?? this.deps.now(),
						};
					}
					return { ok: false, unavailable: false, reason: error.reason };
				}
				return { ok: false, unavailable: false, reason: "port-failed" };
			}
		};
		const result = await perform();
		if (port && identity) {
			const opened = port;
			const closing = Promise.resolve().then(() => opened.close());
			// Until post-open identity checks pass, the descriptor may belong to
			// any generation encountered during open. Fence the whole port.
			this.trackClose(identity, closing, verifiedOpen ? undefined : portKey);
			if (!(await closeWithin(closing))) {
				this.remember(modemId, "port-stuck");
				return {
					ok: false,
					unavailable: true,
					reason: "port-stuck",
					capturedAt: this.refused.get(modemId)?.at ?? this.deps.now(),
				};
			}
		}
		return result;
	}
}

/** The backend's one lease owner: every free-port reader goes through it. */
export const freeAtPorts = new FreeAtPorts();
