import fs from "node:fs";
import { parseStringPromise as parseXmlStringPromise } from "xml2js";
import { httpGet } from "../network/internet";

// Define specific types for the RTMP statistics
type StreamBandwidth = `${number} Kbps`;
type StreamName = `RTMP ingest - ${string}`;

// Define more specific record types
type RtmpStats = Record<StreamName, StreamBandwidth>;
type BytesCounter = Record<StreamName, number>;

// Track RTMP server stats
let currentStreamBandwidths: RtmpStats = {};
let previousBytesCounted: BytesCounter = {};

async function updateRtmpStats(): Promise<void> {
	const serverResponse = await httpGet({
		host: "localhost",
		port: 1936,
	});

	// Exit if request failed
	if (serverResponse.code !== 200) return;

	const newStreamBandwidths: RtmpStats = {};
	const currentBytesCounted: BytesCounter = {};

	// Parse XML response and navigate to live streams data
	const xmlData = await parseXmlStringPromise(serverResponse.body);
	const liveStreamData = xmlData.rtmp.server[0].application[0].live[0];

	// Process each active stream if any exist
	if (liveStreamData.stream) {
		for (const stream of liveStreamData.stream) {
			// Create standardized stream name
			const streamName = `RTMP ingest - ${stream.name[0]}` as StreamName;

			// Count total bytes received for this stream
			currentBytesCounted[streamName] = Number.parseInt(stream.bytes_in[0]);

			// Calculate bandwidth based on difference since last check
			const previousBytes = previousBytesCounted[streamName] || 0;
			const bytesDifference = currentBytesCounted[streamName] - previousBytes;
			const bandwidthKbps = Math.round((bytesDifference * 8) / 1024);

			// Store formatted bandwidth value
			newStreamBandwidths[streamName] =
				`${bandwidthKbps} Kbps` as StreamBandwidth;
		}
	}

	// Update global state with new values
	currentStreamBandwidths = newStreamBandwidths;
	previousBytesCounted = currentBytesCounted;
}

export function initRTMPIngestStats(): void {
	// Skip RTMP stats polling in development mode (no RTMP server running)
	const isDevelopment =
		process.env.NODE_ENV === "development" && !fs.existsSync("public");

	if (isDevelopment) {
		console.log("Development mode: Skipping RTMP statistics polling");
		return;
	}

	setInterval(async () => {
		try {
			await updateRtmpStats();
		} catch (error) {
			console.log(error);
		}
	}, 1000);
}

export function getRTMPIngestStats(): RtmpStats {
	return currentStreamBandwidths;
}
