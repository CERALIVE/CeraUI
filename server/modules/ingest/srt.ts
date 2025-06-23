import { spawn } from "node:child_process";

/* Use srt-live-transmit to convert from SRT to UDP (usable by udpsrc in gstreamer), with stats */
let ingestStats: string | null = null;
function runSLT() {
	const proc = spawn(
		"srt-live-transmit",
		[
			"-st:yes",
			"-stats-report-frequency:500",
			"-statspf:json",
			"srt://:4000",
			"udp://127.0.0.1:4001",
		],
		{
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	let hasInConn = false;
	proc.stdout.on("data", (data) => {
		if (!hasInConn) return;
		try {
			const stats = JSON.parse(data.toString("utf8"));
			ingestStats = `${Math.round(stats.recv.mbitRate * 1024)} Kbps, ${Math.round(stats.link.rtt)} ms RTT`;
		} catch (_err) {}
	});

	proc.stderr.on("data", (data) => {
		const datStr = data.toString("utf8");
		if (datStr.match("SRT source disconnected")) {
			ingestStats = "";
			hasInConn = false;
		} else if (datStr.match("Accepted SRT source connection")) {
			hasInConn = true;
		}
	});
}

export function initSRTIngest() {
	runSLT();
}

export function getSRTIngestStats() {
	return ingestStats;
}
