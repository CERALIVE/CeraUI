import {
	buildCeracoderConfig,
	buildCeracoderRunArtifacts,
	DEFAULT_ADAPTIVE,
	DEFAULT_AIMD,
	getCeracoderExec as getExecFromBindings,
	CERACODER_PATHS,
	sendHup as sendHupFromBindings,
	writeConfig,
	configExists as checkConfigExists,
} from "@ceralive/ceracoder";

import killall from "../../helpers/killall.ts";
import type { RuntimeConfig } from "../../helpers/config-schemas.ts";
import { setup } from "../setup.ts";
import { logger } from "../../helpers/logger.ts";

// Re-export the temp pipeline path from bindings
export const TEMP_PIPELINE_PATH = CERACODER_PATHS.pipeline;

/**
 * Get the ceracoder executable path
 * Uses setup.ceracoder_path as override if configured
 */
export function getCeracoderExec(): string {
	return getExecFromBindings({ execPath: setup.ceracoder_path });
}

/**
 * Get the ceracoder config file path
 */
export function getCeracoderConfigPath(): string {
	return setup.ceracoder_config ?? CERACODER_PATHS.config;
}

/**
 * Write config and return the path
 */
export function writeCeracoderConfigFile(runtimeConfig: RuntimeConfig): string {
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

	const configPath = getCeracoderConfigPath();
	writeConfig(ini, configPath);

	logger.debug(`Ceracoder config written to ${configPath}`);
	return configPath;
}

/**
 * Send SIGHUP to reload ceracoder config
 */
export function sendCeracoderHup() {
	// Use the CeraUI killall helper for consistency with other process management
	sendHupFromBindings({ killall });
}

/**
 * Check if config file exists
 */
export function configExists(): boolean {
	return checkConfigExists(getCeracoderConfigPath());
}

/**
 * Build ceracoder CLI arguments and write config file
 */
export function buildCeracoderArgsAndWriteConfig(
	runtimeConfig: RuntimeConfig,
	pipelineFile: string,
	host: string,
	port: number,
	streamid: string,
	reducedPacketSize: boolean,
	fullOverride = false,
): Array<string> {
	const configPath = getCeracoderConfigPath();
	const balancer = runtimeConfig.balancer ?? "adaptive";

	const { ini, args } = buildCeracoderRunArtifacts({
		pipelineFile,
		host,
		port,
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
		streamId: streamid || undefined,
		latencyMs: runtimeConfig.srt_latency,
		reducedPacketSize,
		fullOverride,
	});

	writeConfig(ini, configPath);
	return args;
}
