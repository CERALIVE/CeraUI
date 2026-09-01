/*
    CeraUI — the OPTIMISTIC "Modem detected — initializing…" row (todo 18).

    Four questions, and only the last one is answerable at the wire:

      1. does a `udevadm monitor --property` block decode into an attach at all,
         and does it REFUSE the events that would fan one physical stick out into
         several rows;
      2. does a provisional row obey the precedence rule — any authoritative
         observation of the same identity REPLACES it, and it never the other way
         round — including across the Qualcomm `9024`⇄`9091` composition flip;
      3. does the supervised child survive its own death, and does a restart
         leave no row nothing can retire;
      4. and does the row reach the ACTUAL `modems` payload a client parses.

    (4) is deliberately driven through `buildModemsWireMessage()` — the function
    the broadcast calls — rather than through the projector, for the reason
    `mock-sources-parity.test.ts` exists: a suite that hands a builder a
    hand-made literal never crosses the seam that drops a field.
*/

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { deriveModemStableKey, modemListSchema } from "@ceraui/rpc/schemas";

import { stopMockService } from "../mocks/mock-service.ts";
import { resetCellularStack } from "../modules/cellular/cellular-stack.ts";
import {
	cellularAttachFromUdev,
	detachIdPathFromUdev,
	parseUdevPropertyBlock,
	type UdevCellularAttach,
} from "../modules/cellular/udev-cellular-events.ts";
import {
	type UdevMonitorProcess,
	UdevMonitorSupervisor,
} from "../modules/cellular/udev-monitor.ts";
import {
	getUdevProvisionalCache,
	PROVISIONAL_AVAILABILITY_REASON,
	UdevProvisionalCache,
	UNDRIVEABLE_AVAILABILITY_REASON,
} from "../modules/cellular/udev-provisional-cache.ts";
import { buildModemsWireMessage } from "../modules/modems/modem-status.ts";
import {
	refreshModemIdPaths,
	resetModemWireProducer,
	setModemIdPathReader,
} from "../modules/modems/modem-wire-producer.ts";
import {
	getModemIds,
	removeModem,
	setModem,
} from "../modules/modems/modems-state.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────
// Verbatim-shaped `udevadm monitor --property --udev` output. The bench's two
// dual-mode Qualcomm sticks (todo 10 §identity ladder) are the fixture of
// record: one physical port, two USB compositions.

/** The port both compositions live on — a udev `usb_device` `ID_PATH`. */
const PORT_PATH = "platform-fc800000.usb-usb-0:1";
/** The `stable_key` BOTH sides of the merge derive from that port. */
const PORT_KEY = deriveModemStableKey(PORT_PATH) as string;

function block(lines: readonly string[]): readonly string[] {
	return [
		"UDEV  [12345.678901] add      /devices/platform/fc800000.usb (usb)",
		...lines,
	];
}

/** The 05c6:9024 RNDIS composition. */
const RNDIS_BLOCK = block([
	"ACTION=add",
	"DEVPATH=/devices/platform/fc800000.usb/usb1/1-1",
	"SUBSYSTEM=usb",
	"DEVTYPE=usb_device",
	`ID_PATH=${PORT_PATH}`,
	"ID_VENDOR_ID=05c6",
	"ID_MODEL_ID=9024",
	"ID_SERIAL_SHORT=2b16081",
	"ID_VENDOR_FROM_DATABASE=Qualcomm, Inc.",
	"ID_USB_INTERFACES=:e00103:0a0000:ff4201:",
]);

/** The SAME stick after a power cycle: 05c6:9091, QMI, same port. */
const QMI_BLOCK = block([
	"ACTION=add",
	"DEVPATH=/devices/platform/fc800000.usb/usb1/1-1",
	"SUBSYSTEM=usb",
	"DEVTYPE=usb_device",
	`ID_PATH=${PORT_PATH}`,
	"ID_VENDOR_ID=05c6",
	"ID_MODEL_ID=9091",
	"ID_SERIAL_SHORT=2b16081",
	"ID_USB_INTERFACES=:ff0000:ff0000:ffffff:",
]);

const HILINK_BLOCK = block([
	"ACTION=add",
	"SUBSYSTEM=usb",
	"DEVTYPE=usb_device",
	"ID_PATH=platform-fc880000.usb-usb-0:1.2",
	"ID_VENDOR_ID=12d1",
	"ID_MODEL_ID=14dc",
	"ID_MODEL_FROM_DATABASE=E3372 LTE/UMTS/GSM HiLink Modem/Networkcard",
	"ID_VENDOR_FROM_DATABASE=Huawei Technologies Co., Ltd.",
	"ID_USB_INTERFACES=:020600:0a0000:080650:",
]);

const RNDIS_INVENTORY = RNDIS_BLOCK.slice(1)
	.filter((line) => !line.startsWith("ACTION="))
	.map((line) => `E: ${line}`)
	.join("\n");

// The todo-24 pairing, verbatim from the `ceralive2` drill (2026-08-18): ONE
// socket, described by udev as an `ID_PATH` and by ModemManager (`Modem.Physdev`)
// as a raw sysfs DEVPATH. Todo 18's own fixtures pair ID_PATH against ID_PATH on
// both sides, which is why its suite stayed green while the board did not.
const DRILL_ID_PATH = "platform-xhci-hcd.0.auto-usb-0:1.4.1";
const DRILL_SYSFS_DEVPATH =
	"/sys/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb1/1-1/1-1.4/1-1.4.1";

/** The dual-mode stick as udev announced it on chassis-C socket 1. */
const DRILL_ATTACH_BLOCK = block([
	"ACTION=add",
	`DEVPATH=${DRILL_SYSFS_DEVPATH.slice("/sys".length)}`,
	"SUBSYSTEM=usb",
	"DEVTYPE=usb_device",
	`ID_PATH=${DRILL_ID_PATH}`,
	"ID_VENDOR_ID=05c6",
	"ID_MODEL_ID=9091",
	"ID_SERIAL_SHORT=2b16081",
	"ID_MODEL_FROM_DATABASE=Qualcomm Intex Aqua Fish & Jolla C Diagnostic Mode",
	"ID_VENDOR_FROM_DATABASE=Qualcomm, Inc.",
	"ID_USB_INTERFACES=:ff0000:ff0000:ffffff:",
]);

function attachOf(lines: readonly string[]): UdevCellularAttach {
	const event = parseUdevPropertyBlock(lines);
	if (event === undefined) throw new Error("fixture carries no ACTION");
	const attach = cellularAttachFromUdev(event);
	if (attach === undefined) throw new Error("fixture is not an attach");
	return attach;
}

async function until(predicate: () => boolean, budgetMs = 2000): Promise<void> {
	const deadline = Date.now() + budgetMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("condition never held");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

// ── 1. Reading the monitor's output ─────────────────────────────────────────

describe("udev property blocks — what is, and is NOT, an attach", () => {
	test("Given a property block, When decoded, Then the header is ignored and every KEY=VALUE is kept", () => {
		const event = parseUdevPropertyBlock(RNDIS_BLOCK);
		expect(event?.action).toBe("add");
		expect(event?.properties.get("ID_PATH")).toBe(PORT_PATH);
		expect(event?.properties.get("DEVTYPE")).toBe("usb_device");
		// The header line carries no `=` and must not have become a property.
		expect(event?.properties.size).toBe(RNDIS_BLOCK.length - 1);
	});

	test("Given a value containing '=', When decoded, Then only the FIRST separator splits", () => {
		const event = parseUdevPropertyBlock([
			"ACTION=add",
			"ID_MODEL_FROM_DATABASE=Modem A=B rev 2",
		]);
		expect(event?.properties.get("ID_MODEL_FROM_DATABASE")).toBe(
			"Modem A=B rev 2",
		);
	});

	test("Given the tool's preamble (no ACTION), When decoded, Then it is not an event", () => {
		expect(
			parseUdevPropertyBlock([
				"monitor will print the received events for:",
				"UDEV - the event which udev sends out after rule processing",
			]),
		).toBeUndefined();
	});

	test.each([
		["the image's own ModemManager tag", "ID_MM_DEVICE_PROCESS=1"],
		["a cellular-module vendor id", "ID_VENDOR_ID=12d1"],
		["a cellular interface class", "ID_USB_INTERFACES=:0a0000:"],
	])(
		"Given a usb_device add carrying %s, When classified, Then it is eligible and the evidence is recorded",
		(_label, property) => {
			const event = parseUdevPropertyBlock([
				"ACTION=add",
				"SUBSYSTEM=usb",
				"DEVTYPE=usb_device",
				`ID_PATH=${PORT_PATH}`,
				property,
			]);
			const attach = cellularAttachFromUdev(
				event ?? { action: "", properties: new Map() },
			);
			expect(attach?.idPath).toBe(PORT_PATH);
			expect(attach?.evidence.length).toBeGreaterThan(0);
		},
	);

	test("Given a keyboard-class device from a cellular vendor's neighbour, When classified, Then it is NOT eligible", () => {
		const event = parseUdevPropertyBlock([
			"ACTION=add",
			"SUBSYSTEM=usb",
			"DEVTYPE=usb_device",
			`ID_PATH=${PORT_PATH}`,
			"ID_VENDOR_ID=046d",
			"ID_MODEL_ID=c52b",
			"ID_USB_INTERFACES=:030101:030102:",
		]);
		expect(
			cellularAttachFromUdev(event ?? { action: "", properties: new Map() }),
		).toBeUndefined();
	});

	test("Given an eligible device with NO ID_PATH, When classified, Then it is refused rather than made unmergeable", () => {
		const event = parseUdevPropertyBlock([
			"ACTION=add",
			"SUBSYSTEM=usb",
			"DEVTYPE=usb_device",
			"ID_VENDOR_ID=12d1",
		]);
		expect(
			cellularAttachFromUdev(event ?? { action: "", properties: new Map() }),
		).toBeUndefined();
	});

	test.each(["bind", "change", "remove"])(
		"Given a '%s' on an eligible device, When classified, Then it is not an attach",
		(action) => {
			const event = parseUdevPropertyBlock([
				`ACTION=${action}`,
				"SUBSYSTEM=usb",
				"DEVTYPE=usb_device",
				`ID_PATH=${PORT_PATH}`,
				"ID_VENDOR_ID=12d1",
			]);
			expect(
				cellularAttachFromUdev(event ?? { action: "", properties: new Map() }),
			).toBeUndefined();
		},
	);

	test("Given a composite modem's usb_interface child, When classified, Then it is not a second device", () => {
		const event = parseUdevPropertyBlock([
			"ACTION=add",
			"SUBSYSTEM=usb",
			"DEVTYPE=usb_interface",
			`ID_PATH=${PORT_PATH}:1.2`,
			"ID_VENDOR_ID=12d1",
		]);
		expect(
			cellularAttachFromUdev(event ?? { action: "", properties: new Map() }),
		).toBeUndefined();
	});

	test("Given a usb_device remove, When read as a detach, Then the port is named — even with every ID_* but ID_PATH stripped", () => {
		const event = parseUdevPropertyBlock([
			"ACTION=remove",
			"SUBSYSTEM=usb",
			"DEVTYPE=usb_device",
			`ID_PATH=${PORT_PATH}`,
		]);
		expect(
			detachIdPathFromUdev(event ?? { action: "", properties: new Map() }),
		).toBe(PORT_PATH);
	});

	test("Given a usb_interface remove, When read as a detach, Then nothing is retired", () => {
		const event = parseUdevPropertyBlock([
			"ACTION=remove",
			"SUBSYSTEM=usb",
			"DEVTYPE=usb_interface",
			`ID_PATH=${PORT_PATH}:1.0`,
		]);
		expect(
			detachIdPathFromUdev(event ?? { action: "", properties: new Map() }),
		).toBeUndefined();
	});
});

// ── 2. Precedence, dedup, timeout, detach ───────────────────────────────────

describe("provisional rows — precedence is one-directional", () => {
	let cache: UdevProvisionalCache;

	beforeEach(() => {
		cache = new UdevProvisionalCache();
	});

	afterEach(() => {
		cache.reset();
	});

	test("Given a cellular-class attach, When the rows are read, Then ONE provisional row stands and it claims nothing it has not observed", () => {
		cache.noteAttach(attachOf(HILINK_BLOCK));

		const rows = cache.readProvisionalSources(new Set());
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row?.additive?.availability_reason).toBe(
			PROVISIONAL_AVAILABILITY_REASON,
		);
		// Presence is the whole claim: no radio status, no SIM verdict, no
		// interface — each of those would be a guess this row cannot make.
		expect(row?.status).toBeUndefined();
		expect(row?.config).toBeUndefined();
		expect(row?.simVisibility).toBe("opaque");
		expect(row?.ifname).toBe("");
		expect(row?.name).toContain("E3372");
	});

	test("Given an AUTHORITATIVE observation of the same identity, When the rows are read, Then the provisional row is gone AND retired", () => {
		cache.noteAttach(attachOf(RNDIS_BLOCK));

		expect(cache.readProvisionalSources(new Set([PORT_KEY]))).toHaveLength(0);
		// Retired, not merely hidden — a blink in the authoritative source must
		// not resurrect the optimistic row beside the real one.
		expect(cache.readProvisionalSources(new Set())).toHaveLength(0);
	});

	test("Given the 9024⇄9091 composition flip on ONE port, When both attaches land, Then there is ONE row, superseded by one authoritative claim", () => {
		cache.noteAttach(attachOf(RNDIS_BLOCK));
		cache.noteAttach(attachOf(QMI_BLOCK));

		const rows = cache.readProvisionalSources(new Set());
		expect(rows).toHaveLength(1);
		expect(rows[0]?.stableKey).toBe(PORT_KEY);

		// The authoritative row arrives in the OTHER composition, so its ID_PATH
		// carries an interface suffix — and still folds onto the same key.
		const observed = deriveModemStableKey(`${PORT_PATH}:1.4`) as string;
		expect(observed).toBe(PORT_KEY);
		expect(cache.readProvisionalSources(new Set([observed]))).toHaveLength(0);
	});

	test("Given a provisional row, When the device detaches, Then it is retired immediately and listeners are told", () => {
		let notifications = 0;
		cache.subscribe(() => {
			notifications++;
		});
		cache.noteAttach(attachOf(RNDIS_BLOCK));
		expect(notifications).toBe(1);

		cache.noteDetach(PORT_PATH);

		expect(cache.readProvisionalSources(new Set())).toHaveLength(0);
		expect(notifications).toBe(2);
		// A port we never held is a no-op, not a broadcast.
		cache.noteDetach("platform-nowhere-usb-0:9");
		expect(notifications).toBe(2);
	});

	test("Given a device that never exports, When two authoritative cycles miss it, Then the row persists as undriveable", () => {
		let notifications = 0;
		cache.subscribe(() => {
			notifications++;
		});
		cache.noteAttach(attachOf(RNDIS_BLOCK));

		cache.noteAuthoritativeCycle(new Set());
		expect(
			cache.readProvisionalSources(new Set())[0]?.additive?.availability_reason,
		).toBe(PROVISIONAL_AVAILABILITY_REASON);
		cache.noteAuthoritativeCycle(new Set());

		expect(cache.readProvisionalSources(new Set())).toHaveLength(1);
		expect(
			cache.readProvisionalSources(new Set())[0]?.additive?.availability_reason,
		).toBe(UNDRIVEABLE_AVAILABILITY_REASON);
		expect(notifications).toBe(2);
	});

	test("Given one missed cycle, When the composite repeats its attach, Then the lifecycle is not reset", () => {
		cache.noteAttach(attachOf(RNDIS_BLOCK));
		cache.noteAuthoritativeCycle(new Set());
		cache.noteAttach(attachOf(QMI_BLOCK));
		cache.noteAuthoritativeCycle(new Set());

		expect(
			cache.readProvisionalSources(new Set())[0]?.additive?.availability_reason,
		).toBe(UNDRIVEABLE_AVAILABILITY_REASON);
	});

	test("Given rows in hand, When the monitor restarts, Then clear() drops them all", () => {
		cache.noteAttach(attachOf(RNDIS_BLOCK));
		cache.noteAttach(attachOf(HILINK_BLOCK));

		cache.clear();

		expect(cache.readProvisionalSources(new Set())).toHaveLength(0);
	});
});

// ── 3. The supervised `udevadm monitor --property` child ────────────────────

/** The subset of a Bun subprocess the supervisor consumes, driven by hand. */
class FakeUdevProcess implements UdevMonitorProcess {
	killed = false;
	readonly exited: Promise<number>;
	#resolveExit: () => void = () => undefined;
	readonly #chunks: Uint8Array[] = [];
	readonly #waiters: (() => void)[] = [];
	#ended = false;

	constructor() {
		this.exited = new Promise<number>((resolve) => {
			this.#resolveExit = () => resolve(0);
		});
	}

	write(text: string): void {
		this.#chunks.push(new TextEncoder().encode(text));
		this.#wake();
	}

	die(): void {
		this.#ended = true;
		this.#wake();
		this.#resolveExit();
	}

	kill(): void {
		this.killed = true;
		this.die();
	}

	get stdout(): AsyncIterable<Uint8Array> {
		return { [Symbol.asyncIterator]: () => this.#read() };
	}

	async *#read(): AsyncGenerator<Uint8Array> {
		for (;;) {
			const next = this.#chunks.shift();
			if (next !== undefined) {
				yield next;
				continue;
			}
			if (this.#ended) return;
			await new Promise<void>((resolve) => this.#waiters.push(resolve));
		}
	}

	#wake(): void {
		const waiters = this.#waiters.splice(0, this.#waiters.length);
		for (const resolve of waiters) resolve();
	}
}

describe("the supervised udevadm monitor child", () => {
	let cache: UdevProvisionalCache;
	let spawned: FakeUdevProcess[];
	let supervisor: UdevMonitorSupervisor;
	let inventory: string;

	beforeEach(() => {
		cache = new UdevProvisionalCache();
		spawned = [];
		inventory = "";
		supervisor = new UdevMonitorSupervisor(
			cache,
			() => {
				const proc = new FakeUdevProcess();
				spawned.push(proc);
				return proc;
			},
			async () => inventory,
		);
	});

	afterEach(() => {
		supervisor.stop();
		cache.reset();
	});

	const rowCount = (): number => cache.readProvisionalSources(new Set()).length;

	test("Given a block split ACROSS chunk boundaries, When it is streamed, Then the attach still lands", async () => {
		supervisor.start();
		await until(() => spawned.length === 1);
		const proc = spawned[0] as FakeUdevProcess;

		const text = `${RNDIS_BLOCK.join("\n")}\n\n`;
		proc.write(text.slice(0, 40));
		proc.write(text.slice(40, 90));
		proc.write(text.slice(90));

		await until(() => rowCount() === 1);
	});

	test("Given a child that dies mid-block, When stdout ends without a trailing blank line, Then the last block is still flushed", async () => {
		// The flush is observed through the cache's own notification, not through
		// a later read: the death that CAUSES the flush also triggers the restart
		// that clears the rows, so a read afterwards proves nothing either way.
		const seen: number[] = [];
		cache.subscribe(() => {
			seen.push(rowCount());
		});
		supervisor.start();
		await until(() => spawned.length === 1);
		const proc = spawned[0] as FakeUdevProcess;

		proc.write(`${RNDIS_BLOCK.join("\n")}\n`);
		proc.die();

		await until(() => seen.includes(1));
	});

	test("Given a malformed block, When it is streamed, Then the stream survives and the NEXT event still lands", async () => {
		supervisor.start();
		await until(() => spawned.length === 1);
		const proc = spawned[0] as FakeUdevProcess;

		proc.write("not a property line at all\n\n");
		proc.write(`${HILINK_BLOCK.join("\n")}\n\n`);

		await until(() => rowCount() === 1);
	});

	test("Given an attached inventory device, When the monitor starts, Then the row is reconstructed without a live add", async () => {
		inventory = RNDIS_INVENTORY;

		supervisor.start();

		await until(() => spawned.length === 1 && rowCount() === 1);
	});

	test("Given an undriveable attached row, When the monitor respawns, Then inventory preserves its lifecycle", async () => {
		inventory = RNDIS_INVENTORY;
		supervisor.start();
		await until(() => spawned.length === 1 && rowCount() === 1);
		const first = spawned[0] as FakeUdevProcess;
		cache.noteAuthoritativeCycle(new Set());
		cache.noteAuthoritativeCycle(new Set());
		expect(
			cache.readProvisionalSources(new Set())[0]?.additive?.availability_reason,
		).toBe(UNDRIVEABLE_AVAILABILITY_REASON);

		first.die();

		await until(() => spawned.length === 2);
		expect(
			cache.readProvisionalSources(new Set())[0]?.additive?.availability_reason,
		).toBe(UNDRIVEABLE_AVAILABILITY_REASON);
		expect(supervisor.isRunning).toBe(true);
	});

	test("Given a device detaches while the monitor is down, When it respawns, Then inventory retires the row", async () => {
		inventory = RNDIS_INVENTORY;
		supervisor.start();
		await until(() => spawned.length === 1 && rowCount() === 1);
		const first = spawned[0] as FakeUdevProcess;

		inventory = "";
		first.die();

		await until(() => spawned.length === 2);
		expect(rowCount()).toBe(0);
	});

	test("Given a running monitor, When it is stopped, Then the child is killed, nothing respawns, and the rows go", async () => {
		supervisor.start();
		await until(() => spawned.length === 1);
		const proc = spawned[0] as FakeUdevProcess;
		proc.write(`${RNDIS_BLOCK.join("\n")}\n\n`);
		await until(() => rowCount() === 1);

		supervisor.stop();

		expect(proc.killed).toBe(true);
		expect(rowCount()).toBe(0);
		expect(supervisor.isRunning).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 350));
		expect(spawned).toHaveLength(1);
	});
});

// ── 4. …and it reaches the wire a client actually parses ────────────────────

describe("the optimistic row on the REAL modems payload", () => {
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of ["NODE_ENV", "MOCK_MODE", "MOCK_SCENARIO"]) {
			saved[key] = process.env[key];
		}
		// The udev monitor is `isRealDevice()`-gated and the producer answers
		// mocks with NOTHING, so this path only exists off the mock graph.
		process.env.NODE_ENV = "test";
		delete process.env.MOCK_MODE;
		delete process.env.MOCK_SCENARIO;
		stopMockService();
		resetCellularStack();
		resetModemWireProducer();
		for (const id of getModemIds()) removeModem(id);
		getUdevProvisionalCache().reset();
	});

	afterEach(() => {
		getUdevProvisionalCache().reset();
		resetModemWireProducer();
		for (const id of getModemIds()) removeModem(id);
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	// Parsing rather than casting is what makes the schema-validity assertion and
	// the field reads ONE step: a payload the wire contract would reject cannot
	// silently satisfy the row assertions below.
	const wireRows = () =>
		Object.values(modemListSchema.parse(buildModemsWireMessage()));

	const provisionalRows = (rows: ReturnType<typeof wireRows>) =>
		rows.filter(
			(entry) => entry.availability_reason === PROVISIONAL_AVAILABILITY_REASON,
		);

	test("Given an attach and no modem service answer yet, When the payload is built, Then a schema-valid optimistic row is on it", () => {
		getUdevProvisionalCache().noteAttach(attachOf(RNDIS_BLOCK));

		const rows = wireRows();

		expect(provisionalRows(rows)).toHaveLength(1);
		expect(rows.filter((entry) => entry.stable_key === PORT_KEY)).toHaveLength(
			1,
		);
	});

	test("Given the authoritative row then arrives for the SAME port, When the payload is rebuilt, Then it REPLACES the optimistic one — no duplicate", async () => {
		getUdevProvisionalCache().noteAttach(attachOf(RNDIS_BLOCK));
		expect(provisionalRows(wireRows())).toHaveLength(1);

		// ModemManager exports the stick in its QMI composition: a new interface,
		// an interface-suffixed ID_PATH — the same physical port.
		setModem(7, {
			ifname: "wwan0",
			name: "Qualcomm, Incorporated 0",
			sim_network: "",
			network_type: { supported: {}, active: null },
			status: {
				connection: "connected",
				network_type: "4g",
				signal: 61,
				roaming: false,
			},
		});
		setModemIdPathReader(async () => new Map([["wwan0", `${PORT_PATH}:1.4`]]));
		await refreshModemIdPaths();

		const rows = wireRows();

		expect(provisionalRows(rows)).toHaveLength(0);
		const keyed = rows.filter((entry) => entry.stable_key === PORT_KEY);
		expect(keyed).toHaveLength(1);
		expect(keyed[0]?.ifname).toBe("wwan0");
	});

	test("Given an ID_PATH-keyed provisional row and a SYSFS-path-keyed modem row for the same socket, When the payload is built, Then ONE row stands", async () => {
		getUdevProvisionalCache().noteAttach(attachOf(DRILL_ATTACH_BLOCK));
		expect(provisionalRows(wireRows())).toHaveLength(1);

		// The authoritative observation of the SAME socket, anchored the way
		// ModemManager anchors it — a raw sysfs DEVPATH, not an ID_PATH.
		setModem(21, {
			ifname: "wwan2",
			name: "0 - 72633",
			sim_network: "",
			network_type: { supported: {}, active: "4g" },
			status: {
				connection: "failed",
				network_type: "",
				signal: 0,
				roaming: false,
			},
		});
		setModemIdPathReader(async () => new Map([["wwan2", DRILL_SYSFS_DEVPATH]]));
		await refreshModemIdPaths();

		const rows = wireRows();

		expect(provisionalRows(rows)).toHaveLength(0);
		const keyed = rows.filter((entry) => entry.stable_key === DRILL_ID_PATH);
		expect(keyed).toHaveLength(1);
		expect(keyed[0]?.ifname).toBe("wwan2");
		// The whole payload, not just the keyed slice: the drill's failure was a
		// SECOND row for the port under the other encoding, which a key-filtered
		// assertion would never see.
		expect(rows).toHaveLength(1);
	});
});
