import { logger } from "../../helpers/logger.ts";
import {
	type SupervisedHandle,
	superviseWorker,
} from "../../helpers/spawn-policy.ts";
import {
	getMockSrtStats,
	shouldMockStreaming,
} from "../../mocks/providers/streaming.ts";

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
let currentTransmitter: SupervisedHandle | null = null;

function srtTransmitStreams(proc: SupervisedHandle["proc"]): {
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
} {
	if (!proc.stdout || !proc.stderr) {
		throw new Error("srt-live-transmit process missing output streams");
	}
	return { stdout: proc.stdout, stderr: proc.stderr };
}

function parseSrtStats(raw: string): SrtStatsData | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const recv = Reflect.get(parsed, "recv");
		const link = Reflect.get(parsed, "link");
		if (typeof recv !== "object" || recv === null) return null;
		if (typeof link !== "object" || link === null) return null;
		const mbitRate = Reflect.get(recv, "mbitRate");
		const rtt = Reflect.get(link, "rtt");
		if (typeof mbitRate !== "number" || typeof rtt !== "number") return null;
		return { recv: { mbitRate }, link: { rtt } };
	} catch {
		return null;
	}
}

/**
 * Starts the SRT Live Transmit process to convert SRT stream to UDP
 * Collects and processes statistics about the connection
 */
export function startSrtTransmitter(): SupervisedHandle {
	if (currentTransmitter !== null) return currentTransmitter;

	const argv = [
		"srt-live-transmit",
		"-st:yes",
		"-stats-report-frequency:500",
		"-statspf:json",
		"srt://:4000", // SRT input on port 4000
		"udp://127.0.0.1:4001", // UDP output on localhost:4001
	];
	const handle = superviseWorker(argv, {
		spawn: (args) =>
			Bun.spawn(args, {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			}),
		waitForReady: async (proc) => {
			await Bun.sleep(0);
			if (proc.exitCode !== null || proc.signalCode !== null) {
				throw new Error("srt-live-transmit exited during startup");
			}
		},
	});
	currentTransmitter = handle;

	const transmitProcess = handle.proc;
	const streams = srtTransmitStreams(transmitProcess);

	void handle.ready.catch((err: unknown) => {
		logger.error(`SRT ingest failed startup readiness: ${String(err)}`);
		void stopSRTIngest();
	});

	// Supervised long-lived worker: startup readiness is bounded above, but no
	// process-lifetime timeout is applied because that would cut a live ingest.
	let hasActiveConnection = false;

	// Process statistics output from stdout
	const consumeStdout = async () => {
		const decoder = new TextDecoder();
		for await (const chunk of streams.stdout) {
			if (!hasActiveConnection) continue;

			const statsData = parseSrtStats(decoder.decode(chunk, { stream: false }));
			if (statsData === null) continue;
			const bitrate = Math.round(statsData.recv.mbitRate * 1024);
			const roundTripTime = Math.round(statsData.link.rtt);

			currentConnectionStats = `${bitrate} Kbps, ${roundTripTime} ms RTT`;
		}
	};

	// Monitor connection status from stderr
	const consumeStderr = async () => {
		const decoder = new TextDecoder();
		for await (const chunk of streams.stderr) {
			const logMessage = decoder.decode(chunk, { stream: false });

			if (logMessage.match("SRT source disconnected")) {
				// Handle disconnection
				currentConnectionStats = "";
				hasActiveConnection = false;
			} else if (logMessage.match("Accepted SRT source connection")) {
				// Handle the new connection
				hasActiveConnection = true;
			}
		}
	};

	void consumeStdout();
	void consumeStderr();
	void transmitProcess.exited.finally(() => {
		if (currentTransmitter === handle) currentTransmitter = null;
	});

	return handle;
}

export async function stopSRTIngest(): Promise<void> {
	const handle = currentTransmitter;
	currentTransmitter = null;
	currentConnectionStats = null;
	await handle?.shutdown();
}

/**
 * Initialize the SRT ingest system
 */
export function initSRTIngest(): void {
	// Skip starting real transmitter in development mode
	if (shouldMockStreaming()) {
		logger.info("🎭 SRT ingest: Using mock streaming stats");
		return;
	}
	startSrtTransmitter();
}

/**
 * Get the current SRT connection statistics
 * @returns Current connection stats: bitrate and round-trip time, or empty if disconnected
 */
export function getSRTIngestStats(): ConnectionStats {
	// Use mock data in development mode
	if (shouldMockStreaming()) {
		const mockStats = getMockSrtStats();
		if (mockStats) {
			const bitrate = Math.round(mockStats.bitrate);
			const roundTripTime = Math.round(mockStats.latency);
			return `${bitrate} Kbps, ${roundTripTime} ms RTT`;
		}
		return "";
	}

	return currentConnectionStats;
}
