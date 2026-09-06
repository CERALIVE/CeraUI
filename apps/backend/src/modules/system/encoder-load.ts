/*
 * CeraUI - web UI for the CERALIVE project
 * Copyright (C) 2024-2026 CeraLive project
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type {
	EncoderCoreReading,
	EncoderLoad,
	MediaBlockLoad,
	MediaCoreLoad,
	MppBlock,
} from "@ceraui/rpc";
import { logger } from "../../helpers/logger.ts";
import { ACTIVE_TO } from "../../helpers/shared.ts";
import { getms } from "../../helpers/time.ts";
import { broadcastMsg } from "../ui/websocket-server.ts";
import { isRealDevice } from "./device-detection.ts";
import {
	legacyCoreReadings,
	mppBlockForDevice,
	parseLoadPercent,
	parseMppLoadRows,
	parseMppSessions,
	parseRgaLoad,
} from "./encoder-load-proc.ts";

export {
	decodeCoreReadings,
	parseLoadPercent,
	parseMppDecodeLoad,
	parseMppLoad,
} from "./encoder-load-proc.ts";

export const ENCODER_LOAD_EVENT = "encoder-load" as const;
export const ENCODER_LOAD_INTERVAL_MS = 2000;
const MPP_LOAD_PATH = "/proc/mpp_service/load";
const MPP_LOAD_INTERVAL_PATH = "/proc/mpp_service/load_interval";
const MPP_SESSIONS_PATH = "/proc/mpp_service/sessions-summary";
const RGA_LOAD_PATH = "/proc/rkrga/load";
const MPP_LOAD_INTERVAL_MS = 1000;

// data-debt-id="TD-encoder-load-clock-fallback"
const CLK_ENABLE_COUNT_PATHS = {
	rkvenc0: "/sys/kernel/debug/clk/clk_rkvenc0_core/clk_enable_count",
	rkvenc1: "/sys/kernel/debug/clk/clk_rkvenc1_core/clk_enable_count",
} as const;

export const ENCODER_LOAD_UNAVAILABLE: EncoderLoad = {
	source: null,
	cores: [],
	updatedAt: null,
	simulated: false,
};

export type EncoderLoadDeps = {
	readText: (path: string) => Promise<string>;
	writeText: (path: string, contents: string) => Promise<void>;
	now: () => number;
};

export type EncoderLoadState = { mppIntervalArmed: boolean };

export function createEncoderLoadState(): EncoderLoadState {
	return { mppIntervalArmed: false };
}

export function parseEnableCount(raw: string): number | null {
	const n = Number.parseInt(raw.trim(), 10);
	if (!Number.isFinite(n) || n < 0) return null;
	return n;
}

export function hasUsableCore(cores: readonly EncoderCoreReading[]): boolean {
	return cores.some((core) => core.kind !== "unavailable");
}

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

async function readOptionalText(
	deps: EncoderLoadDeps,
	path: string,
): Promise<string | null> {
	try {
		return await deps.readText(path);
	} catch (err) {
		logger.debug("encoder-load: telemetry unreadable", { path, err });
		return null;
	}
}

async function collectMppBlocks(
	deps: EncoderLoadDeps,
	state: EncoderLoadState,
): Promise<MediaBlockLoad[]> {
	await armMppLoadInterval(deps, state);
	const text = await readOptionalText(deps, MPP_LOAD_PATH);
	if (text === null) return [];
	const rows = parseMppLoadRows(text);
	if (rows.length === 0) return [];
	const summary = await readOptionalText(deps, MPP_SESSIONS_PATH);
	const owners = summary === null ? null : parseMppSessions(summary);
	const groups = new Map<MppBlock, MediaCoreLoad[]>();
	for (const row of rows) {
		const namedBlock = mppBlockForDevice(row.core);
		const compatible =
			namedBlock === null
				? await readOptionalText(
						deps,
						`/sys/bus/platform/devices/${row.core}/of_node/compatible`,
					)
				: null;
		const block = namedBlock ?? mppBlockForDevice(row.core, compatible ?? "");
		if (block === null) continue;
		const cores = groups.get(block) ?? [];
		cores.push({
			...row,
			sessions: owners === null ? null : (owners.get(row.core) ?? []),
		});
		groups.set(block, cores);
	}
	return (["rkvenc", "rkvdec", "jpgdec"] as const).flatMap((block) => {
		const cores = groups.get(block);
		return cores ? [{ source: "mpp-service" as const, block, cores }] : [];
	});
}

function legacyMppReading(
	blocks: readonly MediaBlockLoad[],
	now: number,
): EncoderLoad | null {
	const coresFor = (block: MppBlock) =>
		legacyCoreReadings(
			(blocks.find((entry) => entry.block === block)?.cores ?? []).map((row) =>
				row.load === null ? null : parseLoadPercent(String(row.load)),
			),
			block,
		);
	const cores = coresFor("rkvenc");
	if (!hasUsableCore(cores)) return null;
	const decodeCores = coresFor("rkvdec");
	return {
		source: "mpp-service",
		cores,
		...(decodeCores.length > 0 ? { decodeCores } : {}),
		updatedAt: now,
		simulated: false,
	};
}

async function collectFromClkEnableCount(
	deps: EncoderLoadDeps,
): Promise<EncoderLoad | null> {
	const cores: EncoderCoreReading[] = [];
	for (const [core, path] of Object.entries(CLK_ENABLE_COUNT_PATHS)) {
		let count: number | null = null;
		try {
			count = parseEnableCount(await deps.readText(path));
		} catch {
			count = null;
		}
		// A clock reference count has no percentage denominator.
		cores.push(
			count === null
				? { core, kind: "unavailable" }
				: { core, kind: "active", active: count > 0 },
		);
	}
	if (!hasUsableCore(cores)) return null;
	return {
		source: "clk-enable-count",
		cores,
		updatedAt: deps.now(),
		simulated: false,
	};
}

export async function collectEncoderLoad(
	deps: EncoderLoadDeps,
	state: EncoderLoadState,
): Promise<EncoderLoad> {
	try {
		const blocks = await collectMppBlocks(deps, state);
		const rgaText = await readOptionalText(deps, RGA_LOAD_PATH);
		const rgaCores = rgaText === null ? [] : parseRgaLoad(rgaText);
		if (rgaCores.length > 0)
			blocks.push({ source: "rkrga", block: "rga", cores: rgaCores });
		const legacy =
			legacyMppReading(blocks, deps.now()) ??
			(await collectFromClkEnableCount(deps)) ??
			ENCODER_LOAD_UNAVAILABLE;
		return blocks.length > 0
			? { ...legacy, blocks, updatedAt: deps.now() }
			: legacy;
	} catch (err) {
		logger.warn("encoder-load: collector failed", { err });
		return ENCODER_LOAD_UNAVAILABLE;
	}
}

export const defaultEncoderLoadDeps: EncoderLoadDeps = {
	readText: (path) => Bun.file(path).text(),
	writeText: async (path, contents) => {
		await Bun.write(path, contents);
	},
	now: () => Date.now(),
};

const encoderLoadState = createEncoderLoadState();
let lastEncoderLoad: EncoderLoad = ENCODER_LOAD_UNAVAILABLE;

export function getEncoderLoad(): EncoderLoad {
	return lastEncoderLoad;
}

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
