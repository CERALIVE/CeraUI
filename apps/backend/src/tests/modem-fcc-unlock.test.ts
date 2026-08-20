import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratchDirs: string[] = [];

async function scratchPolicyPath(): Promise<string> {
	// mkdtemp, not a fixed path: two checkouts may run this suite at once.
	const dir = await mkdtemp(join(tmpdir(), "ceraui-fcc-"));
	scratchDirs.push(dir);
	return join(dir, "fcc-unlock-policy.json");
}

/**
 * The store reads its path at MODULE LOAD, so each case re-imports it behind a
 * cache-busting query after setting the override — the same shape the kiosk-token
 * suite uses for `CERALIVE_RUN_DIR`.
 */
async function loadStore(path: string) {
	process.env.CERALIVE_FCC_POLICY_PATH = path;
	return await import(
		`../modules/modems/fcc-unlock-store.ts?fcc=${encodeURIComponent(path)}`
	);
}

afterEach(async () => {
	process.env.CERALIVE_FCC_POLICY_PATH = undefined;
	await Promise.all(
		scratchDirs
			.splice(0)
			.map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("the FCC-unlock policy store", () => {
	test("Given no file, When the policy loads, Then nothing is enabled", async () => {
		const store = await loadStore(await scratchPolicyPath());
		expect(await store.loadFccUnlockPolicy()).toEqual({});
	});

	test("Given a saved policy, When it is reloaded, Then it round-trips at mode 0600", async () => {
		const path = await scratchPolicyPath();
		const store = await loadStore(path);
		await store.saveFccUnlockPolicy({ "2c7c:0801": true, "1199:9079": false });

		expect(await store.loadFccUnlockPolicy()).toEqual({
			"2c7c:0801": true,
			"1199:9079": false,
		});
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	// The shell reconciler parses the SAME document, so the two halves have to
	// agree on the shape. A newline-terminated single line is what it reads.
	test("Given a saved policy, When the bytes are inspected, Then they carry the versioned shape the shell reader parses", async () => {
		const path = await scratchPolicyPath();
		const store = await loadStore(path);
		await store.saveFccUnlockPolicy({ "2c7c:0801": true });

		const raw = await readFile(path, "utf8");
		expect(raw.endsWith("\n")).toBe(true);
		const doc = JSON.parse(raw) as Record<string, unknown>;
		expect(doc.schemaVersion).toBe(1);
		expect(doc.unlock).toEqual({ "2c7c:0801": true });
	});

	// Whole-document rejection, matching the reconciler's own judgement: a
	// half-applied regulatory-unlock policy is a policy nobody wrote.
	test.each([
		["invalid JSON", "{ not json"],
		[
			"a wrong schema version",
			'{"schemaVersion":99,"savedAtMs":1,"unlock":{}}',
		],
		[
			"a vendor-only key",
			'{"schemaVersion":1,"savedAtMs":1,"unlock":{"2c7c":true}}',
		],
		[
			"a non-boolean answer",
			'{"schemaVersion":1,"savedAtMs":1,"unlock":{"2c7c:0801":"yes"}}',
		],
	])(
		"Given %s, When the policy loads, Then it reads as empty and the damaged bytes are KEPT",
		async (_name, body) => {
			const path = await scratchPolicyPath();
			const store = await loadStore(path);
			await writeFile(path, body);

			expect(await store.loadFccUnlockPolicy()).toEqual({});
			// The evidence stays on disk for whoever has to diagnose it — unlike the
			// usage store, which rewrites a fresh file.
			expect(await readFile(path, "utf8")).toBe(body);
		},
	);
});

describe("the coverage catalog CeraUI mirrors", () => {
	test("Given the bench fleet, When coverage is resolved, Then only the Quectel RM530N-GL is covered", async () => {
		const { resolveFccUnlockCoverage } = await import("@ceraui/rpc/schemas");

		expect(resolveFccUnlockCoverage("2c7c", "0801")).toBe("present");
		// Every other device on the todo-2 bench inventory.
		expect(resolveFccUnlockCoverage("12d1", "14dc")).toBe("absent");
		expect(resolveFccUnlockCoverage("19d2", "1405")).toBe("absent");
		expect(resolveFccUnlockCoverage("1e0e", "9001")).toBe("absent");
		expect(resolveFccUnlockCoverage("05c6", "9091")).toBe("absent");
		// The FM350 on its USB carrier re-enumerates under MediaTek's own vendor id;
		// ModemManager covers its PCIe identity 14c3:4d75 instead.
		expect(resolveFccUnlockCoverage("0e8d", "7127")).toBe("absent");
		expect(resolveFccUnlockCoverage("14c3", "4d75")).toBe("present");
	});

	// A statement about the READ is not a statement about the DEVICE.
	test("Given ids that could not be read, When coverage is resolved, Then it is unknown rather than absent", async () => {
		const { resolveFccUnlockCoverage } = await import("@ceraui/rpc/schemas");

		expect(resolveFccUnlockCoverage(undefined, undefined)).toBe("unknown");
		expect(resolveFccUnlockCoverage("2c7c", undefined)).toBe("unknown");
		expect(resolveFccUnlockCoverage("nope", "0801")).toBe("unknown");
	});
});

describe("the write path's pre-lease refusals", () => {
	let setFccUnlockEnabled: typeof import("../modules/modems/fcc-unlock.ts").setFccUnlockEnabled;
	let readFccUnlockState: typeof import("../modules/modems/fcc-unlock.ts").readFccUnlockState;
	let setModem: typeof import("../modules/modems/modems-state.ts").setModem;
	let removeModem: typeof import("../modules/modems/modems-state.ts").removeModem;
	let resetUsbNetMarkers: typeof import("../modules/network/router-cellular-scan.ts").resetUsbNetMarkers;

	beforeEach(async () => {
		({ setFccUnlockEnabled, readFccUnlockState } = await import(
			"../modules/modems/fcc-unlock.ts"
		));
		({ setModem, removeModem } = await import(
			"../modules/modems/modems-state.ts"
		));
		({ resetUsbNetMarkers } = await import(
			"../modules/network/router-cellular-scan.ts"
		));
		resetUsbNetMarkers();
	});

	afterEach(() => {
		removeModem(77);
		resetUsbNetMarkers();
	});

	test("Given a selector no modem answers to, When it is written, Then it is refused unknown_modem", async () => {
		expect(await setFccUnlockEnabled("77", true)).toEqual({
			success: false,
			error: "unknown_modem",
		});
		expect(await readFccUnlockState("77")).toEqual({
			success: false,
			error: "unknown_modem",
		});
	});

	// The descriptor sweep is empty here, so the ids cannot be read. A guessed key
	// would name a symlink for somebody else's hardware.
	test("Given a modem whose USB ids could not be read, When it is written, Then it is refused identity_unknown", async () => {
		setModem(77, { id: 77, ifname: "wwan9" } as never);

		expect(await setFccUnlockEnabled("77", true)).toEqual({
			success: false,
			error: "identity_unknown",
		});
	});

	// A selector that is not an mmcli index or object path must be refused rather
	// than coerced to NaN and dispatched.
	test.each(["", "  ", "abc", "/org/freedesktop/ModemManager1/Modem/x"])(
		"Given the malformed selector %p, When it is written, Then it is refused unknown_modem",
		async (selector) => {
			expect(await setFccUnlockEnabled(selector, true)).toEqual({
				success: false,
				error: "unknown_modem",
			});
		},
	);
});
