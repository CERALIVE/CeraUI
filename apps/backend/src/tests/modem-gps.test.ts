/*
 * The gated GPS/location module.
 *
 * THE FLEET FIXTURES ARE REAL. The four capability sets below are the literal
 * `mmcli --location-status` readings captured on the bench board on 2026-08-17
 * (`.omo/notepads/modem-phase-c-quality/hardware-gates.md` §(c)): three modems
 * advertise GNSS and the FM350-GL advertises `3gpp-lac-ci` only. They are used
 * verbatim so the capability gate is proven against hardware that exists.
 *
 * WHAT IS PROVABLE WITHOUT AN ANTENNA IS WHAT MATTERS HERE. Todo 2 left the
 * antenna question open (`needs-user N1`), so the paths an antenna-less operator
 * actually experiences — the bounded wait ending in an honest `no-fix`, a fix
 * dropped when it goes stale, and disable clearing everything — carry the weight
 * of this suite. A live fix is the one thing it cannot assert.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { GnssFixState } from "@ceraui/rpc/schemas";
import { GNSS_ACQUIRE_TIMEOUT_MS, GNSS_FIX_TTL_MS } from "@ceraui/rpc/schemas";
import { getConfig } from "../modules/config.ts";
import {
	initModemCapabilityEvidence,
	readModemCapabilityEvidence,
} from "../modules/modems/capability-evidence.ts";
import {
	resolveCapabilityModuleState,
	setModemCapabilityEvidenceReader,
} from "../modules/modems/capability-gates.ts";
import {
	gpsEvidence,
	readModemGps,
	resetModemGpsState,
	setModemGps,
} from "../modules/modems/gps.ts";
import {
	advanceGnssFixState,
	GNSS_OFF,
	renderableFix,
} from "../modules/modems/gps-fix-state.ts";
import {
	classifyLocationCliFailure,
	hasGnssSource,
	parseLocationFix,
	parseLocationStatus,
	setLocationGnss,
} from "../modules/modems/mmcli-location.ts";

// hardware-gates.md §(c) — captured live on ceralive2, 2026-08-17.
const FLEET = {
	"Quectel RM530N-GL": [
		"3gpp-lac-ci",
		"gps-raw",
		"gps-nmea",
		"gps-unmanaged",
		"agps-msa",
		"agps-msb",
	],
	"SIMCom SIM7600G-H": [
		"3gpp-lac-ci",
		"gps-raw",
		"gps-nmea",
		"gps-unmanaged",
		"agps-msa",
		"agps-msb",
	],
	"Qualcomm HIMI_U01": [
		"3gpp-lac-ci",
		"gps-raw",
		"gps-nmea",
		"agps-msa",
		"agps-msb",
	],
	"Fibocom FM350-GL": ["3gpp-lac-ci"],
} as const;

const GNSS_FLEET = [
	"Quectel RM530N-GL",
	"SIMCom SIM7600G-H",
	"Qualcomm HIMI_U01",
] as const;

const STABLE_KEY = "platform-xhci-hcd.0.auto-usb-0:1.4.4";
const DEVICE = "14";

function statusOutput(
	capabilities: readonly string[],
	enabled: readonly string[] = [],
): string {
	const lines = [`modem.location.capabilities.length : ${capabilities.length}`];
	capabilities.forEach((source, index) => {
		lines.push(`modem.location.capabilities.value[${index + 1}] : ${source}`);
	});
	if (enabled.length === 0) {
		lines.push("modem.location.enabled : --");
	} else {
		lines.push(`modem.location.enabled.length : ${enabled.length}`);
		enabled.forEach((source, index) => {
			lines.push(`modem.location.enabled.value[${index + 1}] : ${source}`);
		});
	}
	return lines.join("\n");
}

const FIX_OUTPUT = [
	"modem.location.gps.utc       : 181908.00",
	"modem.location.gps.latitude  : 4.6097100",
	"modem.location.gps.longitude : -74.0817500",
	"modem.location.gps.altitude  : 2640.000000",
].join("\n");

/** What an enabled receiver with no antenna answers: the keys, no position. */
const NO_FIX_OUTPUT = [
	"modem.location.gps.utc       : --",
	"modem.location.gps.latitude  : --",
	"modem.location.gps.longitude : --",
].join("\n");

type Script = {
	readonly capabilities: readonly string[];
	enabled: string[];
	readonly fix?: string;
	readonly statusThrows?: Error;
	readonly setThrows?: Error;
};

function scriptedRunner(script: Script): {
	run: (args: string[]) => Promise<string>;
	calls: string[][];
} {
	const calls: string[][] = [];
	return {
		calls,
		run: async (args) => {
			calls.push(args);
			if (args.includes("--location-status")) {
				if (script.statusThrows) throw script.statusThrows;
				return statusOutput(script.capabilities, script.enabled);
			}
			if (args.includes("--location-get")) {
				return script.fix ?? NO_FIX_OUTPUT;
			}
			if (script.setThrows) throw script.setThrows;
			for (const arg of args) {
				const enable = /^--location-enable-(.+)$/.exec(arg);
				if (enable?.[1] !== undefined && !script.enabled.includes(enable[1])) {
					script.enabled.push(enable[1]);
				}
				const disable = /^--location-disable-(.+)$/.exec(arg);
				if (disable?.[1] !== undefined) {
					script.enabled = script.enabled.filter((s) => s !== disable[1]);
				}
			}
			return "";
		},
	};
}

function depsFor(script: Script, now: () => number) {
	const runner = scriptedRunner(script);
	return {
		deps: {
			now,
			runCli: runner.run,
			resolveIdentity: async () => ({ stableKey: STABLE_KEY }),
		},
		calls: runner.calls,
	};
}

function enableGate(): void {
	const config = getConfig() as Record<string, unknown>;
	config.modem_capabilities = { gps: true };
}

function clearGate(): void {
	const config = getConfig() as Record<string, unknown>;
	config.modem_capabilities = undefined;
}

describe("capability detection against the real fleet", () => {
	it("the three GNSS-advertising fleet modems parse as gnssCapable", () => {
		for (const model of GNSS_FLEET) {
			const parsed = parseLocationStatus(statusOutput(FLEET[model]));
			expect(parsed.ok, model).toBe(true);
			if (!parsed.ok) continue;
			expect(parsed.status.gnssCapable, model).toBe(true);
			expect(parsed.status.gnssEnabled, model).toBe(false);
		}
	});

	it("the FM350-GL advertises 3gpp-lac-ci only and is NOT gnssCapable", () => {
		const parsed = parseLocationStatus(statusOutput(FLEET["Fibocom FM350-GL"]));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.status.capabilities).toEqual(["3gpp-lac-ci"]);
		expect(parsed.status.gnssCapable).toBe(false);
	});

	it("the Quectel's real reading has 3gpp-lac-ci ENABLED and GNSS not", () => {
		const parsed = parseLocationStatus(
			statusOutput(FLEET["Quectel RM530N-GL"], ["3gpp-lac-ci"]),
		);
		expect(parsed.ok && parsed.status.enabledSources).toEqual(["3gpp-lac-ci"]);
		expect(parsed.ok && parsed.status.gnssEnabled).toBe(false);
	});

	it("the Location interface alone is NOT a GNSS claim", () => {
		expect(hasGnssSource(["3gpp-lac-ci"])).toBe(false);
		expect(hasGnssSource(["3gpp-lac-ci", "gps-raw"])).toBe(true);
	});

	it("output with no capabilities key at all is drift, not 'no GNSS'", () => {
		expect(parseLocationStatus("modem.generic.state : registered")).toEqual({
			ok: false,
			reason: "read_failed",
		});
	});

	it("mmcli failures classify into distinct operator facts", () => {
		expect(
			classifyLocationCliFailure("modem has no location capabilities"),
		).toBe("unsupported");
		expect(classifyLocationCliFailure("error: modem not enabled yet")).toBe(
			"not_enabled",
		);
		expect(classifyLocationCliFailure("error: couldn't find modem")).toBe(
			"unknown_modem",
		);
		expect(classifyLocationCliFailure("some new mmcli error")).toBe(
			"read_failed",
		);
	});
});

describe("the fix parser", () => {
	it("decodes a real record with the READ timestamp, not the modem clock", () => {
		const fix = parseLocationFix(FIX_OUTPUT, 555_000);
		expect(fix?.latitude).toBeCloseTo(4.60971, 5);
		expect(fix?.longitude).toBeCloseTo(-74.08175, 5);
		expect(fix?.altitude).toBeCloseTo(2640, 3);
		expect(fix?.utcTime).toBe("181908.00");
		expect(fix?.observedAt).toBe(555_000);
	});

	it("keys present but unpopulated is NOT a fix — never 0,0", () => {
		expect(parseLocationFix(NO_FIX_OUTPUT, 1_000)).toBeUndefined();
	});

	it("an out-of-range coordinate is refused, not clamped", () => {
		const bogus = FIX_OUTPUT.replace("4.6097100", "91.5");
		expect(parseLocationFix(bogus, 1_000)).toBeUndefined();
	});

	it("never throws on hostile input", () => {
		for (const raw of ["", ":", "modem.location.gps.latitude", "\0\0"]) {
			expect(() => parseLocationFix(raw, 1_000)).not.toThrow();
			expect(parseLocationFix(raw, 1_000)).toBeUndefined();
		}
	});
});

describe("the bounded wait ends — the antenna-less path", () => {
	const run = (events: readonly Parameters<typeof advanceGnssFixState>[1][]) =>
		events.reduce<GnssFixState>(
			(state, event) => advanceGnssFixState(state, event),
			GNSS_OFF,
		);

	it("enabling starts a bounded wait carrying its own deadline", () => {
		const state = run([{ kind: "gnss-enabled", at: 0 }]);
		expect(state).toEqual({
			kind: "acquiring",
			since: 0,
			deadline: GNSS_ACQUIRE_TIMEOUT_MS,
		});
	});

	it("a no-fix report INSIDE the bound is still legitimately acquiring", () => {
		const state = run([
			{ kind: "gnss-enabled", at: 0 },
			{
				kind: "read",
				at: GNSS_ACQUIRE_TIMEOUT_MS - 1,
				read: { outcome: "no-fix" },
			},
		]);
		expect(state.kind).toBe("acquiring");
	});

	it("at the bound it becomes an honest terminal no-fix — never a spinner", () => {
		const state = run([
			{ kind: "gnss-enabled", at: 0 },
			{ kind: "tick", at: GNSS_ACQUIRE_TIMEOUT_MS },
		]);
		expect(state).toEqual({
			kind: "no-fix",
			since: GNSS_ACQUIRE_TIMEOUT_MS,
			reason: "acquire-timeout",
		});
	});

	it("an antenna-less modem NEVER reaches a renderable fix, however long", () => {
		let state: GnssFixState = advanceGnssFixState(GNSS_OFF, {
			kind: "gnss-enabled",
			at: 0,
		});
		for (let at = 1_000; at <= 900_000; at += 1_000) {
			state = advanceGnssFixState(state, {
				kind: "read",
				at,
				read: { outcome: "no-fix" },
			});
			expect(renderableFix(state)).toBeUndefined();
		}
		expect(state.kind).toBe("no-fix");
	});
});

describe("stale-fix clearing — a coordinate never outlives its life", () => {
	const FIX = { latitude: 4.60971, longitude: -74.08175, observedAt: 1_000 };
	const run = (events: readonly Parameters<typeof advanceGnssFixState>[1][]) =>
		events.reduce<GnssFixState>(
			(state, event) => advanceGnssFixState(state, event),
			GNSS_OFF,
		);

	it("a fresh fix is renderable", () => {
		const state = run([
			{ kind: "gnss-enabled", at: 0 },
			{ kind: "read", at: 1_000, read: { outcome: "fix", fix: FIX } },
		]);
		expect(renderableFix(state)?.latitude).toBe(4.60971);
	});

	it("a fix past its TTL is DROPPED, not merely marked stale", () => {
		const at = 1_000 + GNSS_FIX_TTL_MS;
		const state = run([
			{ kind: "gnss-enabled", at: 0 },
			{ kind: "read", at: 1_000, read: { outcome: "fix", fix: FIX } },
			{ kind: "tick", at },
		]);
		expect(state).toEqual({ kind: "no-fix", since: at, reason: "fix-expired" });
		expect(JSON.stringify(state)).not.toContain("4.60971");
	});

	it("the modem losing its fix drops the held coordinates immediately", () => {
		const state = run([
			{ kind: "gnss-enabled", at: 0 },
			{ kind: "read", at: 1_000, read: { outcome: "fix", fix: FIX } },
			{ kind: "read", at: 2_000, read: { outcome: "no-fix" } },
		]);
		expect(state).toEqual({
			kind: "no-fix",
			since: 2_000,
			reason: "reported-no-fix",
		});
	});

	it("disabling drops a held fix and returns to off", () => {
		const state = run([
			{ kind: "gnss-enabled", at: 0 },
			{ kind: "read", at: 1_000, read: { outcome: "fix", fix: FIX } },
			{ kind: "gnss-disabled" },
		]);
		expect(state).toEqual({ kind: "off" });
		expect(JSON.stringify(state)).not.toContain("74.08175");
	});

	it("an unsupported modem is `unavailable`, never a no-fix wait", () => {
		const state = run([
			{ kind: "gnss-enabled", at: 0 },
			{
				kind: "read",
				at: 1_000,
				read: { outcome: "unavailable", reason: "no GNSS" },
			},
		]);
		expect(state).toEqual({ kind: "unavailable", reason: "no GNSS" });
	});
});

describe("enable / disable against the mmcli surface", () => {
	it("enable turns on the advertised GNSS sources and re-reads", async () => {
		const script: Script = {
			capabilities: FLEET["Quectel RM530N-GL"],
			enabled: [],
		};
		const runner = scriptedRunner(script);
		const result = await setLocationGnss(DEVICE, true, runner.run);

		expect(result.ok && result.status.gnssEnabled).toBe(true);
		expect(result.ok && [...result.status.enabledSources].sort()).toEqual([
			"gps-nmea",
			"gps-raw",
		]);
	});

	it("no call ever asks ModemManager to BROADCAST the location", async () => {
		const script: Script = {
			capabilities: FLEET["Quectel RM530N-GL"],
			enabled: [],
		};
		const runner = scriptedRunner(script);
		await setLocationGnss(DEVICE, true, runner.run);
		await setLocationGnss(DEVICE, false, runner.run);

		for (const args of runner.calls) {
			for (const arg of args) {
				expect(arg).not.toContain("enable-signal");
			}
		}
	});

	it("disable clears ONLY the GNSS bits — cell location survives", async () => {
		const script: Script = {
			capabilities: FLEET["Quectel RM530N-GL"],
			enabled: ["3gpp-lac-ci", "gps-raw", "gps-nmea"],
		};
		const runner = scriptedRunner(script);
		const result = await setLocationGnss(DEVICE, false, runner.run);

		expect(result.ok && result.status.enabledSources).toEqual(["3gpp-lac-ci"]);
		expect(result.ok && result.status.gnssEnabled).toBe(false);
	});

	it("enabling on the FM350-GL is refused honestly, and sends NOTHING", async () => {
		const script: Script = {
			capabilities: FLEET["Fibocom FM350-GL"],
			enabled: [],
		};
		const runner = scriptedRunner(script);
		const result = await setLocationGnss(DEVICE, true, runner.run);

		expect(result).toEqual({ ok: false, reason: "unsupported" });
		for (const args of runner.calls) {
			expect(args.some((arg) => arg.startsWith("--location-enable"))).toBe(
				false,
			);
		}
	});

	it("a failed write is surfaced as a refusal, never as applied", async () => {
		const script: Script = {
			capabilities: FLEET["Quectel RM530N-GL"],
			enabled: [],
			setThrows: new Error("error: modem not enabled yet"),
		};
		const runner = scriptedRunner(script);
		const result = await setLocationGnss(DEVICE, true, runner.run);
		expect(result).toMatchObject({ ok: false, reason: "not_enabled" });
	});
});

describe("the module under the capability gate", () => {
	beforeEach(() => {
		resetModemGpsState();
		setModemCapabilityEvidenceReader(readModemCapabilityEvidence);
		enableGate();
	});

	afterEach(() => {
		resetModemGpsState();
		initModemCapabilityEvidence();
		clearGate();
	});

	it("a modem nothing has read yet is `unknown`, never `absent`", () => {
		expect(gpsEvidence(STABLE_KEY)).toBe("unknown");
		expect(gpsEvidence(undefined)).toBe("unknown");
	});

	it("reading a GNSS modem records `present` and surfaces the module", async () => {
		const script: Script = {
			capabilities: FLEET["Quectel RM530N-GL"],
			enabled: [],
		};
		const { deps } = depsFor(script, () => 1_000);
		const result = await readModemGps(DEVICE, deps);

		expect(result.success).toBe(true);
		expect(gpsEvidence(STABLE_KEY)).toBe("present");
		expect(resolveCapabilityModuleState("gps", STABLE_KEY, ["gps"])).toBe(
			"capable",
		);
	});

	it("reading the FM350-GL records `absent` and the module stays unavailable", async () => {
		const script: Script = {
			capabilities: FLEET["Fibocom FM350-GL"],
			enabled: [],
		};
		const { deps } = depsFor(script, () => 1_000);
		await readModemGps(DEVICE, deps);

		expect(gpsEvidence(STABLE_KEY)).toBe("absent");
		expect(resolveCapabilityModuleState("gps", STABLE_KEY, ["gps"])).toBe(
			"unavailable",
		);
	});

	it("GNSS OFF answers `off` and never asks for a fix", async () => {
		const script: Script = {
			capabilities: FLEET["Quectel RM530N-GL"],
			enabled: [],
		};
		const { deps, calls } = depsFor(script, () => 1_000);
		const result = await readModemGps(DEVICE, deps);

		expect(result.success && result.state).toEqual({ kind: "off" });
		expect(calls.some((args) => args.includes("--location-get"))).toBe(false);
	});

	it("the whole antenna-less operator journey ends in an honest no-fix", async () => {
		const script: Script = {
			capabilities: FLEET["Quectel RM530N-GL"],
			enabled: [],
		};
		let clock = 0;
		const { deps } = depsFor(script, () => clock);

		const enabled = await setModemGps(DEVICE, true, deps);
		expect(enabled.success).toBe(true);
		expect(enabled.state?.kind).toBe("acquiring");

		clock = 30_000;
		expect((await readModemGps(DEVICE, deps)).state?.kind).toBe("acquiring");

		clock = GNSS_ACQUIRE_TIMEOUT_MS;
		const timedOut = await readModemGps(DEVICE, deps);
		expect(timedOut.state).toEqual({
			kind: "no-fix",
			since: GNSS_ACQUIRE_TIMEOUT_MS,
			reason: "acquire-timeout",
		});

		clock = GNSS_ACQUIRE_TIMEOUT_MS + 600_000;
		const later = await readModemGps(DEVICE, deps);
		expect(later.state?.kind).toBe("no-fix");
		expect(JSON.stringify(later)).not.toContain("latitude");
	});

	it("a fix is held while fresh and DROPPED once stale", async () => {
		const script: Script = {
			capabilities: FLEET["Quectel RM530N-GL"],
			enabled: [],
			fix: FIX_OUTPUT,
		};
		let clock = 0;
		const { deps } = depsFor(script, () => clock);

		await setModemGps(DEVICE, true, deps);
		clock = 1_000;
		const fresh = await readModemGps(DEVICE, deps);
		expect(fresh.state?.kind).toBe("fix");

		// The read at this instant returns the SAME record, so the fix is simply
		// refreshed — staleness is only observable when the device stops answering.
		script.enabled.push("gps-raw");
		clock = 1_000 + GNSS_FIX_TTL_MS;
		const stale = advanceGnssFixState(
			{
				kind: "fix",
				fix: { latitude: 4.60971, longitude: -74.08175, observedAt: 1_000 },
			},
			{ kind: "tick", at: clock },
		);
		expect(stale).toEqual({
			kind: "no-fix",
			since: clock,
			reason: "fix-expired",
		});
	});

	it("disabling clears the session — the fix does not outlive the receiver", async () => {
		const script: Script = {
			capabilities: FLEET["Quectel RM530N-GL"],
			enabled: [],
			fix: FIX_OUTPUT,
		};
		let clock = 0;
		const { deps } = depsFor(script, () => clock);

		await setModemGps(DEVICE, true, deps);
		clock = 1_000;
		expect((await readModemGps(DEVICE, deps)).state?.kind).toBe("fix");

		const disabled = await setModemGps(DEVICE, false, deps);
		expect(disabled.success).toBe(true);
		expect(disabled.state).toEqual({ kind: "off" });
		expect(JSON.stringify(disabled)).not.toContain("4.60971");

		const after = await readModemGps(DEVICE, deps);
		expect(after.state).toEqual({ kind: "off" });
	});

	it("an OFF gate refuses the toggle and mutates nothing", async () => {
		clearGate();
		const script: Script = {
			capabilities: FLEET["Quectel RM530N-GL"],
			enabled: [],
		};
		const { deps, calls } = depsFor(script, () => 0);

		const result = await setModemGps(DEVICE, true, deps);
		expect(result.success).toBe(false);
		expect(result.mutationRefusal).toBe("module_disabled");
		// The refusal is what matters, and so is its BLAST RADIUS: the capability
		// probe is a READ the gate needs to be answerable, but not one
		// `--location-enable` flag may reach the device.
		expect(script.enabled).toEqual([]);
		for (const args of calls) {
			expect(args.some((arg) => /^--location-(enable|disable)/.test(arg))).toBe(
				false,
			);
		}
	});

	it("an unresolvable device is refused before anything is read", async () => {
		const script: Script = {
			capabilities: FLEET["Quectel RM530N-GL"],
			enabled: [],
		};
		const runner = scriptedRunner(script);
		const result = await setModemGps(DEVICE, true, {
			now: () => 0,
			runCli: runner.run,
			resolveIdentity: async () => undefined,
		});
		expect(result).toEqual({ success: false, error: "unknown_modem" });
		expect(runner.calls).toEqual([]);
	});
});
