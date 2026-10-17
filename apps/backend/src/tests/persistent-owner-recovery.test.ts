import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createFccUnlockRollbackHandler,
	defaultFccUnlockDeps,
	setFccUnlockEnabled,
} from "../modules/modems/fcc-unlock.ts";
import { removeModem, setModem } from "../modules/modems/modems-state.ts";
import {
	defaultMutationJournalFs,
	resetMutationJournalDeps,
	setMutationJournalDeps,
} from "../modules/modems/mutation-journal.ts";
import { initMutationRecovery } from "../modules/modems/mutation-replay.ts";
import {
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import { UplinkShaperApplier } from "../modules/network/uplink-shaper/applier.ts";
import { UplinkShaperCoordinator } from "../modules/network/uplink-shaper/coordinator.ts";
import { readShaperOwnership } from "../modules/network/uplink-shaper/ownership-authority.ts";
import {
	awaitRecoveryBarrier,
	beginRecoveryBarrier,
	isRecoveryPending,
	resetRecoveryBarrier,
} from "../modules/streaming/recovery-barrier.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "persistent-owner-"));
	resetRecoveryBarrier();
});
afterEach(() => {
	resetRecoveryBarrier();
	resetMutationJournalDeps();
	resetUsbNetMarkers();
	removeModem(77);
	rmSync(root, { recursive: true, force: true });
});

function eio(): Error {
	return Object.assign(new Error("EIO: i/o error, scandir"), { code: "EIO" });
}

/** A journal filesystem whose directory listing fails `failures` times. */
function flakyJournal(failures: number): { listings: () => number } {
	let listings = 0;
	setMutationJournalDeps({
		dir: join(root, "journal"),
		now: () => 1,
		fs: {
			...defaultMutationJournalFs,
			listDir: async (dir) => {
				listings += 1;
				if (listings <= failures) throw eio();
				return defaultMutationJournalFs.listDir(dir);
			},
		},
	});
	return { listings: () => listings };
}

test("a transient journal fault is retried until a complete replay lowers the barrier", async () => {
	// Given a healthy empty journal whose first two listings fail with EIO.
	const journal = flakyJournal(2);
	const waits: number[] = [];
	// When startup recovery runs with an injected clock.
	const summary = await initMutationRecovery({
		sleep: async (ms) => {
			waits.push(ms);
		},
	});
	expect(summary.unreadable).toBe(1);
	expect(isRecoveryPending()).toBe(true);
	await awaitRecoveryBarrier();
	// Then the one owner retried with backoff and the readable replay lowered it.
	expect(isRecoveryPending()).toBe(false);
	expect(waits).toEqual([1000, 2000]);
	// Two failed listings, then slots + entries + blocks of the complete replay.
	expect(journal.listings()).toBe(5);
});

test("a healthy absent journal lowers the barrier at boot without the owner", async () => {
	// Given no journal directory at all (a first boot).
	const journal = flakyJournal(0);
	const waits: number[] = [];
	// When startup recovery runs.
	const summary = await initMutationRecovery({
		sleep: async (ms) => {
			waits.push(ms);
		},
	});
	// Then the barrier is down immediately and nothing is scheduled.
	expect(summary.unreadable).toBe(0);
	expect(isRecoveryPending()).toBe(false);
	expect(waits).toEqual([]);
	expect(journal.listings()).toBe(3);
});

test("a runtime raise after replay is cleared by a read-only verification", async () => {
	// Given completed startup recovery, then a journal read fault at runtime.
	const journal = flakyJournal(0);
	const waits: number[] = [];
	await initMutationRecovery({
		sleep: async (ms) => {
			waits.push(ms);
		},
	});
	// When a later journal read raises the barrier again.
	beginRecoveryBarrier();
	expect(isRecoveryPending()).toBe(true);
	await awaitRecoveryBarrier();
	// Then the owner verifies the inventory and lowers it (no replay rollback).
	expect(isRecoveryPending()).toBe(false);
	expect(waits).toEqual([1000]);
	// Replay's three listings, then the verification's slots + blocks.
	expect(journal.listings()).toBe(5);
});

test("the shaper coordinator reads repaired ownership after one rejected update", async () => {
	// Given the real strict reader behind the production coordinator and applier.
	const path = join(root, "roots.json");
	writeFileSync(path, "{");
	let reads = 0;
	const commands: string[][] = [];
	const applier = new UplinkShaperApplier({
		readRecordedRoots: async () => {
			reads++;
			return readShaperOwnership(path);
		},
		readRoot: async () => ({ kind: "noqueue", handle: "0:" }),
		readBacklog: async () => 0,
		runTc: async (argv) => {
			commands.push([...argv]);
		},
	});
	const coordinator = new UplinkShaperCoordinator({
		apply: (request) => applier.apply(request),
	});
	const update = { streaming: true, sharedUplinks: [], telemetry: [] };
	// When the first update fails, storage is repaired, and the next update runs.
	await expect(coordinator.update(update)).rejects.toThrow();
	writeFileSync(path, '{"eth0":{"kind":"noqueue","handle":"0:"}}');
	const second = await Promise.allSettled([coordinator.update(update)]);
	// Then the reader ran again and its recorded root was restored.
	expect(second[0]?.status).toBe("fulfilled");
	expect(reads).toBe(2);
	expect(commands).toEqual([["qdisc", "del", "dev", "eth0", "root"]]);
});

async function freshFccStore(path: string) {
	process.env.CERALIVE_FCC_POLICY_PATH = path;
	try {
		return await import(
			`../modules/modems/fcc-unlock-store.ts?owner=${encodeURIComponent(path)}`
		);
	} finally {
		delete process.env.CERALIVE_FCC_POLICY_PATH;
	}
}

test.each(["unreadable", "damaged"])(
	"FCC rollback never writes from an unknown baseline: %s",
	async (layout) => {
		// Given a present policy whose strict read cannot establish authority.
		const path = join(root, "policy.json");
		if (layout === "unreadable") mkdirSync(path);
		else writeFileSync(path, '{"schemaVersion":1,"unlock":');
		const store = await freshFccStore(path);
		const written: Record<string, boolean>[] = [];
		const handler = createFccUnlockRollbackHandler({
			...defaultFccUnlockDeps,
			loadPolicyBaseline: store.loadFccUnlockPolicyBaseline,
			savePolicy: async (unlock) => {
				written.push(unlock);
			},
		});
		// When rollback would replace the complete document from that read.
		const result = await handler.rollback("modem", {
			key: "2c7c:0801",
			enabled: false,
		});
		// Then unreadable writes nothing; damaged is archived before a fresh record.
		const copies = readdirSync(root).filter((n) => n.includes(".damaged-"));
		if (layout === "unreadable") {
			expect(result).toBe("failed");
			expect(written).toEqual([]);
			expect(copies).toEqual([]);
		} else {
			expect(result).toBe("restored");
			expect(written).toEqual([{ "2c7c:0801": false }]);
			expect(readFileSync(join(root, copies[0] ?? "-"), "utf8")).toBe(
				'{"schemaVersion":1,"unlock":',
			);
		}
	},
);

test("an FCC toggle over an unreadable policy is refused before any journal entry", async () => {
	// Given a modem whose USB ids are known and an unreadable policy file.
	const path = join(root, "policy.json");
	mkdirSync(path);
	const store = await freshFccStore(path);
	const journalDir = join(root, "journal");
	setMutationJournalDeps({ dir: journalDir, now: () => 1 });
	await refreshUsbNetMarkers(["wwan7"], {
		sysfsRoot: "/",
		udevDataRoot: "/run/udev/data",
		listDir: async () => [],
		readAttr: async (attr) =>
			({
				"/sys/devices/usb/1-1/idVendor": "2c7c",
				"/sys/devices/usb/1-1/idProduct": "0801",
			})[attr],
		resolveLink: async (link) =>
			link === "/sys/class/net/wwan7/device"
				? "/sys/devices/usb/1-1/1-1:1.0"
				: undefined,
		readLinkName: async () => undefined,
	});
	setModem(77, { id: 77, ifname: "wwan7" } as never);
	const written: unknown[] = [];
	// When the operator turns the model's unlock off.
	const result = await setFccUnlockEnabled("77", false, {
		...defaultFccUnlockDeps,
		loadPolicyBaseline: store.loadFccUnlockPolicyBaseline,
		savePolicy: async (unlock) => {
			written.push(unlock);
		},
		reprobe: async () => false,
		broadcast: () => {},
	});
	// Then nothing was written and no pre-state was journaled.
	expect(result).toEqual({ success: false, error: "write_failed" });
	expect(written).toEqual([]);
	expect(() => readdirSync(journalDir)).toThrow();
});

test("a future idle timestamp is not cached, so its repair is read", async () => {
	// Given a schema-valid idle record dated in the future.
	const idle = await import("../modules/system/idle-state.ts");
	const path = join(root, "idle.json");
	writeFileSync(
		path,
		JSON.stringify({ lastStreamEndedAt: Date.now() + 3_600_000 }),
	);
	idle.setIdleStateFilePathForTest(path);
	try {
		await idle.loadIdleState();
		// When the record is repaired to a past time.
		writeFileSync(path, '{"lastStreamEndedAt":1000}');
		// Then the next load reads the repair instead of the cached future value.
		expect(await idle.loadIdleState()).toBe(1000);
	} finally {
		idle.setIdleStateFilePathForTest(null);
	}
});
