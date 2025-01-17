/*
    belaUI - web UI for the BELABOX project
    Copyright (C) 2020-2022 BELABOX project

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

import { pipelineGetAudioProps } from "./audio.ts";
import { setup } from "./setup.ts";
import { readTextFile, writeTextFile } from "./text-files.ts";

type Pipeline = {
	name: string;
	path: string;
	acodec?: unknown;
	asrc?: unknown;
};

let pipelines: Record<string, Pipeline> = {};

let belacoderPipelinesDir: string;
if (setup.belacoder_path) {
	belacoderPipelinesDir = `${setup.belacoder_path}/pipeline`;
} else {
	belacoderPipelinesDir = "/usr/share/belacoder/pipelines";
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
		console.log(`Failed to read the pipeline files in ${dir}:`);
		console.log(err);
	}

	return pipelines;
}

function getPipelines() {
	const ps: Record<string, Pipeline> = {};
	Object.assign(ps, readDirAbsPath(`${belacoderPipelinesDir}/custom/`));

	// Get the hardware-specific pipelines
	let excludePipelines: string | undefined;
	if (setup.hw === "rk3588" && !fs.existsSync("/dev/hdmirx")) {
		excludePipelines = "h265_hdmi";
	}
	Object.assign(
		ps,
		readDirAbsPath(`${belacoderPipelinesDir}/${setup.hw}/`, excludePipelines),
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

export function searchPipelines(id: string) {
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
