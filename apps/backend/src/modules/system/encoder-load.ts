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
 * Per-core VEPU580 encoder load — a privileged read with TWO kernel realities.
 *
 * The RK3588 has two independent encoder cores, and the two kernels CeraLive
 * ships report their load in fundamentally different ways. BOTH were re-verified
 * live on the bench board, not assumed:
 *
 *   vendor 6.1 BSP     `/proc/mpp_service/load` — a REAL per-core percentage,
 *                      but ONLY after `load_interval` has been armed (the driver
 *                      itself answers "please set load_interval first!!!").
 *   mainline/edge 7.1  no `/proc/mpp_service` directory at all. The encoder
 *                      cores' clock ENABLE STATE (`clk_enable_count`) is the
 *                      only signal, and it is a coarse busy/idle bit.
 *
 * Which one is live is DETECTED, never inferred from `uname` or a board id — a
 * device can be moved between the two kernels by swapping boot media, so the
 * only honest question is which interface actually answers right now. The probe
 * order is richest-first, and a reality only wins when it produces at least one
 * usable core reading.
 *
 * THE INVARIANT THIS MODULE EXISTS TO PROTECT: a `clk_enable_count` is never
 * turned into a percentage. It is a reference count, not a magnitude — the
 * measured 2-and-1 under four concurrent sessions does not mean "core 0 is twice
 * as busy". There is deliberately no code path here from an enable count to a
 * number, and a unit test pins that absence.
 *
 * Privilege: both reads are root-only, and this backend runs as root
 * (`deployment/ceralive.service` `User=root`) — the same privileged class as the
 * `sensors.ts` `/sys/class/thermal` read, using the same plain `Bun.file()`
 * seam. No escalation helper is introduced.
 *
 * Degradation follows `sensors.ts`/`device-stats.ts`: every read is wrapped in
 * its own try/catch and an unreadable interface yields the honest unavailable
 * floor rather than a thrown tick.
 */

import type { EncoderCoreReading, EncoderLoad } from "@ceraui/rpc";

import { logger } from "../../helpers/logger.ts";
import { ACTIVE_TO } from "../../helpers/shared.ts";
import { getms } from "../../helpers/time.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import { isRealDevice } from "./device-detection.ts";

/**
 * Broadcast channel name. Declared here (and re-exported from `rpc/events.ts`)
 * so consumers resolve it from the emitter, exactly like `ADDON_EVENT`.
 */
export const ENCODER_LOAD_EVENT = "encoder-load" as const;

/** Broadcast cadence for the `encoder-load` event. */
export const ENCODER_LOAD_INTERVAL_MS = 2000;

/**
 * Canonical core ids, in hardware order — the exact ids
 * `apps/frontend/src/lib/streaming/encoder-load.ts` declares.
 */
export const ENCODER_CORE_IDS = ["rkvenc0", "rkvenc1"] as const;
export type EncoderCoreId = (typeof ENCODER_CORE_IDS)[number];

/**
 * Decoder core ids are DERIVED from how many rows the device actually printed,
 * not declared from a fixed list like the encoders above. The encoder count is
 * a fixed property of the SoC the UI already draws two slots for; the decoder
 * rows are whatever `/proc/mpp_service/load` happens to carry on this board, so
 * inventing absent slots would claim decoders the file never mentioned.
 */
const DECODER_CORE_ID_PREFIX = "rkvdec";

const MPP_LOAD_PATH = "/proc/mpp_service/load";
const MPP_LOAD_INTERVAL_PATH = "/proc/mpp_service/load_interval";

/**
 * The sampling window the vendor driver averages its duty cycle over. 1000 ms is
 * the value the driver's own documentation uses and the one the measurements in
 * `encoder-load.ts`'s table were taken at.
 */
const MPP_LOAD_INTERVAL_MS = 1000;

const CLK_ENABLE_COUNT_PATHS: Readonly<Record<EncoderCoreId, string>> = {
	rkvenc0: "/sys/kernel/debug/clk/clk_rkvenc0_core/clk_enable_count",
	rkvenc1: "/sys/kernel/debug/clk/clk_rkvenc1_core/clk_enable_count",
};

/** The honest floor: nothing is readable, so nothing is claimed. */
export const ENCODER_LOAD_UNAVAILABLE: EncoderLoad = {
	source: null,
	cores: [],
	updatedAt: null,
	simulated: false,
};

/** Injected I/O surface — replaced wholesale in tests. */
export type EncoderLoadDeps = {
	readText: (path: string) => Promise<string>;
	writeText: (path: string, contents: string) => Promise<void>;
	now: () => number;
};

/** Cross-tick state: whether `load_interval` has already been armed. */
export type EncoderLoadState = { mppIntervalArmed: boolean };

export function createEncoderLoadState(): EncoderLoadState {
	return { mppIntervalArmed: false };
}

// ─── pure parsers (exported for tests) ──────────────────────────────────────

/**
 * Parse a duty-cycle percentage. Anything non-finite or outside `[0, 100]` is
 * REFUSED rather than clamped — an out-of-range figure means the parse was
 * wrong, and a clamped wrong figure still reads as a measurement. This mirrors
 * `parseLoadPercent` in the frontend contract module byte for byte.
 */
export function parseLoadPercent(raw: string): number | null {
	const n = Number.parseFloat(raw);
	if (!Number.isFinite(n)) return null;
	if (n < 0 || n > 100) return null;
	return n;
}

/** Parse a `clk_enable_count`. A negative or unparseable count is refused. */
export function parseEnableCount(raw: string): number | null {
	const n = Number.parseInt(raw.trim(), 10);
	if (!Number.isFinite(n) || n < 0) return null;
	return n;
}

/** `fdbd0000.rkvenc-core` — the encoder blocks, and nothing else in the file. */
const MPP_ENCODE_ROW =
	/^\s*([0-9a-f]+)\.rkvenc-core\b.*?\bload:\s*([0-9.]+)\s*%/i;

/**
 * `fdc38100.rkvdec-core` — the RKVDEC blocks. Deliberately tolerant of a
 * trailing suffix (`rkvdec-core0`, which some vendor trees print) but NOT of
 * `vdpu`/`vpu`: those are the legacy decoders, a different block with different
 * accounting, and folding them in would silently mix two hardware units under
 * one number.
 */
const MPP_DECODE_ROW =
	/^\s*([0-9a-f]+)\.rkvdec[\w-]*\b.*?\bload:\s*([0-9.]+)\s*%/i;

function parseMppLoadRows(text: string, pattern: RegExp): (number | null)[] {
	const rows: { address: string; percent: number | null }[] = [];
	for (const line of text.split("\n")) {
		const match = line.match(pattern);
		if (!match) continue;
		const address = match[1];
		const raw = match[2];
		if (address === undefined || raw === undefined) continue;
		rows.push({
			address: address.toLowerCase(),
			percent: parseLoadPercent(raw),
		});
	}
	rows.sort((a, b) => a.address.localeCompare(b.address));
	return rows.map((row) => row.percent);
}

/**
 * Pull the encoder-core rows out of `/proc/mpp_service/load`, which reports one
 * line per hardware block:
 *
 *   fdbd0000.rkvenc-core      load:  11.34% utilization:  11.08%
 *   fdbe0000.rkvenc-core      load:   0.00% utilization:   0.00%
 *   fdb50400.vdpu-core        load:   0.00% utilization:   0.00%
 *
 * Only `rkvenc-core` rows are encoder cores; every other block (decoders, the
 * JPEG unit, RGA) shares the file and must be ignored.
 *
 * Ordering is taken from the block's own base ADDRESS, ascending, rather than
 * from a hardcoded address table or from file order: the addresses are the SoC's
 * memory map, so ascending address IS hardware order (`fdbd0000` = core 0,
 * `fdbe0000` = core 1 on RK3588), and deriving it keeps the parser from
 * depending on a specific board's addresses or on the driver's print order.
 */
export function parseMppLoad(text: string): (number | null)[] {
	return parseMppLoadRows(text, MPP_ENCODE_ROW);
}

/**
 * Pull the DECODER-core rows out of the same file, by the same
 * address-ascending rule:
 *
 *   fdc38100.rkvdec-core      load:  23.10% utilization:  22.87%
 *   fdc40100.rkvdec-core      load:   6.75% utilization:   6.51%
 *
 * Separate from `parseMppLoad` rather than a second return value, so the
 * existing encoder callers are untouched.
 */
export function parseMppDecodeLoad(text: string): (number | null)[] {
	return parseMppLoadRows(text, MPP_DECODE_ROW);
}

/**
 * Shape decoder percentages into the SAME three-state reading the encoder cores
 * use, so a consumer renders both with one code path. A refused percentage keeps
 * its slot as `unavailable` — dropping it would renumber every decoder after it.
 */
export function decodeCoreReadings(
	percents: readonly (number | null)[],
): EncoderCoreReading[] {
	return percents.map((percent, index) => {
		const core = `${DECODER_CORE_ID_PREFIX}${index}`;
		return percent === null
			? { core, kind: "unavailable" }
			: { core, kind: "percent", percent };
	});
}

/** Does this reading say anything at all about at least one core? */
export function hasUsableCore(cores: readonly EncoderCoreReading[]): boolean {
	return cores.some((core) => core.kind !== "unavailable");
}

// ─── per-reality collectors ─────────────────────────────────────────────────

/**
 * Arm the vendor driver's load accounting, ONCE and idempotently.
 *
 * The driver reports nothing until `load_interval` is non-zero, so this must
 * happen before the first read — but it is a WRITE into `/proc`, so it is only
 * performed when the current value proves accounting is off. An already-armed
 * device (another consumer, or an earlier boot of this process) is left exactly
 * as found.
 */
async function armMppLoadInterval(
	deps: EncoderLoadDeps,
	state: EncoderLoadState,
): Promise<void> {
	if (state.mppIntervalArmed) return;
	let current: number | null = null;
	try {
		current = parseEnableCount(await deps.readText(MPP_LOAD_INTERVAL_PATH));
	} catch (err) {
		logger.debug("encoder-load: load_interval unreadable", { err });
		return;
	}
	if (current !== null && current > 0) {
		state.mppIntervalArmed = true;
		return;
	}
	try {
		await deps.writeText(MPP_LOAD_INTERVAL_PATH, `${MPP_LOAD_INTERVAL_MS}`);
		state.mppIntervalArmed = true;
		logger.info("encoder-load: armed mpp_service load accounting", {
			intervalMs: MPP_LOAD_INTERVAL_MS,
		});
	} catch (err) {
		logger.debug("encoder-load: could not arm load_interval", { err });
	}
}

async function collectFromMppService(
	deps: EncoderLoadDeps,
	state: EncoderLoadState,
): Promise<EncoderLoad | null> {
	await armMppLoadInterval(deps, state);

	let text: string;
	try {
		text = await deps.readText(MPP_LOAD_PATH);
	} catch {
		return null;
	}

	const percents = parseMppLoad(text);
	const cores: EncoderCoreReading[] = ENCODER_CORE_IDS.map((core, index) => {
		const percent = percents[index];
		return percent === undefined || percent === null
			? { core, kind: "unavailable" }
			: { core, kind: "percent", percent };
	});
	if (!hasUsableCore(cores)) return null;

	// Decode rows are reported only when the file actually carries them, and
	// they never participate in `hasUsableCore` above: whether this kernel
	// reality wins is an ENCODER question, and a board that prints decoder rows
	// but no readable encoder row is still an uninstrumented encoder.
	const decodeCores = decodeCoreReadings(parseMppDecodeLoad(text));

	return {
		source: "mpp-service",
		cores,
		...(decodeCores.length > 0 ? { decodeCores } : {}),
		updatedAt: deps.now(),
		simulated: false,
	};
}

async function collectFromClkEnableCount(
	deps: EncoderLoadDeps,
): Promise<EncoderLoad | null> {
	const cores: EncoderCoreReading[] = [];
	for (const core of ENCODER_CORE_IDS) {
		let count: number | null = null;
		try {
			count = parseEnableCount(
				await deps.readText(CLK_ENABLE_COUNT_PATHS[core]),
			);
		} catch {
			count = null;
		}
		// A positive count means this core's clock is ENABLED. That is the ONLY
		// thing this interface can say, so the reading is a boolean — mapping the
		// count itself to a number would invent a scale the driver never produced.
		cores.push(
			count === null
				? { core, kind: "unavailable" }
				: { core, kind: "active", active: count > 0 },
		);
	}
	if (!hasUsableCore(cores)) return null;
	// No `decodeCores` here, ever. Mainline has no `/proc/mpp_service` and no
	// clock-count analogue for RKVDEC, so the only future source on this kernel
	// is per-fd `drm` accounting (`/proc/<pid>/fdinfo`), which needs the sibling
	// plan's kernel work plus an edge image before it exists to read. Until then
	// this path stays SILENT about decode rather than emitting an empty array a
	// consumer would draw as "decoders measured at nothing".
	return {
		source: "clk-enable-count",
		cores,
		updatedAt: deps.now(),
		simulated: false,
	};
}

/**
 * Probe both realities, richest first, and report the honest floor when neither
 * answers. A reality only wins when it produced a usable core reading, so a
 * vendor `load` file that exists but parses to nothing still falls through to
 * the busy/idle bit rather than reporting an instrumented-but-empty device.
 */
export async function collectEncoderLoad(
	deps: EncoderLoadDeps,
	state: EncoderLoadState,
): Promise<EncoderLoad> {
	try {
		const mpp = await collectFromMppService(deps, state);
		if (mpp) return mpp;
		const clk = await collectFromClkEnableCount(deps);
		if (clk) return clk;
	} catch (err) {
		logger.warn("encoder-load: collector failed", { err });
	}
	return ENCODER_LOAD_UNAVAILABLE;
}

// ─── production wiring ───────────────────────────────────────────────────────

export const defaultEncoderLoadDeps: EncoderLoadDeps = {
	readText: (path) => Bun.file(path).text(),
	writeText: async (path, contents) => {
		await Bun.write(path, contents);
	},
	now: () => Date.now(),
};

const encoderLoadState = createEncoderLoadState();
let lastEncoderLoad: EncoderLoad = ENCODER_LOAD_UNAVAILABLE;

/** The latest reading, for the post-auth initial-state push. */
export function getEncoderLoad(): EncoderLoad {
	return lastEncoderLoad;
}

/**
 * Start the `encoder-load` broadcast loop.
 *
 * Gated on `isRealDevice()` like every other privileged hardware path: a
 * dev/emulated host has no VEPU580, so it publishes NOTHING rather than a
 * synthetic reading. That silence is what keeps the frontend's dev-only
 * `?health-mock=` fixture the single mocking mechanism for this signal — a
 * second one on the backend would be a parallel mechanism, not the established
 * one.
 */
export async function initEncoderLoad(
	deps: EncoderLoadDeps = defaultEncoderLoadDeps,
): Promise<void> {
	if (!(await isRealDevice())) {
		logger.debug("encoder-load: emulated host — collector not started");
		return;
	}

	const tick = async () => {
		try {
			lastEncoderLoad = await collectEncoderLoad(deps, encoderLoadState);
			broadcastMsg(ENCODER_LOAD_EVENT, lastEncoderLoad, getms() - ACTIVE_TO);
		} catch (err) {
			logger.error("encoder-load tick failed", { err });
		}
	};

	await tick();
	setInterval(() => void tick(), ENCODER_LOAD_INTERVAL_MS);
}
