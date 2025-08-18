import { spawn } from "node:child_process";

// Define types for better clarity
type ConnectionStats = `${number} Kbps, ${number} ms RTT` | "" | null;
interface SrtStatsData {
	recv: {
		mbitRate: number;
	};
	link: {
		rtt: number;
	};
}

/**
 * Manages SRT to UDP conversion using srt-live-transmit
 * Collects and formats connection statistics
 */
let currentConnectionStats: ConnectionStats = null;

/**
 * Starts the SRT Live Transmit process to convert SRT stream to UDP
 * Collects and processes statistics about the connection
 */
function startSrtTransmitter(): void {
	// Launch the srt-live-transmit process with appropriate parameters
	const transmitProcess = spawn(
		"srt-live-transmit",
		[
			"-st:yes",
			"-stats-report-frequency:500",
			"-statspf:json",
			"srt://:4000", // SRT input on port 4000
			"udp://127.0.0.1:4001", // UDP output on localhost:4001
		],
		{
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	let hasActiveConnection = false;

	// Process statistics output from stdout
	transmitProcess.stdout.on("data", (data) => {
		if (!hasActiveConnection) return;

		try {
			// Parse JSON stats and format connection information
			const statsData: SrtStatsData = JSON.parse(data.toString("utf8"));
			const bitrate = Math.round(statsData.recv.mbitRate * 1024);
			const roundTripTime = Math.round(statsData.link.rtt);

			currentConnectionStats = `${bitrate} Kbps, ${roundTripTime} ms RTT`;
		} catch (_err) {
			// Silently handle parsing errors
		}
	});

	// Monitor connection status from stderr
	transmitProcess.stderr.on("data", (data) => {
		const logMessage = data.toString("utf8");

		if (logMessage.match("SRT source disconnected")) {
			// Handle disconnection
			currentConnectionStats = "";
			hasActiveConnection = false;
		} else if (logMessage.match("Accepted SRT source connection")) {
			// Handle the new connection
			hasActiveConnection = true;
		}
	});
}

/**
 * Initialize the SRT ingest system
 */
export function initSRTIngest(): void {
	startSrtTransmitter();
}

/**
 * Get the current SRT connection statistics
 * @returns Current connection stats: bitrate and round-trip time, or empty if disconnected
 */
export function getSRTIngestStats(): ConnectionStats {
	return currentConnectionStats;
}
