/*
    CeraUI - web UI for the CERALIVE project
    Copyright (C) 2024-2026 CeraLive project


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

/*
 * Fan presence + PWM duty cycle — a sysfs read whose whole difficulty is that
 * the numbers naming its own files are not stable.
 *
 * WHAT IS READ, AND WHY ONLY THAT
 *
 *   The reference board's fan is 2-wire: `pwmfan`'s hwmon directory exposes
 *   `pwm1` and `pwm1_enable` and NO `fan1_input`. There is no tachometer, so
 *   there is no RPM — this module never reports, infers, or names one. The one
 *   legitimate magnitude is the duty cycle `pwm1 / 255`, a real fraction with a
 *   real denominator.
 *
 *   The thermal cooling device's `cur_state` / `max_state` (0-6 on this board)
 *   is deliberately NOT read. Those levels are an INDEX into the devicetree
 *   `cooling-levels = <0 120 150 180 210 240 255>` table, not a linear scale of
 *   airflow, so `2 / 6 = 33 %` would fabricate a denominator the hardware never
 *   produced — the same sin as rendering a busy/idle encoder core as `50 %`
 *   (`encoder-load.ts`). Not reading it at all is the simplest way to keep that
 *   derivation unreachable.
 *
 * WHY DISCOVERY IS BY TYPE STRING AND NEVER BY INDEX
 *
 *   `cooling_deviceN` and `hwmonN` are both registration-order artefacts. They
 *   differ between boards, between the vendor 6.1 BSP and the mainline/edge
 *   tree, and they MOVE: the reference Rock 5B+ was measured at `hwmon8` =
 *   `pwmfan` bound to `cooling_device4`, and both indices shifted across a
 *   reboot in the same session. Hardcoding either is how a "working" reading
 *   silently starts reporting an unrelated device. So the scan is:
 *
 *     1. read every `/sys/class/thermal/cooling_device<N>/type` and keep the one
 *        that reads exactly `pwm-fan`;
 *     2. follow that cooling device's `device` symlink to the platform device
 *        that owns it, and read `pwm1` from the hwmon hanging off it.
 *
 *   Step 1 is the SAME discovery the shipped `ceralive-fan-curve` service already
 *   uses (`image-building-pipeline/v2/mkosi/runtime/ceralive-fan-curve.sh`), in
 *   TypeScript. Kernel ABI reference:
 *   Documentation/ABI/testing/sysfs-class-thermal.
 *
 * …AND STEP 2's BACKLINK DOES NOT EXIST ON EVERY KERNEL
 *
 *   Board-confirmed on the reference Rock 5B+ running the mainline/edge kernel
 *   `7.1.5-ceralive-rk3588`: the `pwm-fan` cooling device has NO `device` entry at
 *   all (nor an `of_node`), because this driver's
 *   `thermal_cooling_device_register()` call sets no parent `struct device`, so
 *   the class-device sysfs machinery never creates the backlink:
 *
 *     /sys/class/thermal/cooling_device4/  → cur_state max_state power/
 *                                            subsystem -> ... type uevent
 *     /sys/class/thermal/cooling_device4/type            → `pwm-fan`
 *     /sys/class/hwmon/hwmon8/name                       → `pwmfan`
 *     /sys/class/hwmon/hwmon8/pwm1                       → 120
 *     /sys/class/hwmon/hwmon8/device -> ../../../pwm-fan
 *
 *   The FORWARD link is fine — `/sys/devices/platform/pwm-fan/hwmon/hwmon8`
 *   exists, and hwmon knows its own platform device. It is only the
 *   cooling_device → device backlink that is absent, so step 2's whole path is
 *   permanently unreachable and the collector reported `unknown` on a board whose
 *   fan was present, running, and measurable. This is why the earlier claim that
 *   the `device` chain is reliable was simply wrong.
 *
 *     3. ONLY when the cooling device carries no `device` entry of its own, scan
 *        `/sys/class/hwmon/hwmon<N>/name` for the exact string `pwmfan` and read
 *        `pwm1` from the single hwmon that matches.
 *
 *   Step 3 is NOT a retreat from the type-string discipline: `hwmon<N>/name` is
 *   the same class of driver-authored identity string as `cooling_device<N>/type`,
 *   just on the other side of the class hierarchy, and no index is assumed on
 *   either side. It is deliberately narrow in three ways: it is GATED on an
 *   already-confirmed `pwm-fan` cooling device (it never becomes a "find any fan"
 *   mechanism), it fires ONLY when the backlink is absent (a backlink that exists
 *   but whose `pwm1` read failed reports `unknown` rather than starting a parallel
 *   scan that could adopt an unrelated fan on a multi-fan board), and MORE THAN
 *   ONE `pwmfan` hwmon is genuinely ambiguous, so it reports `unknown` rather than
 *   guessing which one this cooling device meant.
 *
 * FOUR HONEST STATES
 *
 *   A board with no `pwm-fan` cooling device is a real, shipping configuration
 *   (x86-minipc), so its absence is reported as the explicit `absent` state —
 *   never hidden, and never collapsed into `unknown`. Hiding it would make "this
 *   board has no fan" indistinguishable from "this build has no fan feature",
 *   and reporting it as unknown would claim we failed to read something that is
 *   provably not there. A MEASURED zero duty is likewise `off`, not a gap.
 *
 * DEGRADATION
 *
 *   Follows `device-stats.ts`/`encoder-load.ts`: every sysfs read sits in its own
 *   try/catch, one unreadable node degrades only its own field, and a tick can
 *   never throw. A present fan whose `pwm1` cannot be read reports `unknown`
 *   rather than a shaped guess.
 *
 * PRIVILEGE
 *
 *   None is escalated. These are world-readable sysfs nodes and the backend runs
 *   as root (`deployment/ceralive.service` `User=root`), so this uses the same
 *   plain `Bun.file()` seam as `sensors.ts` and `encoder-load.ts`.
 */

import { readdir } from "node:fs/promises";

import { FAN_PWM_FULL_SCALE, type FanReading } from "@ceraui/rpc";

import { logger } from "../../helpers/logger.ts";
import { ACTIVE_TO } from "../../helpers/shared.ts";
import { getms } from "../../helpers/time.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import { isRealDevice } from "./device-detection.ts";

/**
 * Broadcast channel name. Declared here (and re-exported from `rpc/events.ts`)
 * so consumers resolve it from the emitter, exactly like `ENCODER_LOAD_EVENT`.
 */
export const FAN_EVENT = "fan" as const;

/** Broadcast cadence for the `fan` event. */
export const FAN_INTERVAL_MS = 5000;

/** Kernel thermal class directory — the root of the discovery scan. */
export const THERMAL_CLASS_DIR = "/sys/class/thermal";

/** Kernel hwmon class directory — the root of the backlink-less fallback scan. */
export const HWMON_CLASS_DIR = "/sys/class/hwmon";

/** The exact `cooling_device<N>/type` string a PWM fan registers under. */
const PWM_FAN_TYPE = "pwm-fan";

/**
 * The exact `hwmon<N>/name` string the same driver registers its hwmon under.
 * Note it is NOT spelled the same as the cooling device's type — `pwmfan` here,
 * `pwm-fan` there — so neither string may be derived from the other.
 */
const PWM_FAN_HWMON_NAME = "pwmfan";

/** The honest floors, shared so every caller reports the same object shape. */
export const FAN_ABSENT: FanReading = { state: "absent" };
export const FAN_UNKNOWN: FanReading = { state: "unknown" };

/** Injected I/O surface — replaced wholesale in tests. */
export type FanDeps = {
	readText: (path: string) => Promise<string>;
	readDir: (path: string) => Promise<string[]>;
};

// ─── pure parsers (exported for tests) ──────────────────────────────────────

/**
 * Turn a raw `pwm1` register value into a 0-100 duty-cycle percentage.
 *
 * `pwm1` is an 8-bit register, so the denominator is its full scale (255) and
 * nothing else. Anything non-integral, negative, or above full scale is REFUSED
 * rather than clamped — an out-of-range figure means the parse was wrong, and a
 * clamped wrong figure still reads as a measurement (same rule as
 * `parseLoadPercent` in `encoder-load.ts`).
 *
 * The result is rounded to one decimal so the reported figure stays a faithful
 * rendering of the register (120 ⇒ 47.1 %) without carrying float noise.
 */
export function parsePwmDuty(raw: string): number | null {
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	const n = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(n)) return null;
	if (n < 0 || n > FAN_PWM_FULL_SCALE) return null;
	return Math.round((n / FAN_PWM_FULL_SCALE) * 1000) / 10;
}

/**
 * Build the reading a measured duty implies. A zero is `off` — a real reading —
 * and everything above it is `running`. This is the ONLY place a duty becomes a
 * state, so the `off`-vs-`unknown` distinction cannot drift.
 */
export function fanReadingForDuty(dutyPercent: number): FanReading {
	return dutyPercent > 0
		? { state: "running", dutyPercent }
		: { state: "off", dutyPercent: 0 };
}

/** Sort `<prefix><n>` sysfs entries by their NUMERIC suffix, not lexically. */
function numericSuffix(name: string): number {
	const match = name.match(/(\d+)$/);
	return match?.[1] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[1]);
}

function byNumericSuffix(a: string, b: string): number {
	return numericSuffix(a) - numericSuffix(b);
}

/**
 * Does this error mean the path simply is not there?
 *
 * A missing `/sys/class/thermal` is a statement about the BOARD (no thermal
 * class ⇒ no `pwm-fan` cooling device), which is provable absence. Any other
 * failure is a statement about the READ, which is an unknown. Collapsing the two
 * would either claim a fan-less board might have one, or claim a transient read
 * failure proves it has none.
 */
function isNotFound(err: unknown): boolean {
	return (err as { code?: unknown } | null)?.code === "ENOENT";
}

// ─── discovery ──────────────────────────────────────────────────────────────

/** What the cooling-device scan concluded. */
export type FanDiscovery =
	| { kind: "found"; coolingDir: string }
	/** The thermal class named no `pwm-fan` cooling device — a real board shape. */
	| { kind: "absent" }
	/** The scan itself failed; nothing was proven either way. */
	| { kind: "unreadable" };

/**
 * Find the `pwm-fan` cooling device by its `type` string.
 *
 * NEVER by a `cooling_deviceN` index — see the module header. Entries are walked
 * in numeric order purely for determinism when a board somehow registers more
 * than one; the FIRST one typed `pwm-fan` wins, and the index it happens to
 * carry is never assumed or recorded.
 */
export async function discoverPwmFanCoolingDevice(
	deps: FanDeps,
	thermalDir: string = THERMAL_CLASS_DIR,
): Promise<FanDiscovery> {
	let entries: string[];
	try {
		entries = await deps.readDir(thermalDir);
	} catch (err) {
		if (isNotFound(err)) return { kind: "absent" };
		logger.debug("fan: thermal class unreadable", { err });
		return { kind: "unreadable" };
	}

	const candidates = entries
		.filter((name) => /^cooling_device\d+$/.test(name))
		.sort(byNumericSuffix);

	for (const name of candidates) {
		try {
			const type = (await deps.readText(`${thermalDir}/${name}/type`)).trim();
			if (type === PWM_FAN_TYPE)
				return { kind: "found", coolingDir: `${thermalDir}/${name}` };
		} catch (err) {
			// One unreadable `type` node degrades only that candidate.
			logger.debug("fan: cooling-device type unreadable", { name, err });
		}
	}
	return { kind: "absent" };
}

/**
 * Candidate `pwm1` paths for a discovered cooling device, in preference order.
 *
 * The cooling device's `device` symlink resolves to the platform device that
 * registered it (the `pwm-fan` node), and that device owns the hwmon exposing
 * `pwm1`. The hwmon's own index is read from the directory listing, never
 * assumed. The bare `device/pwm1` fallback covers a driver that exposes the
 * attribute directly on the platform device instead of under a hwmon child.
 */
export async function candidatePwmPaths(
	deps: FanDeps,
	coolingDir: string,
): Promise<string[]> {
	const hwmonRoot = `${coolingDir}/device/hwmon`;
	const paths: string[] = [];
	try {
		const entries = await deps.readDir(hwmonRoot);
		for (const name of entries
			.filter((entry) => /^hwmon\d+$/.test(entry))
			.sort(byNumericSuffix)) {
			paths.push(`${hwmonRoot}/${name}/pwm1`);
		}
	} catch (err) {
		logger.debug("fan: hwmon directory unreadable", { err });
	}
	paths.push(`${coolingDir}/device/pwm1`);
	return paths;
}

/**
 * Does this cooling device carry a `device` entry of its own?
 *
 * This is the gate on the hwmon-name fallback, and the distinction it draws is
 * load-bearing: a backlink that EXISTS but whose `pwm1` read failed is a read
 * failure under a link we already trust, so it must report `unknown` — starting
 * a class-wide scan there could adopt a DIFFERENT fan on a multi-fan board. Only
 * a backlink that is not there at all leaves the class hierarchy with no way to
 * answer, which is what the fallback exists for.
 *
 * A listing that fails is treated as "no usable link" — the fallback is still
 * gated on an already-confirmed `pwm-fan` cooling device, so it cannot invent one.
 */
export async function coolingDeviceHasDeviceLink(
	deps: FanDeps,
	coolingDir: string,
): Promise<boolean> {
	try {
		return (await deps.readDir(coolingDir)).includes("device");
	} catch (err) {
		logger.debug("fan: cooling device not listable", { coolingDir, err });
		return false;
	}
}

/** What the hwmon-name correlation concluded. */
export type HwmonCorrelation =
	| { kind: "found"; hwmonDir: string }
	| { kind: "none" }
	/** Several hwmons claim the name — which one this cdev meant is unknowable. */
	| { kind: "ambiguous"; matches: string[] };

/**
 * Correlate an already-confirmed `pwm-fan` cooling device to its hwmon by the
 * driver-authored `hwmon<N>/name` string, for the kernels where the cooling
 * device carries no backlink of its own.
 *
 * NEVER by a `hwmonN` index — the entries are walked purely to read each `name`.
 * More than one match is reported as `ambiguous` rather than resolved by order:
 * this correlates ONE cooling device to ONE hwmon, and with two candidates there
 * is no evidence saying which, so `unknown` is the honest answer.
 */
export async function correlatePwmFanHwmon(
	deps: FanDeps,
	hwmonClassDir: string = HWMON_CLASS_DIR,
): Promise<HwmonCorrelation> {
	let entries: string[];
	try {
		entries = await deps.readDir(hwmonClassDir);
	} catch (err) {
		logger.debug("fan: hwmon class unreadable", { err });
		return { kind: "none" };
	}

	const matches: string[] = [];
	for (const name of entries
		.filter((entry) => /^hwmon\d+$/.test(entry))
		.sort(byNumericSuffix)) {
		const hwmonDir = `${hwmonClassDir}/${name}`;
		try {
			if (
				(await deps.readText(`${hwmonDir}/name`)).trim() === PWM_FAN_HWMON_NAME
			) {
				matches.push(hwmonDir);
			}
		} catch (err) {
			logger.debug("fan: hwmon name unreadable", { hwmonDir, err });
		}
	}

	const only = matches[0];
	if (only === undefined) return { kind: "none" };
	if (matches.length > 1) return { kind: "ambiguous", matches };
	return { kind: "found", hwmonDir: only };
}

/**
 * Read the duty cycle of a discovered fan, or `null` when no candidate answered.
 * Each read is isolated so an unreadable candidate falls through to the next
 * rather than failing the tick.
 */
export async function readFanDuty(
	deps: FanDeps,
	coolingDir: string,
	hwmonClassDir: string = HWMON_CLASS_DIR,
): Promise<number | null> {
	for (const path of await candidatePwmPaths(deps, coolingDir)) {
		try {
			const duty = parsePwmDuty(await deps.readText(path));
			if (duty !== null) return duty;
		} catch (err) {
			logger.debug("fan: pwm1 unreadable", { path, err });
		}
	}

	if (await coolingDeviceHasDeviceLink(deps, coolingDir)) return null;

	const correlation = await correlatePwmFanHwmon(deps, hwmonClassDir);
	if (correlation.kind !== "found") {
		logger.debug("fan: no hwmon correlates to the pwm-fan cooling device", {
			coolingDir,
			correlation: correlation.kind,
		});
		return null;
	}
	try {
		return parsePwmDuty(await deps.readText(`${correlation.hwmonDir}/pwm1`));
	} catch (err) {
		logger.debug("fan: correlated pwm1 unreadable", {
			hwmonDir: correlation.hwmonDir,
			err,
		});
		return null;
	}
}

/**
 * Collect the fan reading. Never throws: a failure anywhere degrades to the
 * honest `unknown` floor rather than crashing the sampling loop.
 */
export async function collectFan(
	deps: FanDeps,
	thermalDir: string = THERMAL_CLASS_DIR,
	hwmonClassDir: string = HWMON_CLASS_DIR,
): Promise<FanReading> {
	try {
		const discovery = await discoverPwmFanCoolingDevice(deps, thermalDir);
		if (discovery.kind === "absent") return FAN_ABSENT;
		if (discovery.kind === "unreadable") return FAN_UNKNOWN;

		const duty = await readFanDuty(deps, discovery.coolingDir, hwmonClassDir);
		// A fan we can SEE but cannot MEASURE is an unknown duty, not an absent
		// fan and not a zero one.
		if (duty === null) return FAN_UNKNOWN;
		return fanReadingForDuty(duty);
	} catch (err) {
		logger.warn("fan: collector failed", { err });
		return FAN_UNKNOWN;
	}
}

// ─── production wiring ───────────────────────────────────────────────────────

export const defaultFanDeps: FanDeps = {
	readText: (path) => Bun.file(path).text(),
	// Directory ops stay on `node:fs/promises` — `Bun.file().exists()` is
	// file-only (see the backend Bun-native conventions).
	readDir: (path) => readdir(path),
};

let lastFan: FanReading = FAN_UNKNOWN;

/** The latest reading, for the post-auth initial-state push. */
export function getFan(): FanReading {
	return lastFan;
}

/**
 * Start the `fan` broadcast loop.
 *
 * Gated on `isRealDevice()` like every other privileged hardware path: a
 * dev/emulated host has no `pwm-fan` cooling device, so it publishes NOTHING
 * rather than a synthetic reading — and it must not publish `absent` either,
 * which would be a claim about hardware the host does not have. That silence IS
 * the real-vs-mock seam (same rule as `encoder-load`); the frontend renders
 * `unknown` for a broadcast that never arrives, and there is deliberately no
 * build-flag branch choosing between them.
 */
export async function initFan(deps: FanDeps = defaultFanDeps): Promise<void> {
	if (!(await isRealDevice())) {
		logger.debug("fan: emulated host — collector not started");
		return;
	}

	const tick = async () => {
		try {
			lastFan = await collectFan(deps);
			broadcastMsg(FAN_EVENT, lastFan, getms() - ACTIVE_TO);
		} catch (err) {
			logger.error("fan tick failed", { err });
		}
	};

	await tick();
	setInterval(() => void tick(), FAN_INTERVAL_MS);
}
