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

// CeracoderBackend: the StreamingBackend implementation for the CURRENT C
// `ceracoder` engine. It is the single home for every ceracoder-specific
// operation — exec/config-path resolution, config-file writes, the SIGHUP
// hot-reload, run-arg construction, the engine spawn + stderr error
// classification, and the streaming-time bitrate setter. The logic here was
// moved verbatim out of `ceracoder.ts`, `encoder.ts` (setBitrate) and the
// ceracoder half of `streamloop/start-stream.ts`; behaviour is unchanged.
//
// `bcrpt` stays out of this module on purpose — it is an independent binary with
// its own lifecycle in `bcrpt.ts` (see SCOPE in streaming-backend.ts).
//
// INI BOUNDARY: this file is the ONLY place that translates the unified
// `runtimeConfigSchema` (helpers/config-schemas.ts) into `ceracoder.conf` INI.
// `writeConfig`/`buildRunArgs` map the runtime fields (`max_br`, `srt_latency`,
// `balancer`, `delay`) onto the engine's INI grammar via `buildCeracoderConfig`.
// Nothing above the StreamingBackend seam knows the INI exists.

import {
	buildCeracoderConfig,
	buildCeracoderRunArtifacts,
	CERACODER_PATHS,
	configExists as checkConfigExists,
	DEFAULT_ADAPTIVE,
	DEFAULT_AIMD,
	getCeracoderExec as getExecFromBindings,
	sendHup as sendHupFromBindings,
	writeConfig,
} from "@ceralive/ceracoder";
import type { RuntimeConfig } from "../../helpers/config-schemas.ts";
import killall from "../../helpers/killall.ts";
import { logger } from "../../helpers/logger.ts";
import {
	notificationBroadcast,
	notificationExists,
} from "../ui/notifications.ts";
import { validateBitrate } from "./encoder.ts";
import { setup } from "../setup.ts";
import { getConfig, saveConfig } from "../config.ts";
import { resolveProcessError } from "./streamloop/process-error-patterns.ts";
import {
	getStreamingProcesses,
	spawnStreamingLoop,
	stopProcess,
} from "./streamloop/process-runner.ts";
import type {
	BackendErrorListener,
	BitrateParams,
	StreamingBackend,
	StreamRunOptions,
} from "./streaming-backend.ts";

export class CeracoderBackend implements StreamingBackend {
	private readonly errorListeners: Array<BackendErrorListener> = [];

	// Re-export of the engine's temp pipeline path (was TEMP_PIPELINE_PATH).
	get tempPipelinePath(): string {
		return CERACODER_PATHS.pipeline;
	}

	/**
	 * Resolved ceracoder executable path. Uses setup.ceracoder_path as override
	 * if configured (was getCeracoderExec()).
	 */
	get execPath(): string {
		return getExecFromBindings({ execPath: setup.ceracoder_path });
	}

	/** Ceracoder config file path (was getCeracoderConfigPath()). */
	get configPath(): string {
		return setup.ceracoder_config ?? CERACODER_PATHS.config;
	}

	/** Whether the config file exists (was configExists()). */
	configExists(): boolean {
		return checkConfigExists(this.configPath);
	}

	/** Write config and return the path (was writeCeracoderConfigFile()). */
	writeConfig(runtimeConfig: RuntimeConfig): string {
		const { ini } = buildCeracoderConfig({
			general: {
				min_bitrate: 300,
				max_bitrate: runtimeConfig.max_br,
				balancer: runtimeConfig.balancer ?? "adaptive",
			},
			srt: {
				latency: runtimeConfig.srt_latency,
			},
		});

		const configPath = this.configPath;
		writeConfig(ini, configPath);

		logger.debug(`Ceracoder config written to ${configPath}`);
		return configPath;
	}

	/** Send SIGHUP to reload ceracoder config (was sendCeracoderHup()). */
	reloadConfig(): void {
		// Use the CeraUI killall helper for consistency with other process
		// management.
		sendHupFromBindings({ killall });
	}

	/**
	 * Build ceracoder CLI arguments and write the config file
	 * (was buildCeracoderArgsAndWriteConfig()).
	 */
	buildRunArgs(
		runtimeConfig: RuntimeConfig,
		opts: StreamRunOptions,
	): Array<string> {
		const configPath = this.configPath;
		const balancer = runtimeConfig.balancer ?? "adaptive";

		const { ini, args } = buildCeracoderRunArtifacts({
			pipelineFile: opts.pipelineFile,
			host: opts.host,
			port: opts.port,
			configFile: configPath,
			config: {
				general: {
					min_bitrate: 300,
					max_bitrate: runtimeConfig.max_br,
					balancer,
				},
				srt: {
					latency: runtimeConfig.srt_latency,
				},
				adaptive:
					balancer === "adaptive"
						? {
								incr_step: DEFAULT_ADAPTIVE.incr_step,
								decr_step: DEFAULT_ADAPTIVE.decr_step,
								incr_interval: DEFAULT_ADAPTIVE.incr_interval,
								decr_interval: DEFAULT_ADAPTIVE.decr_interval,
								loss_threshold: DEFAULT_ADAPTIVE.loss_threshold,
							}
						: undefined,
				aimd:
					balancer === "aimd"
						? {
								incr_step: DEFAULT_AIMD.incr_step,
								decr_mult: DEFAULT_AIMD.decr_mult,
								incr_interval: DEFAULT_AIMD.incr_interval,
								decr_interval: DEFAULT_AIMD.decr_interval,
							}
						: undefined,
			},
			delayMs: runtimeConfig.delay,
			streamId: opts.streamid || undefined,
			latencyMs: runtimeConfig.srt_latency,
			reducedPacketSize: opts.reducedPacketSize,
			fullOverride: opts.fullOverride,
		});

		writeConfig(ini, configPath);
		return args;
	}

	/**
	 * Launch the ceracoder engine: build the argv (and persist run config), then
	 * spawn it under the process-runner supervisor with the engine's stderr error
	 * classifier wired in (moved from the ceracoder half of start-stream.ts).
	 */
	start(config: RuntimeConfig, opts: StreamRunOptions): void {
		const args = this.buildRunArgs(config, opts);
		spawnStreamingLoop(this.execPath, args, (err) => this.handleStderr(err));
	}

	/**
	 * Stop the ceracoder engine process. Clears every supervised process'
	 * exit-listeners (the stop path owns the shutdown ordering), then for the
	 * ceracoder process: if it is still live, defer `onStopped` until it exits;
	 * if it was already dead, fire `onStopped` immediately. Returns whether a
	 * ceracoder process was found (moved from the ceracoder branch of
	 * session.ts stop()).
	 */
	stop(onStopped: () => void): boolean {
		let foundCeracoder = false;

		for (const p of getStreamingProcesses()) {
			p.exitListeners = [];
			if (p.spawnfile.endsWith("ceracoder")) {
				foundCeracoder = true;
				logger.debug("stop: found the ceracoder process");

				if (!stopProcess(p)) {
					// if the process is active, wait for it to exit
					p.exitListeners.push(() => {
						logger.info("stop: ceracoder terminated");
						onStopped();
					});
				} else {
					// if ceracoder has terminated already, skip to the next step
					logger.info("stop: ceracoder already terminated");
					onStopped();
				}
			}
		}

		return foundCeracoder;
	}

	/**
	 * Persist max bitrate and hot-reload the engine; returns the applied value or
	 * undefined when the input fails validation (moved from encoder.setBitrate).
	 */
	setBitrate(params: BitrateParams): number | undefined {
		const maxBr = validateBitrate(params);
		if (maxBr === undefined) return;

		const config = getConfig();
		const previousBitrate = config.max_br;

		try {
			config.max_br = maxBr;
			saveConfig();
			this.writeConfig(config);
			this.reloadConfig();
			return maxBr;
		} catch (error) {
			// Restore previous bitrate if operation failed
			config.max_br = previousBitrate;
			logger.error("Failed to set bitrate", { error });
			throw error;
		}
	}

	onError(listener: BackendErrorListener): void {
		this.errorListeners.push(listener);
	}

	/**
	 * Classify a ceracoder stderr chunk into a user-facing notification, then
	 * fan the raw chunk out to any registered error listeners. The stderr→message
	 * mapping is owned by the shared `process-error-patterns` table (the single
	 * source of truth for both srtla_send and ceracoder); this is exactly the
	 * ceracoder spawn callback moved out of start-stream.ts.
	 */
	private handleStderr(err: string): void {
		const resolved = resolveProcessError("ceracoder", err);
		if (
			resolved &&
			!(resolved.suppressIfSrtlaNotified && notificationExists("srtla"))
		) {
			notificationBroadcast(
				"ceracoder",
				"error",
				resolved.message,
				5,
				true,
				false,
			);
		}

		for (const listener of this.errorListeners) {
			listener(err);
		}
	}
}

// Process-wide singleton: the one engine driver every streaming call site routes
// through.
export const ceracoderBackend: StreamingBackend = new CeracoderBackend();
