import type {
	AudioCodecs,
	ConfigMessage,
	CustomProviderInput,
	ProviderSelection,
	StreamingConfigInput,
} from "@ceraui/rpc/schemas";

import { rpc } from "$lib/rpc/client";

// Re-export type for backward compatibility
export type { AudioCodecs };

// Alias for backward compatibility
type CustomProvider = CustomProviderInput;

export type Config = {
	pipeline: string;
	acodec: AudioCodecs;
	delay: number;
	max_br: number;
	srt_latency: number;
	bitrate_overlay: boolean;
	srtla_addr: string;
	srtla_port: string;
	srt_streamid: string;
};

export const installSoftwareUpdates = async () => {
	try {
		await rpc.system.startUpdate();
	} catch (error) {
		console.error("Failed to start update:", error);
		throw error;
	}
};

export const reboot = async () => {
	try {
		await rpc.system.reboot();
	} catch (error) {
		console.error("Failed to reboot:", error);
		throw error;
	}
};

export const powerOff = async () => {
	try {
		await rpc.system.poweroff();
	} catch (error) {
		console.error("Failed to power off:", error);
		throw error;
	}
};

export const startSSH = async () => {
	try {
		await rpc.system.sshStart();
	} catch (error) {
		console.error("Failed to start SSH:", error);
		throw error;
	}
};

export const stopSSH = async () => {
	try {
		await rpc.system.sshStop();
	} catch (error) {
		console.error("Failed to stop SSH:", error);
		throw error;
	}
};

export const resetSSHPasword = async () => {
	try {
		const result = await rpc.system.sshResetPassword();
		return result.password;
	} catch (error) {
		console.error("Failed to reset SSH password:", error);
		throw error;
	}
};

export const getSystemLog = async () => {
	console.log("🔽 Requesting system log download...");
	try {
		await rpc.system.getSyslog();
	} catch (error) {
		console.error("Failed to get system log:", error);
		throw error;
	}
};

export const getDeviceLog = async () => {
	console.log("🔽 Requesting device log download...");
	try {
		await rpc.system.getLog();
	} catch (error) {
		console.error("Failed to get device log:", error);
		throw error;
	}
};

export type RemoteConfigParams = {
	remote_key: string;
	provider?: ProviderSelection;
	custom_provider?: CustomProvider;
};

export const saveRemoteKey = async (key: string) => {
	try {
		await rpc.system.setRemoteConfig({
			remote_key: key,
			provider: "ceralive",
		});
	} catch (error) {
		console.error("Failed to save remote key:", error);
		throw error;
	}
};

export const saveRemoteConfig = async (params: RemoteConfigParams) => {
	try {
		await rpc.system.setRemoteConfig({
			remote_key: params.remote_key,
			provider: params.provider ?? "ceralive",
			custom_provider: params.custom_provider,
		});
	} catch (error) {
		console.error("Failed to save remote config:", error);
		throw error;
	}
};

export const savePassword = async (password: string) => {
	try {
		await rpc.auth.setPassword({ password });
		localStorage.setItem("auth", password);
	} catch (error) {
		console.error("Failed to save password:", error);
		throw error;
	}
};

export const setBitrate = async (bitrate: number) => {
	try {
		await rpc.streaming.setBitrate({ max_br: bitrate });
	} catch (error) {
		console.error("Failed to set bitrate:", error);
		throw error;
	}
};

export const stopStreaming = async () => {
	try {
		await rpc.streaming.stop();
	} catch (error) {
		console.error("Failed to stop streaming:", error);
		throw error;
	}
};

export const startStreaming = async (config: ConfigMessage) => {
	console.log("Starting streaming with config:", config);
	try {
		// Map ConfigMessage to StreamingConfigInput
		const input: StreamingConfigInput = {
			pipeline: config.pipeline,
			acodec: config.acodec,
			delay: config.delay,
			max_br: config.max_br,
			srt_latency: config.srt_latency,
			bitrate_overlay: config.bitrate_overlay,
			srtla_addr: config.srtla_addr,
			srtla_port: config.srtla_port,
			srt_streamid: config.srt_streamid,
			asrc: config.asrc,
			relay_server: config.relay_server,
			relay_account: config.relay_account,
		};
		await rpc.streaming.start(input);
	} catch (error) {
		console.error("Failed to start streaming:", error);
		throw error;
	}
};

export const updateConfig = async (_config: {
	[key: string]: string | number;
}) => {
	// Config updates are handled via specific RPC methods now
	// This function is kept for backward compatibility
	console.warn("updateConfig is deprecated, use specific RPC methods instead");
};

export const updateBitrate = async (bitrate: number) => {
	try {
		await rpc.streaming.setBitrate({ max_br: bitrate });
	} catch (error) {
		console.error("Failed to update bitrate:", error);
		throw error;
	}
};
export const downloadLog = ({
	name,
	contents,
}: {
	name: string;
	contents: string;
}) => {
	console.log("💾 Downloading log:", { name, contentLength: contents.length });

	const parsedContent = contents
		.split("\n")
		.map((line) => line.trim()) // Trim whitespace
		.filter((line) => line.length > 0) // Remove empty lines
		.join("\n"); // Join back into a string

	const blob = new Blob([parsedContent], { type: "text/plain" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);

	console.log("✅ Log download triggered successfully");
};
