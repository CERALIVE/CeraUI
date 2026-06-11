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

// Core stream launch: builds the srtla_send + ceracoder argument vectors, spawns
// both under the process-runner supervisor, and wires srtla per-uplink telemetry.

import type { PipelineOverrides } from "@ceralive/ceracoder";
import { buildSrtlaSendArgs } from "@ceralive/srtla/sender";
import { getConfig } from "../../config.ts";
import { setup } from "../../setup.ts";
import { notificationBroadcast } from "../../ui/notifications.ts";
import { asrcProbe, getAudioSrcId } from "../audio.ts";
import { hasLowMtu } from "../bcrpt.ts";
import { SRTLA_LISTEN_PORT } from "../constants.ts";
import { clearStreamProcessExit } from "../health.ts";
import { srtlaStatsFile, startLinkTelemetry } from "../link-telemetry.ts";
import {
	gatePipelineOverrides,
	generatePipelineFile,
	type Pipeline,
} from "../pipelines.ts";
import { getStreamingBackend } from "../streaming-engine.ts";
import { srtlaSendExec } from "./exec-paths.ts";
import { resolveProcessError } from "./process-error-patterns.ts";
import { spawnStreamingLoop } from "./process-runner.ts";

export async function startStream(
	pipeline: Pipeline,
	srtlaAddr: string,
	srtlaPort: number,
	streamid: string,
) {
	const config = getConfig();
	getStreamingBackend().setBitrate(config);

	// A fresh stream start clears any prior unexpected-exit health flag so the
	// health rollup tracks this new session (ADR-0005 observe-and-notify).
	clearStreamProcessExit();

	const overrides: PipelineOverrides = {
		bitrateOverlay: config.bitrate_overlay,
		audioCodec: config.acodec as "aac" | "opus" | undefined,
		audioDevice: config.asrc ? getAudioSrcId(config.asrc) : undefined,
		volume: 1.0,
		...gatePipelineOverrides(pipeline, {
			resolution: config.resolution,
			framerate: config.framerate,
		}),
	};

	const pipelineFile = generatePipelineFile(pipeline, overrides);

	if (pipeline.supportsAudio && config.asrc) {
		try {
			await asrcProbe(config.asrc);
		} catch (_err) {
			/* asrcProbe will reject if the user presses Stop before the audio interface is found
               at this point, the stream is already stopped, so we don't need to do anything here */
			return;
		}
	}
	const statsFile = srtlaStatsFile();
	spawnStreamingLoop(
		srtlaSendExec,
		buildSrtlaSendArgs({
			listenPort: SRTLA_LISTEN_PORT,
			srtlaHost: srtlaAddr,
			srtlaPort,
			ipsFile: setup.ips_file,
			statsFile,
			execPath: setup.srtla_path,
		}).args,
		(err) => {
			const resolved = resolveProcessError("srtla", err);
			if (resolved) {
				notificationBroadcast(
					"srtla",
					"error",
					resolved.message,
					5,
					true,
					false,
				);
			}
		},
	);

	// Begin ingesting srtla_send's per-uplink telemetry. Seed the conn_id->iface
	// registry from the exact file srtla_send reads at spawn so tlm_id (file
	// order) maps back to interface names.
	const ipsContent = await Bun.file(setup.ips_file)
		.text()
		.catch(() => "");
	startLinkTelemetry(statsFile, ipsContent.split("\n"));

	// Engine launch (argv build + spawn + stderr classification) is behind the seam.
	getStreamingBackend().start(config, {
		pipelineFile,
		host: "127.0.0.1",
		port: SRTLA_LISTEN_PORT,
		streamid,
		reducedPacketSize: hasLowMtu(),
		fullOverride: true, // full override for start streaming
	});
}
