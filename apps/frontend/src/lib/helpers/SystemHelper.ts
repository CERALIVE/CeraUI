import { socket } from "$lib/stores/websocket-store";
import type { ConfigMessage } from "$lib/types/socket-messages";

export type AudioCodecs = "aac" | "opus";

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

const sendCommand = (cmd: string) => {
	socket.send(JSON.stringify({ command: cmd }));
};
export const installSoftwareUpdates = () => {
	sendCommand("update");
};

export const reboot = () => {
	sendCommand("reboot");
};

export const powerOff = () => {
	sendCommand("poweroff");
};

export const startSSH = () => {
	sendCommand("start_ssh");
};

export const stopSSH = () => {
	sendCommand("stop_ssh");
};

export const resetSSHPasword = () => {
	sendCommand("reset_ssh_pass");
};

export const getSystemLog = () => {
	console.log("🔽 Requesting system log download...");
	sendCommand("get_syslog");
};

export const getDeviceLog = () => {
	console.log("🔽 Requesting device log download...");
	sendCommand("get_log");
};

// Legacy alias for backward compatibility
export const getBelaboxLog = getDeviceLog;

export const saveRemoteKey = (key: string) => {
	socket.send(JSON.stringify({ config: { remote_key: key } }));
};

export const savePassword = (password: string) => {
	socket.send(JSON.stringify({ config: { password: password } }));
	localStorage.setItem("auth", password);
};
export const setBitrate = (bitrate: number) => {
	socket.send(JSON.stringify({ bitrate: { max_br: `${bitrate}` } }));
};

export const stopStreaming = () => {
	socket.send(JSON.stringify({ stop: "0" }));
};

export const startStreaming = (config: ConfigMessage) => {
	console.log(JSON.stringify({ start: config }));
	socket.send(JSON.stringify({ start: config }));
};

export const updateConfig = (config: { [key: string]: string | number }) => {
	socket.send(JSON.stringify({ config }));
};

export const updateBitrate = (bitrate: number) => {
	socket.send(JSON.stringify({ bitrate: { max_br: bitrate } }));
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
