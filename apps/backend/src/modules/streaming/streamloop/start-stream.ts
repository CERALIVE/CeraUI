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

// Core stream launch: spawns srtla_send under the process-runner supervisor,
// wires srtla per-uplink telemetry, then starts the engine session over the
// StreamingBackend seam.

import {
	buildSrtlaSendArgs,
	controlSocketPath,
} from "@ceralive/srtla-send/sender";
import type { RuntimeConfig } from "../../../helpers/config-schemas.ts";
import { getConfig } from "../../config.ts";
import { setup } from "../../setup.ts";
import { notificationBroadcast } from "../../ui/notifications.ts";
import { asrcProbe } from "../audio.ts";
import { hasLowMtu } from "../bcrpt.ts";
import { getLastCapabilities } from "../capabilities.ts";
import { SRTLA_LISTEN_PORT } from "../constants.ts";
import { embeddedAudioActive } from "../embedded-audio.ts";
import { clearStreamProcessExit } from "../health.ts";
import { srtlaStatsFile, startLinkTelemetry } from "../link-telemetry.ts";
import type { Pipeline } from "../pipelines.ts";
import { getStreamingBackend } from "../streaming-engine.ts";
import { srtlaSendExec } from "./exec-paths.ts";
import { resolveProcessError } from "./process-error-patterns.ts";
import { spawnStreamingLoop } from "./process-runner.ts";

export interface AudioProbeDeps {
	probe?: (asrc: string) => Promise<string>;
	networkEmbeddedAudio?: boolean;
}

export async function maybeProbeAudioSource(
	pipeline: Pipeline,
	config: RuntimeConfig,
	deps: AudioProbeDeps = {},
): Promise<boolean> {
	if (!pipeline.supportsAudio || !config.asrc) return true;
	const networkEmbeddedAudio =
		deps.networkEmbeddedAudio ?? getLastCapabilities()?.network_embedded_audio;
	if (embeddedAudioActive(pipeline.audio_kind, networkEmbeddedAudio)) {
		return true;
	}
	const probe = deps.probe ?? asrcProbe;
	try {
		await probe(config.asrc);
		return true;
	} catch (_err) {
		// asrcProbe rejects when the operator stops the stream before the audio
		// interface is found; the stream is already stopped, so signal abort.
		return false;
	}
}

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

	if (!(await maybeProbeAudioSource(pipeline, config))) return;
	const statsFile = srtlaStatsFile();
	// ADR-001 control socket: telemetry rides the JSON-RPC subscription when the
	// sender advertises it, with --stats-file as the airtight fallback poll.
	const controlSocket = controlSocketPath(SRTLA_LISTEN_PORT);
	spawnStreamingLoop(
		srtlaSendExec,
		buildSrtlaSendArgs({
			listenPort: SRTLA_LISTEN_PORT,
			srtlaHost: srtlaAddr,
			srtlaPort,
			ipsFile: setup.ips_file,
			statsFile,
			controlSocket,
			execPath: setup.srtla_path,
		}),
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
	startLinkTelemetry(statsFile, ipsContent.split("\n"), { controlSocket });

	// Engine launch (session start over structured IPC) is behind the seam.
	getStreamingBackend().start(config, {
		pipeline: pipeline.source,
		host: "127.0.0.1",
		port: SRTLA_LISTEN_PORT,
		streamid,
		reducedPacketSize: hasLowMtu(),
	});
}
