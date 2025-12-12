/*
    CeraUI - web UI for the CERALIVE project
    Copyright (C) 2024-2025 CeraLive project
    

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

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { logger } from "../../helpers/logger.ts";
import { readTextFile, writeTextFile } from "../../helpers/text-files.ts";

import { setup } from "../setup.ts";
import { pipelineGetAudioProps } from "./audio.ts";

export type Pipeline = {
	name: string;
	path: string;
	acodec?: unknown;
	asrc?: unknown;
};

// Valid hardware types for mock mode
export const VALID_HARDWARE_TYPES = ["jetson", "n100", "rk3588"] as const;
export type HardwareType = (typeof VALID_HARDWARE_TYPES)[number];

let pipelines: Record<string, Pipeline> = {};

// Dev-only mock hardware override (defaults to null, using setup.hw)
let mockHardwareOverride: HardwareType | null = null;

const belacoderPipelinesDir: string = setup.belacoder_path
	? `${setup.belacoder_path}/pipeline`
	: "/usr/share/belacoder/pipelines";

/**
 * Get the effective hardware type (mock override or setup.hw)
 */
export function getEffectiveHardware(): string {
	return mockHardwareOverride ?? setup.hw;
}

/**
 * Set mock hardware override (dev-only)
 * Returns true if valid, false if invalid
 */
export function setMockHardware(hw: string): boolean {
	if (!VALID_HARDWARE_TYPES.includes(hw as HardwareType)) {
		logger.warn(`Invalid mock hardware type: ${hw}`);
		return false;
	}
	mockHardwareOverride = hw as HardwareType;
	logger.info(`🔧 Mock hardware set to: ${hw}`);
	return true;
}

/**
 * Get current mock hardware override (null if using default)
 */
export function getMockHardware(): HardwareType | null {
	return mockHardwareOverride;
}

/* Read the list of pipeline files */
function readDirAbsPath(dir: string, excludePattern?: string) {
	const pipelines: Record<string, Pipeline> = {};

	try {
		const files = fs.readdirSync(dir);
		const basename = path.basename(dir);

		for (const f in files) {
			const name = `${basename}/${files[f]}`;
			if (excludePattern && name.match(excludePattern)) continue;

			const id = crypto.createHash("sha1").update(name).digest("hex");
			const path = dir + files[f];
			pipelines[id] = { name: name, path: path };
		}
	} catch (err) {
		logger.error(`Failed to read the pipeline files in ${dir}:`);
		logger.error(err);
	}

	return pipelines;
}

function getPipelines() {
	const ps: Record<string, Pipeline> = {};
	Object.assign(ps, readDirAbsPath(`${belacoderPipelinesDir}/custom/`));

	// Get the hardware-specific pipelines (use mock override if set)
	const effectiveHw = getEffectiveHardware();
	let excludePipelines: string | undefined;
	if (effectiveHw === "rk3588" && !fs.existsSync("/dev/hdmirx")) {
		excludePipelines = "h265_hdmi";
	}
	Object.assign(
		ps,
		readDirAbsPath(
			`${belacoderPipelinesDir}/${effectiveHw}/`,
			excludePipelines,
		),
	);

	Object.assign(ps, readDirAbsPath(`${belacoderPipelinesDir}/generic/`));

	for (const p in ps) {
		const pipeline = ps[p];
		if (!pipeline) continue;

		const props = pipelineGetAudioProps(pipeline.path);
		Object.assign(pipeline, props);
	}

	return ps;
}

export function initPipelines() {
	pipelines = getPipelines();
}

export function searchPipelines(id: string): Pipeline | null {
	if (pipelines[id]) return pipelines[id];
	return null;
}

// pipeline list in the format needed by the frontend
type PipelineResponseEntry = Pick<Pipeline, "name" | "asrc" | "acodec">;

export function getPipelineList() {
	const list: Record<string, PipelineResponseEntry> = {};
	for (const id in pipelines) {
		const pipeline = pipelines[id];
		if (!pipeline) continue;

		list[id] = {
			name: pipeline.name,
			asrc: pipeline.asrc,
			acodec: pipeline.acodec,
		};
	}
	return list;
}

export async function removeBitrateOverlay(pipelineFile: string) {
	let pipeline = await readTextFile(pipelineFile);
	if (!pipeline) return;

	pipeline = pipeline.replace(/textoverlay[^!]*name=overlay[^!]*!/g, "");
	const pipelineTmp = "/tmp/belacoder_pipeline";
	if (!(await writeTextFile(pipelineTmp, pipeline))) return;

	return pipelineTmp;
}
