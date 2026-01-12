import type {
	AudioCodecs,
	ConfigMessage,
	Pipelines,
	Resolution,
	Framerate,
} from "@ceraui/rpc/schemas";
import { toast } from "svelte-sonner";

type Properties = {
	source?: string;
	resolution?: Resolution;
	framerate?: Framerate;
	pipeline: keyof Pipelines | undefined;
	audioSource: string | undefined;
	audioCodec: AudioCodecs | undefined;
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
	pipelines: Pipelines | undefined;
}

export function buildStreamingConfig(
	properties: Properties,
	options: ConfigServiceOptions,
): Partial<ConfigMessage> | null {
	const { pipelines } = options;
	const config: Partial<ConfigMessage> = {};

	if (properties.pipeline) {
		config.pipeline = String(properties.pipeline);
	}

	// Safely access pipeline data with proper null checks
	if (!pipelines || !properties.pipeline) {
		console.warn(
			"Cannot build streaming config: missing pipeline data or pipeline selection",
		);
		return null;
	}

	const pipelineData = pipelines[properties.pipeline];
	if (!pipelineData) {
		console.warn(
			"Cannot build streaming config: pipeline data not found for",
			properties.pipeline,
		);
		return null;
	}

	// Audio configuration when pipeline supports it
	if (pipelineData.supportsAudio) {
		if (properties.audioSource) {
			config.asrc = properties.audioSource;
		}
		// Default to 'aac' if not selected
		config.acodec = properties.audioCodec || "aac";
	}

	// Server configuration
	if (
		(properties.relayServer === "-1" || properties.relayServer === undefined) &&
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
		properties.relayAccount === "-1" ||
		properties.relayAccount === undefined
	) {
		config.srt_streamid = properties.srtStreamId ?? "";
	} else {
		config.relay_account = properties.relayAccount;
	}

	// Required fields with defaults
	config.delay = properties.audioDelay ?? 0;
	config.max_br = properties.bitrate ?? 5000;
	config.bitrate_overlay = properties.bitrateOverlay ?? false;

	return config;
}

export function startStreamingWithConfig(config: Partial<ConfigMessage>): void {
	try {
		toast.dismiss();
	} catch (error) {
		console.warn("Could not dismiss toasts:", error);
	}

	if (
		typeof window !== "undefined" &&
		window.startStreamingWithNotificationClear
	) {
		window.startStreamingWithNotificationClear(config);
	} else {
		import("$lib/helpers/SystemHelper")
			.then((module) => {
				module.startStreaming(
					config as Parameters<typeof module.startStreaming>[0],
				);
			})
			.catch((error) => {
				console.error("Failed to load SystemHelper for streaming:", error);
			});
	}
}

export function stopStreaming(): void {
	try {
		toast.dismiss();
	} catch (error) {
		console.warn("Could not dismiss toasts:", error);
	}

	if (window.stopStreamingWithNotificationClear) {
		window.stopStreamingWithNotificationClear();
	} else {
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

export type StreamingConfig = ConfigMessage;
