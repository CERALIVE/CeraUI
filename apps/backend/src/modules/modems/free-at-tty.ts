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
 * The native half of the read-only AT lease: open one tty exclusively, raw,
 * non-blocking, and put its line settings back on close.
 *
 * Node's fs cannot issue `TIOCEXCL` or touch termios, so those four calls go
 * through libc. Nothing here writes to the device; the session above decides
 * what may be written. The mutation path (`transition-ports.ts`) is unrelated
 * and unchanged: it runs only while ModemManager is inhibited.
 */

import {
	close as fsClose,
	constants as fsConstants,
	openSync,
	readSync,
	writeSync,
} from "node:fs";

/**
 * One open tty. `read` answers `null` when nothing is waiting, an empty array
 * when the port has hung up, and throws TtyIoError on any other failure.
 */
export interface TtyPort {
	read(): Uint8Array | null;
	/** Bytes accepted; 0 when the output buffer is full right now. */
	write(data: Uint8Array): number;
	/** Discard input the kernel has buffered but nobody has read. */
	flushInput(): void;
	/** Restore the saved line settings, drop exclusivity, close. Idempotent. */
	close(): Promise<void>;
}

export type TtyOpenFailure = "busy" | "failed" | "native-unavailable" | "stuck";

export class TtyOpenError extends Error {
	constructor(
		readonly failure: TtyOpenFailure,
		readonly cleanup?: Promise<void>,
	) {
		super(`tty open failed: ${failure}`);
		this.name = "TtyOpenError";
	}
}

/** The port vanished or failed mid-session (EIO after unplug, EBADF, …). */
export class TtyIoError extends Error {
	constructor() {
		super("tty read/write failed");
		this.name = "TtyIoError";
	}
}

// asm-generic ioctl numbers and termios layout, identical on x86-64 and arm64,
// the architectures this backend ships for (the FFI signatures below also
// assume a 64-bit `unsigned long`). Anything else is refused rather than guessed.
const TIOCEXCL = 0x540c;
const TIOCNXCL = 0x540d;
const TCSANOW = 0;
const TCIFLUSH = 0;
const B115200 = 0o010002;
const CREAD = 0o000200;
const CLOCAL = 0o004000;
const CRTSCTS = 0o20000000000;
const CFLAG_OFFSET = 8;
const CC_OFFSET = 17;
const VTIME = 5;
const VMIN = 6;
const TERMIOS_BYTES = 64; // glibc's struct termios is 60 bytes
const SUPPORTED_ARCH = new Set(["x64", "arm64"]);

interface Libc {
	ioctl(fd: number, request: number): number;
	tcgetattr(fd: number, termios: Uint8Array): number;
	tcsetattr(fd: number, action: number, termios: Uint8Array): number;
	cfmakeraw(termios: Uint8Array): void;
	cfsetispeed(termios: Uint8Array, speed: number): number;
	cfsetospeed(termios: Uint8Array, speed: number): number;
	tcflush(fd: number, queue: number): number;
}

let libc: Libc | null | undefined;

async function loadLibc(): Promise<Libc | null> {
	if (libc !== undefined) return libc;
	libc = null;
	if (process.platform !== "linux" || !SUPPORTED_ARCH.has(process.arch))
		return libc;
	try {
		const { dlopen, FFIType, ptr } = await import("bun:ffi");
		const { symbols } = dlopen("libc.so.6", {
			ioctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 },
			tcgetattr: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
			tcsetattr: {
				args: [FFIType.i32, FFIType.i32, FFIType.ptr],
				returns: FFIType.i32,
			},
			cfmakeraw: { args: [FFIType.ptr], returns: FFIType.void },
			cfsetispeed: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
			cfsetospeed: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
			tcflush: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		});
		libc = {
			ioctl: (fd, request) => symbols.ioctl(fd, request),
			tcgetattr: (fd, t) => symbols.tcgetattr(fd, ptr(t)),
			tcsetattr: (fd, action, t) => symbols.tcsetattr(fd, action, ptr(t)),
			cfmakeraw: (t) => symbols.cfmakeraw(ptr(t)),
			cfsetispeed: (t, speed) => symbols.cfsetispeed(ptr(t), speed),
			cfsetospeed: (t, speed) => symbols.cfsetospeed(ptr(t), speed),
			tcflush: (fd, queue) => symbols.tcflush(fd, queue),
		};
	} catch {
		libc = null;
	}
	return libc;
}

function errorCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown })?.code;
	return typeof code === "string" ? code : undefined;
}

/**
 * Open `path` for one read-only lease: `O_NOCTTY` (a service must never acquire
 * the modem's tty as its controlling terminal), `O_NONBLOCK`, `TIOCEXCL`, then
 * raw 8N1 at 115200 without hardware flow control, VMIN 1, VTIME 0. On any failure after the open the
 * descriptor cleanup is started; an overrun error carries its pending promise.
 */
export async function openExclusiveRawTty(path: string): Promise<TtyPort> {
	const c = await loadLibc();
	if (!c) throw new TtyOpenError("native-unavailable");
	let fd: number;
	try {
		fd = openSync(
			path,
			fsConstants.O_RDWR | fsConstants.O_NOCTTY | fsConstants.O_NONBLOCK,
		);
	} catch (error) {
		throw new TtyOpenError(errorCode(error) === "EBUSY" ? "busy" : "failed");
	}
	const saved = new Uint8Array(TERMIOS_BYTES);
	let exclusive = false;
	let restore = false;
	let open = true;
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		if (closing) return closing;
		open = false;
		if (restore) c.tcsetattr(fd, TCSANOW, saved);
		if (exclusive) c.ioctl(fd, TIOCNXCL);
		closing = new Promise<void>((resolve) => fsClose(fd, () => resolve()));
		return closing;
	};
	try {
		if (c.ioctl(fd, TIOCEXCL) !== 0) throw new TtyOpenError("failed");
		exclusive = true;
		if (c.tcgetattr(fd, saved) !== 0) throw new TtyOpenError("failed");
		restore = true;
		const raw = saved.slice();
		c.cfmakeraw(raw);
		const view = new DataView(raw.buffer);
		view.setUint32(
			CFLAG_OFFSET,
			((view.getUint32(CFLAG_OFFSET, true) | CREAD | CLOCAL) & ~CRTSCTS) >>> 0,
			true,
		);
		// VMIN 1 / VTIME 0 with O_NONBLOCK: an empty port answers EAGAIN and a
		// hung-up one answers 0, so the two can be told apart. (VMIN 0 would
		// make both return 0.)
		raw[CC_OFFSET + VMIN] = 1;
		raw[CC_OFFSET + VTIME] = 0;
		if (
			c.cfsetispeed(raw, B115200) !== 0 ||
			c.cfsetospeed(raw, B115200) !== 0 ||
			c.tcsetattr(fd, TCSANOW, raw) !== 0
		)
			throw new TtyOpenError("failed");
	} catch (error) {
		const cleanup = close();
		if (!(await closeWithin(cleanup))) throw new TtyOpenError("stuck", cleanup);
		throw error instanceof TtyOpenError ? error : new TtyOpenError("failed");
	}
	const buffer = new Uint8Array(4096);
	return {
		read() {
			if (!open) throw new TtyIoError();
			try {
				const n = readSync(fd, buffer, 0, buffer.length, null);
				return buffer.slice(0, n);
			} catch (error) {
				if (errorCode(error) === "EAGAIN") return null;
				throw new TtyIoError();
			}
		},
		write(data) {
			if (!open) throw new TtyIoError();
			try {
				return writeSync(fd, data);
			} catch (error) {
				if (errorCode(error) === "EAGAIN") return 0;
				throw new TtyIoError();
			}
		},
		flushInput() {
			if (!open || c.tcflush(fd, TCIFLUSH) !== 0) throw new TtyIoError();
		},
		close,
	};
}

/** Last-close drain runs on the fs pool; the event loop and queue stay bounded. */
export async function closeWithin(
	closing: Promise<void>,
	ms = 500,
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			closing.then(
				() => true,
				() => false,
			),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
