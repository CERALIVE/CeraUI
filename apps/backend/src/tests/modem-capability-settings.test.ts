/**
 * The operator's WRITE path for the device-wide capability gates.
 *
 * The framework suite beside this one proves the gates work once they hold a
 * value. This one proves an operator can actually PUT a value in them — which is
 * what nothing could do before: `config.modem_capabilities` was default-absent
 * with no RPC and no UI, so the band-lock and GPS controls told operators to
 * "turn this on in settings" and pointed at a setting that did not exist
 * (`.omo/evidence/task-49-full-stack-board-validation.md`).
 *
 * Two properties carry the whole change and both are asserted against behaviour
 * rather than shape:
 *
 *   1. THE WRITE PERSISTS AND REPUBLISHES — a gate an operator turns on lands in
 *      config and the modem roster is re-broadcast, so the control it unblocks
 *      moves on the device's own next answer instead of on the reply.
 *   2. THE WRITE IS A PRECONDITION, NEVER A BYPASS — an enabled gate cannot
 *      promote a module past `enabled` on an unprobed modem, cannot reach
 *      `certified` at all, and leaves band-lock's stricter certification floor
 *      refusing exactly as it did before. This is the property the task's
 *      "must not bypass the certified-catalog gate" requirement turns on.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { call } from "@orpc/server";

import { getConfig } from "../modules/config.ts";
import {
	type ModemCapabilityEvidence,
	noteCapabilityEvidenceChanged,
	resolveModemCapabilityClaims,
	setCapabilityEvidenceChangeNotifier,
	setModemCapabilityEvidenceReader,
} from "../modules/modems/capability-gates.ts";
import {
	type ModemGpsDeps,
	readModemGps,
	resetModemGpsState,
} from "../modules/modems/gps.ts";
import {
	getModemCapabilitiesProcedure,
	setModemCapabilitiesProcedure,
} from "../rpc/procedures/modems.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const KEY = "platform-xhci-hcd.0.auto-usb-0:1.4.1";

const IMPLEMENTED = ["five-g-pref", "band-lock", "gps", "ussd"] as const;

/**
 * A scripted `mmcli --location-status` answer. The capability list is the bench
 * board's real Quectel RM530N-GL reading, so the change-notification path is
 * exercised against a capability set that exists on hardware.
 */
function gpsDeps({ gnssCapable }: { gnssCapable: boolean }): ModemGpsDeps {
	const capabilities = gnssCapable
		? ["3gpp-lac-ci", "gps-raw", "gps-nmea", "gps-unmanaged"]
		: ["3gpp-lac-ci"];
	const lines = [
		`modem.location.capabilities.length : ${capabilities.length}`,
		...capabilities.map(
			(source, index) =>
				`modem.location.capabilities.value[${index + 1}] : ${source}`,
		),
		"modem.location.enabled : --",
	];
	return {
		now: () => 0,
		runCli: async () => lines.join("\n"),
		resolveIdentity: async () => ({ stableKey: KEY }),
	};
}

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

function evidence(partial: ModemCapabilityEvidence): void {
	setModemCapabilityEvidenceReader(() => partial);
}

function callGet() {
	return call(getModemCapabilitiesProcedure, undefined as never, {
		context: makeContext(),
	});
}

function callSet(module: string, enabled: boolean) {
	return call(setModemCapabilitiesProcedure, { module, enabled } as never, {
		context: makeContext(),
	});
}

beforeEach(() => {
	getConfig().modem_capabilities = undefined;
	setModemCapabilityEvidenceReader(null);
	setCapabilityEvidenceChangeNotifier(null);
	resetModemGpsState();
});

afterEach(() => {
	getConfig().modem_capabilities = undefined;
	setModemCapabilityEvidenceReader(null);
	setCapabilityEvidenceChangeNotifier(null);
	resetModemGpsState();
});

describe("the gates are readable, and they start OFF", () => {
	test("a device nobody has configured reports every module off", async () => {
		const result = await callGet();
		expect(getConfig().modem_capabilities).toBeUndefined();
		for (const value of Object.values(result.gates)) {
			expect(value).toBe(false);
		}
	});

	test("the read is TOTAL — every module is named, never a sparse object", async () => {
		const result = await callGet();
		expect(Object.keys(result.gates).sort()).toEqual(
			[
				"band-lock",
				"esim",
				"fcc-auto-unlock",
				"five-g-pref",
				"gps",
				"sms",
				"ussd",
			].sort(),
		);
	});

	test("it reports which modules THIS BUILD ships, so a surface can hide the rest", async () => {
		const result = await callGet();
		expect([...result.implemented].sort()).toEqual([...IMPLEMENTED].sort());
	});
});

describe("the write persists, and it republishes", () => {
	test("enabling a module lands in config under its PERSISTED key", async () => {
		const result = await callSet("gps", true);
		expect(result.success).toBe(true);
		// The config key is `gps`; a module whose wire id and config key differ is
		// covered by the five-g case below.
		expect(getConfig().modem_capabilities?.gps).toBe(true);
	});

	test("a wire id and its config key are NOT the same string, and the write uses the config key", async () => {
		await callSet("five-g-pref", true);
		expect(getConfig().modem_capabilities?.five_g_pref).toBe(true);
		expect(
			(getConfig().modem_capabilities as Record<string, unknown> | undefined)?.[
				"five-g-pref"
			],
		).toBeUndefined();
	});

	test("`applied` is the FULL post-write record, so a UI locks to device truth", async () => {
		const result = await callSet("band-lock", true);
		expect(result.applied?.["band-lock"]).toBe(true);
		expect(result.applied?.gps).toBe(false);
		expect(Object.keys(result.applied ?? {})).toHaveLength(7);
	});

	test("turning one module on leaves its neighbours untouched", async () => {
		await callSet("gps", true);
		await callSet("band-lock", true);
		const result = await callGet();
		expect(result.gates.gps).toBe(true);
		expect(result.gates["band-lock"]).toBe(true);
		expect(result.gates.ussd).toBe(false);
	});

	test("turning a module back off persists the OFF, it does not drop the key", async () => {
		await callSet("gps", true);
		const off = await callSet("gps", false);
		expect(off.applied?.gps).toBe(false);
		expect(getConfig().modem_capabilities?.gps).toBe(false);
	});

	test("the handler RE-BROADCASTS the roster — a static wiring lock", () => {
		// Behavioural coverage cannot reach this: `broadcastMsg` writes to live
		// sockets, and stubbing the whole rpc/events graph to observe one call
		// would assert the stub. The `udev-rules-sigusr2-scope` precedent applies —
		// lock the wiring at the source, comment-stripped so this prose cannot
		// satisfy it.
		const source = readFileSync(
			new URL("../rpc/procedures/modems.procedure.ts", import.meta.url),
			"utf8",
		).replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
		const handler = source.slice(
			source.indexOf("export const setModemCapabilitiesProcedure"),
			source.indexOf("Which bands this modem advertises"),
		);
		expect(handler).toContain("saveConfig()");
		expect(handler).toContain("broadcastModems()");
	});

	test("the write moves the CLAIM the wire producer reads, not just a config key", async () => {
		evidence({ capability: { gps: "present" } });
		expect(resolveModemCapabilityClaims(KEY, IMPLEMENTED).gps).toBe(
			"implemented",
		);
		await callSet("gps", true);
		expect(resolveModemCapabilityClaims(KEY, IMPLEMENTED).gps).toBe("capable");
	});
});

describe("a probe that PROVES a capability republishes the roster", () => {
	test("the notifier is inert until something installs one", () => {
		let fired = 0;
		setCapabilityEvidenceChangeNotifier(null);
		expect(() => noteCapabilityEvidenceChanged()).not.toThrow();
		setCapabilityEvidenceChangeNotifier(() => {
			fired += 1;
		});
		noteCapabilityEvidenceChanged();
		expect(fired).toBe(1);
	});

	test("a THROWING notifier never breaks the probe that called it", () => {
		setCapabilityEvidenceChangeNotifier(() => {
			throw new Error("broadcast exploded");
		});
		expect(() => noteCapabilityEvidenceChanged()).not.toThrow();
	});

	test("a GPS read that first proves the receiver notifies exactly once, then stays quiet", async () => {
		let fired = 0;
		setCapabilityEvidenceChangeNotifier(() => {
			fired += 1;
		});
		const read = await readModemGps("0", gpsDeps({ gnssCapable: true }));
		expect(read.success).toBe(true);
		expect(fired).toBe(1);
		// Steady state: re-reading an already-proven modem changes nothing, so it
		// must not re-broadcast the roster on every dialog open.
		await readModemGps("0", gpsDeps({ gnssCapable: true }));
		expect(fired).toBe(1);
	});

	test("a GPS read whose answer FLIPS notifies again", async () => {
		let fired = 0;
		setCapabilityEvidenceChangeNotifier(() => {
			fired += 1;
		});
		await readModemGps("0", gpsDeps({ gnssCapable: true }));
		await readModemGps("0", gpsDeps({ gnssCapable: false }));
		expect(fired).toBe(2);
	});
});

describe("a module this build does not ship is REFUSED, never persisted", () => {
	test("`esim` is refused with its typed reason", async () => {
		const result = await callSet("esim", true);
		expect(result.success).toBe(false);
		expect(result.error).toBe("module_not_implemented");
	});

	test("the refusal writes NOTHING — not the key, not a false", async () => {
		await callSet("esim", true);
		expect(getConfig().modem_capabilities).toBeUndefined();
	});

	test("`sms` is refused too — a read-only surface has no gate to arm", async () => {
		const result = await callSet("sms", true);
		expect(result.success).toBe(false);
		expect(result.error).toBe("module_not_implemented");
	});

	test("a refusal never disturbs a gate that was already on", async () => {
		await callSet("gps", true);
		await callSet("esim", true);
		expect(getConfig().modem_capabilities?.gps).toBe(true);
	});
});

describe("THE GATE IS A PRECONDITION, NOT A BYPASS", () => {
	test("an enabled gate on an UNPROBED modem stops at `enabled` — surfaced by nothing", async () => {
		evidence({ capability: {} });
		await callSet("gps", true);
		expect(resolveModemCapabilityClaims(KEY, IMPLEMENTED).gps).toBe("enabled");
	});

	test("an enabled gate on a modem that POSITIVELY LACKS the hardware stays `unavailable`", async () => {
		evidence({ capability: { gps: "absent" } });
		await callSet("gps", true);
		expect(resolveModemCapabilityClaims(KEY, IMPLEMENTED).gps).toBe(
			"unavailable",
		);
	});

	test("`certified` is unreachable from the gate — a proven modem reaches `capable` and stops", async () => {
		evidence({ capability: { "band-lock": "present" } });
		await callSet("band-lock", true);
		expect(resolveModemCapabilityClaims(KEY, IMPLEMENTED)["band-lock"]).toBe(
			"capable",
		);
	});

	test("band-lock's stricter certification floor is untouched by a fully-enabled gate", async () => {
		evidence({
			capability: { "band-lock": "present" },
			certified: { "band-lock": false },
		});
		await callSet("band-lock", true);
		// `capable` is the SURFACE floor, but band-lock additionally refuses an
		// uncertified model+firmware at its own procedure — the gate cannot and
		// does not move that.
		expect(resolveModemCapabilityClaims(KEY, IMPLEMENTED)["band-lock"]).toBe(
			"capable",
		);
		evidence({
			capability: { "band-lock": "present" },
			certified: { "band-lock": true },
		});
		expect(resolveModemCapabilityClaims(KEY, IMPLEMENTED)["band-lock"]).toBe(
			"certified",
		);
	});

	test("a module whose gate was never touched is unaffected by another module's write", async () => {
		evidence({ capability: { gps: "present", ussd: "present" } });
		await callSet("gps", true);
		expect(resolveModemCapabilityClaims(KEY, IMPLEMENTED).ussd).toBe(
			"implemented",
		);
	});
});
