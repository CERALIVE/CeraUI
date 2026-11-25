import { afterEach, describe, expect, test } from "bun:test";
import {
	FreeAtReadError,
	READ_ONLY_AT_QUERIES,
	ReadOnlyAtRefusedError,
	ReadOnlyAtSession,
} from "../modules/modems/free-at-session.ts";
import {
	openExclusiveRawTty,
	TtyOpenError,
	type TtyPort,
} from "../modules/modems/free-at-tty.ts";
import {
	FakeAtModem,
	QENG_LTE_REPLY,
	QENG_NSA_REPLY,
	reply,
	type Script,
} from "./helpers/fake-at-modem.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function modem(
	script: Script,
): Promise<{ fake: FakeAtModem; port: TtyPort; session: ReadOnlyAtSession }> {
	const fake = await FakeAtModem.start(script);
	cleanups.push(() => fake.close());
	const port = await openExclusiveRawTty(fake.path);
	cleanups.push(() => port.close());
	return { fake, port, session: new ReadOnlyAtSession(port) };
}

async function reason(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof FreeAtReadError) return error.reason;
		throw error;
	}
	throw new Error("expected a FreeAtReadError");
}

describe("read-only AT session on a pty", () => {
	test("a late unrelated final code cannot finish this command", async () => {
		const { session } = await modem((c) => [
			[0, "\r\nOK\r\n"],
			[30, `${c}\r\n${QENG_NSA_REPLY}`],
		]);
		expect(await session.query('AT+QENG="servingcell"', 1000)).toContain(
			"+QENG:",
		);
	});
	test("an uncorrelated error is ignored too", async () => {
		const { session } = await modem(() => [
			[0, "\r\nERROR\r\n"],
			[30, QENG_NSA_REPLY],
		]);
		expect(await session.query('AT+QENG="servingcell"', 1000)).toContain(
			"+QENG:",
		);
	});

	test("a complete reply with echo and final OK is returned whole", async () => {
		const { fake, session } = await modem((c) => reply(QENG_NSA_REPLY, c));
		const raw = await session.query('AT+QENG="servingcell"', 1000);
		expect(raw).toContain('+QENG: "servingcell","NOCONN"');
		expect(raw.trimEnd().endsWith("OK")).toBe(true);
		expect(fake.received).toBe('AT+QENG="servingcell"\r');
		expect(session.dirty).toBe(false);
	});

	test("partial lines wait for the final OK", async () => {
		const cut = QENG_LTE_REPLY.indexOf("OK");
		const { session } = await modem(() => [
			[0, QENG_LTE_REPLY.slice(0, 20)],
			[40, QENG_LTE_REPLY.slice(20, cut + 1)],
			[40, QENG_LTE_REPLY.slice(cut + 1)],
		]);
		const raw = await session.query('AT+QENG="servingcell"', 1000);
		expect(raw).toContain('"servingcell","NOCONN","LTE"');
		expect(raw.trimEnd().endsWith("OK")).toBe(true);
	});

	test("an OK split inside its own line does not end early, and OKAY is not OK", async () => {
		const { session } = await modem(() => [
			[0, '\r\n+QENG: "servingcell","NOCONN"\r\nOKAY\r\nO'],
			[60, "K\r\n"],
		]);
		const raw = await session.query('AT+QENG="servingcell"', 1000);
		expect(raw).toContain("OKAY");
		expect(raw.trimEnd().endsWith("\nOK")).toBe(true);
	});

	test("OK absent is a timeout within the deadline, and the late end is drained", async () => {
		const answers = [
			[[0, '\r\n+QENG: "servingcell","STALE"\r\n']] as const,
			[[0, QENG_LTE_REPLY]] as const,
		];
		const { fake, session } = await modem(() => answers.shift() ?? []);
		const start = performance.now();
		expect(await reason(session.query('AT+QENG="servingcell"', 200))).toBe(
			"timeout",
		);
		// Bounded by the deadline, not left hanging (generous for loaded runners).
		expect(performance.now() - start).toBeLessThan(2000);
		expect(session.dirty).toBe(true);
		fake.emit("\r\nOK\r\n"); // the old reply's late final code
		const raw = await session.query('AT+QENG="servingcell"', 1000);
		expect(raw).not.toContain("STALE"); // the stale reply never counts as new
		expect(raw).toContain("+QENG:");
	});

	test("a silent modem times out within the deadline", async () => {
		const { session } = await modem(() => []);
		const start = performance.now();
		expect(await reason(session.query('AT+QENG="servingcell"', 150))).toBe(
			"timeout",
		);
		expect(performance.now() - start).toBeLessThan(2000);
	});

	test("ERROR, +CME ERROR and +CMS ERROR are no reading", async () => {
		for (const final of [
			"\r\nERROR\r\n",
			"\r\n+CME ERROR: 3\r\n",
			"\r\n+CMS ERROR: 500\r\n",
		]) {
			const { session } = await modem((c) => [[0, `${c}\r\n${final}`]]);
			expect(await reason(session.query('AT+QENG="servingcell"', 1000))).toBe(
				"modem-error",
			);
			expect(session.dirty).toBe(false);
		}
	});

	test("setters and every non-allowlisted command are refused before any byte is written", async () => {
		const { fake, session } = await modem(() => reply("\r\nOK\r\n"));
		for (const command of [
			"ATE0",
			"AT+CFUN=0",
			'AT+QCFG="usbnet",0',
			'AT+QENG="servingcell";+CFUN=1,1',
			'AT+QENG="servingcell"\rAT+CFUN=0',
			'AT+QENG="servingcell"\r',
			'at+qeng="servingcell"',
			'AT+QENG="neighbourcell"',
			"ATI",
			"AT",
		]) {
			await expect(
				session.query(command as never, 1000),
			).rejects.toBeInstanceOf(ReadOnlyAtRefusedError);
		}
		await Bun.sleep(30);
		expect(fake.received).toBe("");
		expect([...READ_ONLY_AT_QUERIES]).toEqual(['AT+QENG="servingcell"']);
	});

	test("an endless reply is cut off", async () => {
		const { session } = await modem(() => [
			[0, '+QENG: "x","1"\r\n'.repeat(1500)],
		]);
		expect(await reason(session.query('AT+QENG="servingcell"', 1000))).toBe(
			"reply-too-long",
		);
	});

	test("a vanished port fails the read", async () => {
		const { fake, session } = await modem(() => []);
		fake.hangUp();
		expect(await reason(session.query('AT+QENG="servingcell"', 300))).toBe(
			"port-failed",
		);
	});

	test("a port that never goes quiet is refused before writing", async () => {
		// An in-memory port and a virtual clock: the noise never pauses, whatever
		// the event loop is doing (a timer-driven pty here raced the drain). The
		// session must also yield between reads, or this would never return.
		let now = 0;
		let reads = 0;
		const budget = () => {
			if (++reads > 1000)
				throw new Error("read budget exceeded without deadline progress");
		};
		const written: Uint8Array[] = [];
		const port: TtyPort = {
			read: () => {
				budget();
				return new TextEncoder().encode('+QIND: "noise"\r\n');
			},
			write: (data) => {
				written.push(data);
				return data.length;
			},
			flushInput: () => {},
			close: async () => {},
		};
		const session = new ReadOnlyAtSession(port, {
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
		});
		expect(await reason(session.query('AT+QENG="servingcell"', 1000))).toBe(
			"port-not-quiet",
		);
		expect(written).toEqual([]);
	});

	test("a pause in the noise shorter than the quiet window does not count as quiet", async () => {
		let now = 0;
		let reads = 0;
		const budget = () => {
			if (++reads > 1000)
				throw new Error("read budget exceeded without deadline progress");
		};
		const written: Uint8Array[] = [];
		const port: TtyPort = {
			// Noise on every other poll: 5 ms gaps, never 50 ms of silence.
			read: () => {
				budget();
				return Math.floor(now / 5) % 2 === 0
					? new TextEncoder().encode("+QIND\r\n")
					: null;
			},
			write: (data) => {
				written.push(data);
				return data.length;
			},
			flushInput: () => {},
			close: async () => {},
		};
		const session = new ReadOnlyAtSession(port, {
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
		});
		expect(await reason(session.query('AT+QENG="servingcell"', 1000))).toBe(
			"port-not-quiet",
		);
		expect(written).toEqual([]);
	});

	test("the open is exclusive and close restores the line settings", async () => {
		const fake = await FakeAtModem.start(() => []);
		cleanups.push(() => fake.close());
		const { dlopen, FFIType, ptr } = await import("bun:ffi");
		const { symbols } = dlopen("libc.so.6", {
			tcgetattr: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
		});
		const before = new Uint8Array(64);
		symbols.tcgetattr(fake.slave, ptr(before));
		const port = await openExclusiveRawTty(fake.path);
		const during = new Uint8Array(64);
		symbols.tcgetattr(fake.slave, ptr(during));
		expect(during).not.toEqual(before);
		if (process.getuid?.() !== 0) {
			// TIOCEXCL: a second opener is refused (root would bypass it).
			const second = await openExclusiveRawTty(fake.path).catch((e) => e);
			expect(second).toBeInstanceOf(TtyOpenError);
			expect((second as TtyOpenError).failure).toBe("busy");
		}
		await port.close();
		await port.close(); // idempotent
		const after = new Uint8Array(64);
		symbols.tcgetattr(fake.slave, ptr(after));
		expect(after).toEqual(before);
		const again = await openExclusiveRawTty(fake.path);
		await again.close();
	});

	test("a path that cannot be opened is a typed failure", async () => {
		const error = await openExclusiveRawTty("/nonexistent/ttyUSB3").catch(
			(e) => e,
		);
		expect(error).toBeInstanceOf(TtyOpenError);
		expect((error as TtyOpenError).failure).toBe("failed");
	});
});
