/*
 * Opt-in SIM PIN auto-unlock on boot.
 *
 * Pins the three contract properties from the feature spec:
 *
 *  1. STORAGE: an opted-in PIN is persisted ONLY to a chmod-600 tmpfs secrets
 *     file — never to config.json (the runtime config schema has no PIN field).
 *  2. BOOT UNLOCK: when a PIN-locked modem is present and a PIN is stored, the
 *     boot hook submits it and the modem comes up unlocked.
 *  3. BOUNDED ON WRONG PIN: a wrong stored PIN is submitted EXACTLY ONCE, then
 *     cleared and surfaced for manual entry — it never loops toward a PUK
 *     lockout and never re-submits.
 *
 * The storage tests write to a temp tmpfs dir (CERALIVE_RUN_DIR) so the suite
 * never touches the real /run. The boot tests inject SimAutoUnlockDeps so the
 * bounded/clear behaviour is exercised with no hardware and no files.
 */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runtimeConfigSchema } from "../helpers/config-schemas.ts";
import type { SimUnlockResult } from "../modules/modems/mmcli.ts";
import {
	type LockedModem,
	maybeAutoUnlockSimPins,
	type SimAutoUnlockDeps,
} from "../modules/modems/sim-autounlock.ts";
import {
	clearSimPin,
	loadSimPin,
	simPinSecretPath,
	storeSimPin,
} from "../modules/modems/sim-secrets.ts";

const ORIGINAL_RUN_DIR = process.env.CERALIVE_RUN_DIR;
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ceralive-sim-"));

beforeAll(() => {
	process.env.CERALIVE_RUN_DIR = RUN_DIR;
});

afterAll(() => {
	fs.rmSync(RUN_DIR, { recursive: true, force: true });
	if (ORIGINAL_RUN_DIR === undefined) {
		delete process.env.CERALIVE_RUN_DIR;
	} else {
		process.env.CERALIVE_RUN_DIR = ORIGINAL_RUN_DIR;
	}
});

beforeEach(() => {
	// Each test starts from a clean tmpfs dir (no leftover secret file).
	for (const entry of fs.readdirSync(RUN_DIR)) {
		fs.rmSync(path.join(RUN_DIR, entry), { recursive: true, force: true });
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Secrets store: chmod 600, tmpfs only, config.json untouched
// ─────────────────────────────────────────────────────────────────────────────

describe("sim-secrets store", () => {
	it("the runtime config schema has NO simPin field (secret never lives in config)", () => {
		const keys = Object.keys(runtimeConfigSchema.shape);
		expect(keys).not.toContain("simPin");
		expect(keys).not.toContain("sim_pin");
		expect(keys).not.toContain("simPinSecret");
	});

	it("stores an opted-in PIN to a 0600 tmpfs file, leaving config.json unchanged", async () => {
		// The on-disk config.json (cwd) is the persisted runtime config — capture
		// its exact bytes so we can prove the PIN write never touches it.
		const configBefore = fs.existsSync("config.json")
			? fs.readFileSync("config.json", "utf8")
			: null;

		await storeSimPin("1234");

		const secretPath = simPinSecretPath();
		// tmpfs path under the run dir, named sim-pin.secret — never config.json.
		expect(secretPath).toBe(path.join(RUN_DIR, "sim-pin.secret"));
		expect(secretPath).not.toContain("config");

		const onDisk = fs.readFileSync(secretPath, "utf8");
		expect(onDisk).toBe("1234");
		// No trailing newline — the PIN is the whole file.
		expect(onDisk.endsWith("\n")).toBe(false);

		const mode = fs.statSync(secretPath).mode & 0o777;
		expect(mode).toBe(0o600);

		const configAfter = fs.existsSync("config.json")
			? fs.readFileSync("config.json", "utf8")
			: null;
		expect(configAfter).toBe(configBefore);
		// And config.json gained no PIN field.
		if (configAfter !== null) {
			expect(JSON.parse(configAfter)).not.toHaveProperty("simPin");
		}
	});

	it("round-trips load and clears idempotently", async () => {
		expect(await loadSimPin()).toBeNull();

		await storeSimPin("4321");
		expect(await loadSimPin()).toBe("4321");

		await clearSimPin();
		expect(await loadSimPin()).toBeNull();
		// Clearing again is a no-op (idempotent).
		await clearSimPin();
		expect(await loadSimPin()).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 + 3. Boot auto-unlock: success path and the bounded wrong-PIN path
// ─────────────────────────────────────────────────────────────────────────────

type Calls = {
	unlock: Array<[string, string]>;
	clear: number;
	onUnlocked: number;
	loadPin: number;
};

function makeAutoUnlockDeps(
	opts: {
		isRealDevice?: boolean;
		storedPin?: string | null;
		locked?: Array<LockedModem>;
		unlockResults?: Array<SimUnlockResult>;
	} = {},
): { deps: SimAutoUnlockDeps; calls: Calls } {
	const calls: Calls = { unlock: [], clear: 0, onUnlocked: 0, loadPin: 0 };
	const results = [...(opts.unlockResults ?? [{ state: "success" }])];
	const deps: SimAutoUnlockDeps = {
		isRealDevice: async () => opts.isRealDevice ?? true,
		loadSimPin: async () => {
			calls.loadPin += 1;
			return opts.storedPin === undefined ? "1234" : opts.storedPin;
		},
		clearSimPin: async () => {
			calls.clear += 1;
		},
		getLockedModems: () => opts.locked ?? [{ id: 0, path: "0" }],
		unlock: async (modemPath, pin) => {
			calls.unlock.push([modemPath, pin]);
			return results.shift() ?? { state: "error" };
		},
		onUnlocked: async () => {
			calls.onUnlocked += 1;
		},
	};
	return { deps, calls };
}

describe("maybeAutoUnlockSimPins — boot unlock", () => {
	it("unlocks a PIN-locked modem with the stored PIN and re-discovers", async () => {
		const { deps, calls } = makeAutoUnlockDeps({
			storedPin: "1234",
			locked: [{ id: 0, path: "0" }],
			unlockResults: [{ state: "success" }],
		});

		await maybeAutoUnlockSimPins(deps);

		expect(calls.unlock).toEqual([["0", "1234"]]);
		expect(calls.clear).toBe(0);
		// A freshly unlocked SIM triggers exactly one re-discovery.
		expect(calls.onUnlocked).toBe(1);
	});
});

describe("maybeAutoUnlockSimPins — bounded on wrong PIN", () => {
	it("submits a wrong stored PIN exactly once, clears it, and never retries", async () => {
		const { deps, calls } = makeAutoUnlockDeps({
			storedPin: "9999",
			locked: [{ id: 0, path: "0" }],
			unlockResults: [{ state: "wrong-pin", remainingAttempts: 2 }],
		});

		await maybeAutoUnlockSimPins(deps);

		// EXACTLY ONE submit — no loop toward a PUK lockout.
		expect(calls.unlock.length).toBe(1);
		expect(calls.unlock[0]).toEqual(["0", "9999"]);
		// Wrong PIN cleared so the next boot can't resubmit it.
		expect(calls.clear).toBe(1);
		// Surfaced for manual entry — no re-discovery.
		expect(calls.onUnlocked).toBe(0);
	});

	it("stops after the first failure even with multiple locked modems", async () => {
		const { deps, calls } = makeAutoUnlockDeps({
			storedPin: "9999",
			locked: [
				{ id: 0, path: "0" },
				{ id: 1, path: "1" },
			],
			unlockResults: [
				{ state: "wrong-pin", remainingAttempts: 2 },
				{ state: "wrong-pin", remainingAttempts: 1 },
			],
		});

		await maybeAutoUnlockSimPins(deps);

		// The shared stored PIN is wrong — submit ONCE total, never walk every SIM
		// down toward a PUK lockout.
		expect(calls.unlock.length).toBe(1);
		expect(calls.clear).toBe(1);
		expect(calls.onUnlocked).toBe(0);
	});

	it("clears and stops on puk-required (a PIN can't clear a PUK lock)", async () => {
		const { deps, calls } = makeAutoUnlockDeps({
			unlockResults: [{ state: "puk-required" }],
		});

		await maybeAutoUnlockSimPins(deps);

		expect(calls.unlock.length).toBe(1);
		expect(calls.clear).toBe(1);
		expect(calls.onUnlocked).toBe(0);
	});

	it("keeps the stored PIN on a no-locked-modem race (no rejection, no clear)", async () => {
		const { deps, calls } = makeAutoUnlockDeps({
			unlockResults: [{ state: "no-locked-modem" }],
		});

		await maybeAutoUnlockSimPins(deps);

		expect(calls.unlock.length).toBe(1);
		expect(calls.clear).toBe(0);
		expect(calls.onUnlocked).toBe(0);
	});
});

describe("maybeAutoUnlockSimPins — no-op gates", () => {
	it("never touches mmcli on a dev/emulated host", async () => {
		const { deps, calls } = makeAutoUnlockDeps({ isRealDevice: false });

		await maybeAutoUnlockSimPins(deps);

		// Gate is first — the stored PIN is not even read.
		expect(calls.loadPin).toBe(0);
		expect(calls.unlock.length).toBe(0);
		expect(calls.clear).toBe(0);
	});

	it("does nothing when no PIN is stored (opt-in disabled)", async () => {
		const { deps, calls } = makeAutoUnlockDeps({ storedPin: null });

		await maybeAutoUnlockSimPins(deps);

		expect(calls.unlock.length).toBe(0);
		expect(calls.clear).toBe(0);
	});

	it("does nothing when no modem is SIM-PIN locked", async () => {
		const { deps, calls } = makeAutoUnlockDeps({ locked: [] });

		await maybeAutoUnlockSimPins(deps);

		expect(calls.unlock.length).toBe(0);
		expect(calls.clear).toBe(0);
	});
});
