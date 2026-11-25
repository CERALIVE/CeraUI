/**
 * A pty standing in for the RM520's free AT interface. The test end (master)
 * reads each command the backend writes and plays a scripted answer; every
 * byte the backend wrote is kept in `received`, so a test can prove what was
 * and was not sent.
 */
import { closeSync, readSync, writeSync } from "node:fs";

type Chunk = readonly [delayMs: number, data: string];
export type Script = (command: string) => readonly Chunk[];

const F_GETFL = 3;
const F_SETFL = 4;
const O_NONBLOCK = 0o4000;

async function pty(): Promise<{ master: number; slave: number; path: string }> {
	const { dlopen, FFIType, ptr } = await import("bun:ffi");
	const { symbols } = dlopen("libc.so.6", {
		openpty: {
			args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
			returns: FFIType.i32,
		},
		ttyname_r: {
			args: [FFIType.i32, FFIType.ptr, FFIType.u64],
			returns: FFIType.i32,
		},
		fcntl: {
			args: [FFIType.i32, FFIType.i32, FFIType.i32],
			returns: FFIType.i32,
		},
	});
	const master = new Int32Array(1);
	const slave = new Int32Array(1);
	if (symbols.openpty(ptr(master), ptr(slave), null, null, null) !== 0)
		throw new Error("openpty failed");
	const name = new Uint8Array(256);
	if (symbols.ttyname_r(slave[0] as number, ptr(name), name.length) !== 0)
		throw new Error("ttyname_r failed");
	const m = master[0] as number;
	symbols.fcntl(m, F_SETFL, symbols.fcntl(m, F_GETFL, 0) | O_NONBLOCK);
	return {
		master: m,
		slave: slave[0] as number,
		path: new TextDecoder().decode(name.subarray(0, name.indexOf(0))),
	};
}

export class FakeAtModem {
	received = "";
	private line = "";
	private out = new Uint8Array(0);
	private timer: ReturnType<typeof setInterval> | undefined;
	private closed = false;
	private constructor(
		readonly path: string,
		readonly master: number,
		readonly slave: number,
		private script: Script,
	) {}

	static async start(script: Script): Promise<FakeAtModem> {
		const { master, slave, path } = await pty();
		const modem = new FakeAtModem(path, master, slave, script);
		modem.timer = setInterval(() => modem.poll(), 2);
		return modem;
	}

	/** Send bytes the modem produced on its own (late replies, URCs). */
	emit(data: string): void {
		if (this.closed) return;
		const bytes = new TextEncoder().encode(data);
		const joined = new Uint8Array(this.out.length + bytes.length);
		joined.set(this.out);
		joined.set(bytes, this.out.length);
		this.out = joined;
		this.flush();
	}

	/** A pty takes a few KiB at a time; the rest waits for the reader. */
	private flush(): void {
		while (this.out.length) {
			let n = 0;
			try {
				n = writeSync(this.master, this.out);
			} catch {
				return; // EAGAIN: buffer full
			}
			if (!n) return;
			this.out = this.out.subarray(n);
		}
	}

	private poll(): void {
		if (this.closed) return;
		this.flush();
		const buffer = new Uint8Array(1024);
		let n = 0;
		try {
			n = readSync(this.master, buffer, 0, buffer.length, null);
		} catch {
			return; // EAGAIN: nothing written
		}
		const text = new TextDecoder().decode(buffer.subarray(0, n));
		this.received += text;
		this.line += text;
		let end = this.line.indexOf("\r");
		while (end >= 0) {
			const command = this.line.slice(0, end).trim();
			this.line = this.line.slice(end + 1);
			end = this.line.indexOf("\r");
			// A restored (cooked, echoing) pty echoes the modem's own late output
			// back here; only lines that look like a command are answered.
			if (!command.startsWith("AT")) continue;
			let at = 0;
			for (const [delay, data] of this.script(command)) {
				at += delay;
				setTimeout(() => this.emit(data), at);
			}
		}
	}

	/** Close the modem end: the backend's side then reads EIO, as after unplug. */
	hangUp(): void {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.timer);
		closeSync(this.master);
	}

	close(): void {
		this.hangUp();
		try {
			closeSync(this.slave);
		} catch {
			/* already closed */
		}
	}
}

/** A reply as a port ModemManager never configured sends it: echo on, CRLF. */
export function reply(body: string, echo?: string): readonly Chunk[] {
	return [[0, `${echo === undefined ? "" : `${echo}\r`}${body}`]];
}

export const QENG_NSA_REPLY =
	'\r\n+QENG: "servingcell","NOCONN"\r\n+QENG: "LTE","FDD",001,01,0000001,1,1300,3,5,5,1,-95,-11,-63,10,24,-\r\n+QENG: "NR5G-NSA",001,01,123,-90,15,-11,630000,78,12,1\r\n\r\nOK\r\n';

export const QENG_LTE_REPLY =
	'\r\n+QENG: "servingcell","NOCONN","LTE","FDD",001,01,0000001,1,1300,3,5,5,1,-95,-11,-63,10,24,-\r\n\r\nOK\r\n';
