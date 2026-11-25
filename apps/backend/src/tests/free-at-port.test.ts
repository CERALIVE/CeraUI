import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	rm,
	rmdir,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FREE_AT_RECHECK_MS,
	type FreeAtFacts,
	FreeAtPorts,
	FreeAtUnavailableError,
	findFreeAtPort,
	heldByOthers,
} from "../modules/modems/free-at-port.ts";
import { ReadOnlyAtRefusedError } from "../modules/modems/free-at-session.ts";
import {
	openExclusiveRawTty,
	TtyOpenError,
	type TtyPort,
} from "../modules/modems/free-at-tty.ts";
import { FakeAtModem, QENG_NSA_REPLY, reply } from "./helpers/fake-at-modem.ts";

const DEVICE = "/sys/devices/platform/usb/usb2/2-1";
const PORTS = [
	"cdc-wdm0 (qmi)",
	"ttyUSB0 (qcdm)",
	"ttyUSB1 (gps)",
	"ttyUSB2 (at)",
	"ttyUSB3 (ignored)",
	"wwan0 (net)",
];
const OWNED = [...PORTS.slice(0, 4), "ttyUSB3 (at)"];

let root: string;
const cleanups: (() => void | Promise<void>)[] = [];

async function put(path: string, content: string): Promise<void> {
	await mkdir(join(root, path, ".."), { recursive: true });
	await writeFile(join(root, path), content);
}
const udev = (content: string) => put("run/udev/data/c188:3", content);

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "free-at-"));
	await put(`${DEVICE}/idVendor`, "2c7c\n");
	await put(`${DEVICE}/idProduct`, "0801\n");
	await put(`${DEVICE}/busnum`, "2\n");
	await put(`${DEVICE}/devnum`, "5\n");
	for (const [iface, tty] of [
		["1.2", "ttyUSB2"],
		["1.3", "ttyUSB3"],
	] as const)
		await mkdir(join(root, DEVICE, `2-1:${iface}`, tty), { recursive: true });
	await put("sys/class/tty/ttyUSB3/dev", "188:3\n");
	await udev("E:ID_MM_CANDIDATE=1\nE:ID_MM_PORT_IGNORE=1\n");
	await put("dev/ttyUSB3", "");
	await mkdir(join(root, "proc/1/fd"), { recursive: true });
	await symlink("/dev/null", join(root, "proc/1/fd/0"));
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	await rm(root, { recursive: true, force: true });
});

async function refusal(facts: Partial<FreeAtFacts> = {}): Promise<string> {
	try {
		await findFreeAtPort({ device: DEVICE, ports: PORTS, ...facts }, root);
	} catch (error) {
		if (error instanceof FreeAtUnavailableError) return error.reason;
		throw error;
	}
	throw new Error("expected a refusal");
}

describe("ownership checks before any open", () => {
	test("a released port passes, also when ModemManager omits ignored ports", async () => {
		const free = { tty: "ttyUSB3", generation: "2:5" };
		expect(
			await findFreeAtPort({ device: DEVICE, ports: PORTS }, root),
		).toEqual(free);
		expect(
			await findFreeAtPort({ device: DEVICE, ports: PORTS.slice(0, 4) }, root),
		).toEqual(free);
	});

	test("a port ModemManager owns is refused", async () => {
		expect(await refusal({ ports: OWNED })).toBe("owned-by-modemmanager");
		expect(await refusal({ ports: [...PORTS.slice(0, 4), "ttyUSB3"] })).toBe(
			"owned-by-modemmanager",
		);
	});

	test("a port udev has not released is refused", async () => {
		await udev("E:ID_MM_CANDIDATE=1\nE:ID_MM_PORT_TYPE_AT_SECONDARY=1\n");
		expect(await refusal({ ports: PORTS.slice(0, 4) })).toBe("not-released");
		await udev("E:ID_MM_PORT_IGNORE=0\n");
		expect(await refusal()).toBe("not-released");
		await unlink(join(root, "run/udev/data/c188:3"));
		expect(await refusal()).toBe("not-released");
	});

	test("a port another process holds is refused; our own descriptor is not counted", async () => {
		await mkdir(join(root, "proc/4242/fd"), { recursive: true });
		await symlink("/dev/ttyUSB3", join(root, "proc/4242/fd/7"));
		expect(await refusal()).toBe("in-use");
		expect(
			(await findFreeAtPort({ device: DEVICE, ports: PORTS }, root, 4242)).tty,
		).toBe("ttyUSB3");
		expect(await heldByOthers("/dev/ttyUSB3", join(root, "missing"))).toBe(
			true,
		);
	});

	test("the wrong device, a missing or doubled interface are refused", async () => {
		await put(`${DEVICE}/idProduct`, "0800\n");
		expect(await refusal()).toBe("not-rm520");
		await put(`${DEVICE}/idProduct`, "0801\n");
		expect(await refusal({ device: "/sys/devices/../../etc/2-1" })).toBe(
			"not-rm520",
		);
		// Even when the traversal would land on a real RM520 node.
		expect(
			await refusal({ device: "/sys/devices/platform/usb/usb2/x/../2-1" }),
		).toBe("not-rm520");
		expect(
			await refusal({ device: "/sys/devices/platform/usb/usb2/2-1:1.3" }),
		).toBe("not-rm520");
		await mkdir(join(root, DEVICE, "2-1:1.3", "ttyUSB9"));
		expect(await refusal()).toBe("second-at-interface-absent");
		await rmdir(join(root, DEVICE, "2-1:1.3", "ttyUSB9"));
		await rmdir(join(root, DEVICE, "2-1:1.3", "ttyUSB3"));
		expect(await refusal()).toBe("second-at-interface-absent");
	});
});

describe("the read-only lease", () => {
	async function setup(
		script = (c: string) => reply(QENG_NSA_REPLY, c),
		facts: FreeAtFacts = { device: DEVICE, ports: PORTS },
	) {
		const fake = await FakeAtModem.start(script);
		cleanups.push(() => fake.close());
		const opened: string[] = [];
		const ports: TtyPort[] = [];
		let now = 1_000_000;
		let factsCalls = 0;
		let currentFacts = (_id: number) => facts;
		const realOpen = async (path: string): Promise<TtyPort> => {
			opened.push(path);
			const port = await openExclusiveRawTty(fake.path);
			ports.push(port);
			return port;
		};
		let openHook: (path: string) => Promise<TtyPort> = realOpen;
		const lease = new FreeAtPorts({
			facts: async (id) => {
				factsCalls++;
				return currentFacts(id);
			},
			open: (path) => openHook(path),
			root,
			pid: 999_999,
			now: () => now,
		});
		return {
			fake,
			lease,
			opened,
			ports,
			factsCalls: () => factsCalls,
			setFacts: (read: (id: number) => FreeAtFacts) => {
				currentFacts = read;
			},
			/** Replace the open; `real` is the pty open the default uses. */
			hookOpen: (
				hook: (
					path: string,
					real: (path: string) => Promise<TtyPort>,
				) => Promise<TtyPort>,
			) => {
				openHook = (path) => hook(path, realOpen);
			},
			advance: (ms: number) => {
				now += ms;
			},
		};
	}

	test("transient open refusals retry after 30 seconds", async () => {
		const { lease, hookOpen, advance } = await setup();
		let busy = true;
		hookOpen((path, real) =>
			busy ? Promise.reject(new TtyOpenError("busy")) : real(path),
		);
		await lease.read(3, 'AT+QENG="servingcell"');
		busy = false;
		expect(lease.refusal(3)).toBe("in-use");
		advance(30_000);
		expect((await lease.read(3, 'AT+QENG="servingcell"')).ok).toBe(true);
	});
	test("a stuck close timestamps its new refusal after an older refusal expires", async () => {
		const { lease, hookOpen, advance } = await setup();
		const cleanup = pending();
		let busy = true;
		hookOpen(async (path, real) => {
			if (busy) throw new TtyOpenError("busy");
			const port = await real(path);
			return {
				...port,
				close: async () => {
					await cleanup.promise;
					await port.close();
				},
			};
		});
		expect(await lease.read(3, 'AT+QENG="servingcell"')).toMatchObject({
			reason: "in-use",
			capturedAt: 1_000_000,
		});
		advance(31_000);
		busy = false;
		expect(await lease.read(3, 'AT+QENG="servingcell"')).toMatchObject({
			reason: "port-stuck",
			capturedAt: 1_031_000,
		});
	});
	test("three consecutive timeouts cause a short refusal", async () => {
		const { lease, advance } = await setup(() => []);
		for (let i = 0; i < 3; i++)
			await lease.read(3, 'AT+QENG="servingcell"', 10);
		expect(lease.refusal(3)).toBe("repeated-timeouts");
		advance(30_000);
		expect(lease.refusal(3)).toBeUndefined();
	});
	function pending() {
		let release!: () => void;
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		cleanups.push(release);
		return { promise, release };
	}

	test("failed-open cleanup survives backoff expiry until it settles", async () => {
		const { lease, hookOpen, advance } = await setup();
		const cleanup = pending();
		let opens = 0;
		hookOpen((path, real) => {
			opens++;
			return opens === 1
				? Promise.reject(new TtyOpenError("stuck", cleanup.promise))
				: real(path);
		});
		expect(await lease.read(3, 'AT+QENG="servingcell"')).toMatchObject({
			reason: "port-stuck",
		});
		advance(30_000);
		expect(await lease.read(3, 'AT+QENG="servingcell"')).toMatchObject({
			reason: "port-stuck",
		});
		expect(opens).toBe(1);
		cleanup.release();
		await cleanup.promise;
		expect((await lease.read(3, 'AT+QENG="servingcell"')).ok).toBe(true);
		expect(opens).toBe(2);
	});

	async function stuckFirst(expireBackoff = true) {
		const fixture = await setup();
		const cleanup = pending();
		let opens = 0;
		fixture.hookOpen(async (path, real) => {
			const first = ++opens === 1;
			const port = await real(path);
			if (!first) return port;
			return {
				...port,
				close: async () => {
					await cleanup.promise;
					await port.close();
				},
			};
		});
		let ticked = false;
		setTimeout(() => {
			ticked = true;
		}, 10);
		expect(await fixture.lease.read(3, 'AT+QENG="servingcell"')).toMatchObject({
			reason: "port-stuck",
		});
		expect(ticked).toBe(true);
		expect(fixture.lease.refusal(3)).toBe("port-stuck");
		if (expireBackoff) fixture.advance(30_000);
		return { ...fixture, cleanup, opens: () => opens };
	}

	test("pending cleanup does not reuse another manager ID's expired refusal timestamp", async () => {
		const { lease, hookOpen, advance } = await setup();
		const cleanup = pending();
		let busy = true;
		hookOpen(async (path, real) => {
			if (busy) throw new TtyOpenError("busy");
			const port = await real(path);
			return {
				...port,
				close: async () => {
					await cleanup.promise;
					await port.close();
				},
			};
		});
		expect(await lease.read(4, 'AT+QENG="servingcell"')).toMatchObject({
			reason: "in-use",
			capturedAt: 1_000_000,
		});
		advance(31_000);
		busy = false;
		expect(await lease.read(3, 'AT+QENG="servingcell"')).toMatchObject({
			reason: "port-stuck",
		});
		expect(await lease.read(4, 'AT+QENG="servingcell"')).toMatchObject({
			reason: "port-stuck",
			capturedAt: 1_031_000,
		});
	});
	test("same USB generation with a new manager ID cannot bypass pending close", async () => {
		const { lease, opens } = await stuckFirst();
		expect(await lease.read(4, 'AT+QENG="servingcell"')).toMatchObject({
			reason: "port-stuck",
		});
		expect(opens()).toBe(1);
	});

	test("a verified new USB generation may open while the old generation closes", async () => {
		const { lease, opens, hookOpen, advance } = await stuckFirst(false);
		await put(`${DEVICE}/devnum`, "6\n");
		// Replacement generation has its own descriptor, like a re-enumerated tty.
		const next = await FakeAtModem.start((c) => reply(QENG_NSA_REPLY, c));
		cleanups.push(() => next.close());
		let replacements = 0;
		hookOpen(async () => {
			replacements++;
			return openExclusiveRawTty(next.path);
		});
		expect((await lease.read(3, 'AT+QENG="servingcell"')).ok).toBe(true);
		expect(opens()).toBe(1);
		expect(replacements).toBe(1);
		// Closing the replacement must not retire the original cleanup entry.
		await put(`${DEVICE}/devnum`, "5\n");
		advance(30_000);
		expect(await lease.read(4, 'AT+QENG="servingcell"')).toMatchObject({
			reason: "port-stuck",
		});
		expect(replacements).toBe(1);
	});

	test("a stuck close yields and a genuinely different healthy modem succeeds", async () => {
		const { lease, opens, setFacts, hookOpen } = await stuckFirst();
		const otherDevice = DEVICE.replace("2-1", "2-2");
		for (const [file, value] of Object.entries({
			idVendor: "2c7c",
			idProduct: "0801",
			busnum: "2",
			devnum: "7",
		}))
			await put(`${otherDevice}/${file}`, value);
		await mkdir(join(root, otherDevice, "2-2:1.3", "ttyUSB7"), {
			recursive: true,
		});
		await put("sys/class/tty/ttyUSB7/dev", "188:7");
		await put("run/udev/data/c188:7", "E:ID_MM_PORT_IGNORE=1");
		const next = await FakeAtModem.start((c) => reply(QENG_NSA_REPLY, c));
		cleanups.push(() => next.close());
		let healthyOpens = 0;
		// Both identities share the same lease owner and closing registry.
		setFacts((id) => ({ device: id === 3 ? DEVICE : otherDevice, ports: [] }));
		hookOpen(async () => {
			healthyOpens++;
			return openExclusiveRawTty(next.path);
		});
		expect((await lease.read(4, 'AT+QENG="servingcell"')).ok).toBe(true);
		expect(opens()).toBe(1);
		expect(healthyOpens).toBe(1);
	});

	test("a released port answers with the complete reply and is closed again", async () => {
		const { fake, lease, opened } = await setup();
		const result = await lease.read(3, 'AT+QENG="servingcell"');
		expect(result.ok).toBe(true);
		expect(result.ok && result.raw).toContain('+QENG: "servingcell","NOCONN"');
		expect(opened).toEqual([join(root, "dev/ttyUSB3")]);
		expect(fake.received).toBe('AT+QENG="servingcell"\r');
		// closed: a fresh exclusive open succeeds
		await (await openExclusiveRawTty(fake.path)).close();
	});

	test("a ModemManager-owned port is refused without opening, then rechecked rarely", async () => {
		const { fake, lease, opened, factsCalls, advance } = await setup(
			undefined,
			{
				device: DEVICE,
				ports: OWNED,
			},
		);
		expect(await lease.read(3, 'AT+QENG="servingcell"')).toEqual({
			ok: false,
			unavailable: true,
			reason: "owned-by-modemmanager",
			capturedAt: 1_000_000,
		});
		advance(30_000);
		expect(await lease.read(3, 'AT+QENG="servingcell"')).toEqual({
			ok: false,
			unavailable: true,
			reason: "owned-by-modemmanager",
			capturedAt: 1_000_000,
		});
		expect(factsCalls()).toBe(1); // inside the window nothing is even looked at
		advance(FREE_AT_RECHECK_MS);
		await lease.read(3, 'AT+QENG="servingcell"');
		expect(factsCalls()).toBe(2);
		expect(opened).toEqual([]);
		expect(fake.received).toBe("");
	});

	test("a non-allowlisted command is refused before anything is looked at", async () => {
		const { fake, lease, opened, factsCalls } = await setup();
		for (const command of ["ATE0", "AT+CFUN=1,1", 'AT+QCFG="usbnet",2', "ATI"])
			await expect(lease.read(3, command as never)).rejects.toBeInstanceOf(
				ReadOnlyAtRefusedError,
			);
		expect(factsCalls()).toBe(0);
		expect(opened).toEqual([]);
		expect(fake.received).toBe("");
	});

	test("a re-enumerated device between check and open is refused and the port closed", async () => {
		const { fake, lease, ports, hookOpen } = await setup();
		hookOpen(async (path, real) => {
			await put(`${DEVICE}/devnum`, "6\n");
			return real(path);
		});
		expect(await lease.read(3, 'AT+QENG="servingcell"')).toMatchObject({
			unavailable: true,
			reason: "device-changed",
		});
		expect(fake.received).toBe("");
		expect(ports).toHaveLength(1);
		await (await openExclusiveRawTty(fake.path)).close();
	});

	test("an open refused as busy or failed is unavailable, not a reading", async () => {
		const { lease, hookOpen } = await setup();
		hookOpen(() => Promise.reject(new TtyOpenError("busy")));
		expect(await lease.read(3, 'AT+QENG="servingcell"')).toMatchObject({
			reason: "in-use",
		});
		const other = new FreeAtPorts({
			facts: async () => ({ device: DEVICE, ports: PORTS }),
			open: () => Promise.reject(new TtyOpenError("failed")),
			root,
		});
		expect(await other.read(3, 'AT+QENG="servingcell"')).toMatchObject({
			unavailable: true,
			reason: "cannot-open",
		});
	});

	test("a timeout is no reading, is not remembered, and the next read drains first", async () => {
		const answers = [
			[[0, '\r\n+QENG: "servingcell","STALE"\r\n']] as const,
			[[0, QENG_NSA_REPLY]] as const,
		];
		const { fake, lease } = await setup(() => answers.shift() ?? []);
		expect(await lease.read(3, 'AT+QENG="servingcell"', 150)).toEqual({
			ok: false,
			unavailable: false,
			reason: "timeout",
		});
		expect(lease.refusal(3)).toBeUndefined();
		fake.emit("\r\nOK\r\n");
		const second = await lease.read(3, 'AT+QENG="servingcell"');
		expect(second.ok).toBe(true);
		expect(second.ok && second.raw.match(/\+QENG/g)).toHaveLength(3);
	});

	test("ModemManager unreadable is no reading, not an ownership verdict", async () => {
		const lease = new FreeAtPorts({ facts: async () => undefined, root });
		expect(await lease.read(3, 'AT+QENG="servingcell"')).toEqual({
			ok: false,
			unavailable: false,
			reason: "modem-unreadable",
		});
		expect(lease.refusal(3)).toBeUndefined();
	});

	test("reads never overlap, across queries and modems", async () => {
		const { lease, hookOpen } = await setup((c) => [
			[30, `${c}\r${QENG_NSA_REPLY}`],
		]);
		let open = 0;
		let most = 0;
		hookOpen(async (path, real) => {
			open++;
			most = Math.max(most, open);
			const port = await real(path);
			return {
				...port,
				close: async () => {
					open--;
					await port.close();
				},
			};
		});
		const results = await Promise.all([
			lease.read(3, 'AT+QENG="servingcell"'),
			lease.read(4, 'AT+QENG="servingcell"'),
			lease.read(3, 'AT+QENG="servingcell"'),
		]);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(most).toBe(1);
	});
});

for (const failedSetup of [false, true]) {
	test(`re-enumeration inside ${failedSetup ? "failed setup" : "open"} blocks the possibly opened generation until cleanup settles`, async () => {
		let finish!: () => void;
		const cleanup = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let opens = 0;
		const fake = await FakeAtModem.start((c) => reply(QENG_NSA_REPLY, c));
		cleanups.push(() => fake.close());
		let now = 0;
		const lease = new FreeAtPorts({
			root,
			pid: process.pid,
			now: () => now,
			facts: async () => ({ device: DEVICE, ports: PORTS }),
			open: async () => {
				opens++;
				if (opens > 1) return openExclusiveRawTty(fake.path);
				await put(`${DEVICE}/devnum`, "6\n");
				if (failedSetup) throw new TtyOpenError("stuck", cleanup);
				return {
					close: () => cleanup,
					write: async () => {
						throw Error("must not query a changed generation");
					},
					read: async () => new Uint8Array(),
				} as unknown as TtyPort;
			},
		});
		try {
			expect(await lease.read(3, 'AT+QENG="servingcell"')).toMatchObject({
				reason: "port-stuck",
			});
			for (const id of [3, 4]) {
				expect(await lease.read(id, 'AT+QENG="servingcell"')).toMatchObject({
					reason: "port-stuck",
					capturedAt: 0,
				});
				expect(opens).toBe(1);
			}
			now = 30_000;
			expect(await lease.read(3, 'AT+QENG="servingcell"')).toMatchObject({
				reason: "port-stuck",
			});
			expect(opens).toBe(1);
			expect(fake.received).toBe("");
			expect(lease.refusal(3)).toBe("port-stuck");
		} finally {
			finish();
			await cleanup;
		}
		// Polling at the boundary must not extend backoff. Once cleanup settles,
		// a replacement read reaches open again at the same clock value.
		expect((await lease.read(3, 'AT+QENG="servingcell"')).ok).toBe(true);
		expect(opens).toBe(2);
	});
}
