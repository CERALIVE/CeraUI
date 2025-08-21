import { toast } from "svelte-sonner";

import type {
	ConfigMessage,
	PipelinesMessage,
} from "$lib/types/socket-messages";

type Properties = {
	pipeline: keyof PipelinesMessage | undefined;
	audioSource: string | undefined;
	audioCodec: string | undefined;
	audioDelay: number | undefined;
	bitrate: number | undefined;
	bitrateOverlay: boolean | undefined;
	relayServer: string | undefined;
	relayAccount: string | undefined;
	srtlaServerAddress: string | undefined;
	srtlaServerPort: number | undefined;
	srtStreamId: string | undefined;
	srtLatency: number | undefined;
};

export interface ConfigServiceOptions {
	unparsedPipelines: PipelinesMessage | undefined;
}

export function buildStreamingConfig(
	properties: Properties,
	options: ConfigServiceOptions,
): ConfigMessage | null {
	const { unparsedPipelines } = options;
	const config: ConfigMessage = {};

	if (properties.pipeline) {
		config.pipeline = properties.pipeline;
	}

	// Safely access pipeline data with proper null checks
	if (!unparsedPipelines || !properties.pipeline) {
		console.warn(
			"Cannot build streaming config: missing pipeline data or pipeline selection",
		);
		return null;
	}

	const pipelineData = unparsedPipelines[properties.pipeline];
	if (!pipelineData) {
		console.warn(
			"Cannot build streaming config: pipeline data not found for",
			properties.pipeline,
		);
		return null;
	}

	if (pipelineData.asrc && properties.audioSource) {
		config.asrc = properties.audioSource;
	}
	if (pipelineData.acodec && properties.audioCodec) {
		config.acodec = properties.audioCodec;
	}
	if (
		(properties.relayServer == "-1" || properties.relayServer === undefined) &&
		properties.srtlaServerAddress
	) {
		config.srtla_addr = properties.srtlaServerAddress;
		if (properties.srtlaServerPort !== undefined) {
			config.srtla_port = properties.srtlaServerPort;
		}
	} else if (properties.relayServer) {
		config.relay_server = properties.relayServer;
	}
	if (properties.srtLatency !== undefined) {
		config.srt_latency = properties.srtLatency;
	}

	if (
		properties.relayAccount == "-1" ||
		properties.relayAccount === undefined
	) {
		config.srt_streamid = properties.srtStreamId ?? "";
	} else {
		config.relay_account = properties.relayAccount;
	}

	// Add safety checks for required numeric properties
	if (properties.audioDelay !== undefined) {
		config.delay = properties.audioDelay;
	}
	if (properties.bitrate !== undefined) {
		config.max_br = properties.bitrate;
	}
	if (properties.bitrateOverlay !== undefined) {
		config.bitrate_overlay = properties.bitrateOverlay;
	}

	return config;
}

export function startStreamingWithConfig(config: ConfigMessage): void {
	// Try to dismiss all toasts first
	try {
		toast.dismiss();
	} catch (error) {
		console.warn("Could not dismiss toasts:", error);
	}

	// Use the global function which handles toast cleanup safely
	if (
		typeof window !== "undefined" &&
		window.startStreamingWithNotificationClear
	) {
		window.startStreamingWithNotificationClear(config);
	} else {
		// Fallback to direct function call if global function is not available
		import("$lib/helpers/SystemHelper")
			.then((module) => {
				module.startStreaming(config);
			})
			.catch((error) => {
				console.error("Failed to load SystemHelper for streaming:", error);
			});
	}
}

export function stopStreaming(): void {
	// Try to dismiss all toasts first
	try {
		toast.dismiss();
	} catch (error) {
		console.warn("Could not dismiss toasts:", error);
	}

	// Use the global function which handles toast cleanup safely
	if (window.stopStreamingWithNotificationClear) {
		window.stopStreamingWithNotificationClear();
	} else {
		// Fallback
		import("$lib/helpers/SystemHelper")
			.then((module) => {
				module.stopStreaming();
			})
			.catch((error) => {
				console.error(
					"Failed to load SystemHelper for stopping streaming:",
					error,
				);
			});
	}
}

// Export type alias for global use
export type StreamingConfig = ConfigMessage;
