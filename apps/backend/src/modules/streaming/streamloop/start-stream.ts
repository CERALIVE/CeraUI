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
import { AUDIO_SOURCE_AUTO, type StartFailureClass } from "@ceraui/rpc/schemas";
import type { RuntimeConfig } from "../../../helpers/config-schemas.ts";
import { logger } from "../../../helpers/logger.ts";
import { getConfig } from "../../config.ts";
import { setup } from "../../setup.ts";
import { notificationBroadcast } from "../../ui/notifications.ts";
import {
	resetActiveEncodeLiveness,
	resetActivePassthrough,
} from "../active-passthrough.ts";
import { asrcProbe, isPseudoAudioSource } from "../audio.ts";
import {
	buildAutoLaunchConfig,
	resolveAutoAsrcFromLiveState,
	setResolvedAsrcFromStart,
} from "../auto-audio.ts";
import {
	defaultBindMapSpawnDeps,
	resolveBindMapArgs,
} from "../bind-map-spawn.ts";
import { getLastCapabilities } from "../capabilities.ts";
import { SRTLA_LISTEN_PORT } from "../constants.ts";
import { embeddedAudioActive } from "../embedded-audio.ts";
import { clearStreamProcessExit } from "../health.ts";
import { createLaunchTransaction } from "../launch-transaction.ts";
import {
	srtlaStatsFile,
	startLinkTelemetry,
	stopLinkTelemetry,
} from "../link-telemetry.ts";
import type { Pipeline } from "../pipelines.ts";
import { replayPreviewEncodeMode } from "../preview-encode-replay.ts";
import { getLastPublishedBond } from "../srtla.ts";
import { getStreamingBackend } from "../streaming-engine.ts";
import { srtlaSendExec } from "./exec-paths.ts";
import { resolveProcessError } from "./process-error-patterns.ts";
import { spawnStreamingLoop, stopProcessAndWait } from "./process-runner.ts";

export interface AudioProbeDeps {
	probe?: (asrc: string) => Promise<string>;
	networkEmbeddedAudio?: boolean;
}

export const AUDIO_SOURCE_PROBE_FAILED = "audio_source_probe_failed";
export const IP_LIST_READ_FAILED = "ip_list_read_failed";
export const PREVIEW_ENCODE_REPLAY_FAILED = "preview_encode_replay_failed";

export type StartStreamResult =
	| { success: true }
	| {
			success: false;
			error: string;
			reason: string;
			/**
			 * `connect` is reachable from the preview-encode fence alone: it is the
			 * only gate here that actually dials the engine, and it does so before
			 * any start is accepted — which is precisely the phase's meaning, and
			 * what makes a mid-restart engine a retriable boot race rather than a
			 * hard refusal.
			 */
			phase: "params" | "connect" | "spawn-sender";
			/**
			 * Set when this site already knows the taxonomy class. The launch
			 * wrappers use it verbatim instead of re-deriving a class from the
			 * opaque `error` string.
			 */
			failureClass?: StartFailureClass;
	  };

export async function maybeProbeAudioSource(
	pipeline: Pipeline,
	config: RuntimeConfig,
	deps: AudioProbeDeps = {},
): Promise<boolean> {
	if (!pipeline.supportsAudio || !config.asrc) return true;
	// A pipeline pseudo-source is not a device — never probe (nor probe-fail) it.
	if (isPseudoAudioSource(config.asrc)) return true;
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

// "Auto" resolves to a concrete card here, at launch, and NEVER touches the
// persisted config: the resolved key rides a launch-only shallow copy while
// config.json keeps the "Auto" sentinel. A pseudo resolution (embedded / pipeline
// default) omits asrc so the probe is skipped and the engine takes its own path.
function resolveLaunchConfig(config: RuntimeConfig): RuntimeConfig {
	if (config.asrc !== AUDIO_SOURCE_AUTO) return config;
	const resolution = resolveAutoAsrcFromLiveState();
	setResolvedAsrcFromStart(
		resolution.asrcKey,
		resolution.reason,
		resolution.candidates,
	);
	return buildAutoLaunchConfig(config, resolution);
}

/**
 * `configOverride` exists for ONE caller: the engine-death restoration, which
 * must relaunch the configuration the engine was actually RUNNING. `config.json`
 * is not that — a save with no `apply_now` persists a restart-requiring field
 * while the live session keeps encoding the previous one, so restoring from disk
 * would apply an edit the operator deferred to their next start. Absent (every
 * other caller), the live config is read exactly as before.
 */
export async function startStream(
	pipeline: Pipeline,
	srtlaAddr: string,
	srtlaPort: number,
	streamid: string,
	audioDeps: AudioProbeDeps = {},
	attemptId = "legacy-start",
	configOverride?: Partial<RuntimeConfig>,
): Promise<StartStreamResult> {
	// The preview-encoder fence, and the reason it lives HERE. The engine fixes
	// the preview encoder when it builds the main graph, so the operator's mode
	// has to be in the engine's config BEFORE the `start` below — not racing it.
	// This function is the single point every start origin funnels through (UI,
	// autostart, set-profile, and all three restoration sites), and the engine
	// `start` has exactly one dispatch site, further down this same function. So
	// awaiting the replay here is what makes "no start of any origin outruns the
	// replay" true for ALL of them, instead of four call-site checks that the
	// fifth origin would silently miss.
	//
	// It runs before every other side effect on purpose: a refused mode must cost
	// nothing — no sender spawned, no audio probed, no bitrate written.
	const previewEncode = await replayPreviewEncodeMode();
	if (!previewEncode.ok) {
		return {
			success: false,
			error: PREVIEW_ENCODE_REPLAY_FAILED,
			reason: PREVIEW_ENCODE_REPLAY_FAILED,
			phase: "connect",
			failureClass:
				previewEncode.failure === "unreachable"
					? "engine_unavailable"
					: "engine_internal",
		};
	}

	const config =
		configOverride === undefined
			? getConfig()
			: ({ ...getConfig(), ...configOverride } as RuntimeConfig);
	const launchConfig = resolveLaunchConfig(config);
	getStreamingBackend().setBitrate(launchConfig);

	// A fresh stream start clears any prior unexpected-exit health flag so the
	// health rollup tracks this new session (ADR-0005 observe-and-notify). The
	// raw-bridge caches are dropped for the same reason: they describe the
	// PREVIOUS session, and the bridge holds its connection across a stop/start,
	// so nothing else would retire them. A new session must read as a genuine
	// cold start until its own first heartbeat lands.
	clearStreamProcessExit();
	resetActiveEncodeLiveness();
	resetActivePassthrough();

	if (!(await maybeProbeAudioSource(pipeline, launchConfig, audioDeps))) {
		logger.warn("startStream: audio source probe failed; aborting start", {
			asrc: launchConfig.asrc,
		});
		return {
			success: false,
			error: AUDIO_SOURCE_PROBE_FAILED,
			reason: AUDIO_SOURCE_PROBE_FAILED,
			phase: "params",
			failureClass: "audio_source_unavailable",
		};
	}
	const statsFile = srtlaStatsFile();
	// ADR-001 control socket: telemetry rides the JSON-RPC subscription when the
	// sender advertises it, with --stats-file as the airtight fallback poll.
	const controlSocket = controlSocketPath(SRTLA_LISTEN_PORT);
	let ipsContent: string;
	try {
		ipsContent = await Bun.file(setup.ips_file ?? "").text();
	} catch (error) {
		logger.warn("startStream: IP list read failed; aborting start", { error });
		return {
			success: false,
			error: IP_LIST_READ_FAILED,
			reason: IP_LIST_READ_FAILED,
			phase: "params",
		};
	}
	// ADR-003 §7: the capability probe runs BEFORE the argument vector is built,
	// so a new CeraUI against an OLD sender emits the byte-identical legacy vector.
	const bindMapArgs = await resolveBindMapArgs(
		srtlaSendExec,
		defaultBindMapSpawnDeps(getLastPublishedBond),
	);
	const transaction = createLaunchTransaction(attemptId, {
		warn: (message, meta) => logger.warn(message, meta),
	});
	try {
		const sender = spawnStreamingLoop(
			srtlaSendExec,
			[
				...buildSrtlaSendArgs({
					listenPort: SRTLA_LISTEN_PORT,
					srtlaHost: srtlaAddr,
					srtlaPort,
					ipsFile: setup.ips_file,
					statsFile,
					controlSocket,
					execPath: setup.srtla_path,
				}),
				...bindMapArgs,
			],
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
		transaction.register(() => stopProcessAndWait(sender));

		// Begin ingesting srtla_send's per-uplink telemetry. Seed the conn_id->iface
		// registry from the exact file srtla_send reads at spawn so tlm_id (file
		// order) maps back to interface names.
		startLinkTelemetry(statsFile, ipsContent.split("\n"), { controlSocket });
		transaction.register(() => stopLinkTelemetry());

		await getStreamingBackend().start(
			launchConfig,
			{
				pipeline: pipeline.source,
				host: "127.0.0.1",
				port: SRTLA_LISTEN_PORT,
				streamid,
			},
			transaction,
		);
	} catch (error) {
		await transaction.rollback();
		throw error;
	}

	return { success: true };
}
