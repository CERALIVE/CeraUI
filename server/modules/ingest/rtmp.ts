import { parseStringPromise as parseXmlStringPromise } from "xml2js";

import { httpGet } from "../network/internet";

/* Monitor the RTMP server */
let rtmpIngestStats: Record<string, string> = {};
let prevRtmpBytesIn: Record<string, number> = {};
async function updateRtmpStats() {
	const statsReq = await httpGet({
		host: "localhost",
		port: 1936,
	});
	if (statsReq.code !== 200) return;

	const newStats: Record<string, string> = {};
	const bytesIn: Record<string, number> = {};

	let stats = await parseXmlStringPromise(statsReq.body);
	stats = stats.rtmp.server[0].application[0].live[0];

	if (stats.stream) {
		for (const s of stats.stream) {
			const name = `RTMP ingest - ${s.name[0]}`;
			bytesIn[name] = Number.parseInt(s.bytes_in[0]);
			const bw = Math.round(
				((bytesIn[name] - (prevRtmpBytesIn[name] || 0)) * 8) / 1024,
			);
			newStats[name] = `${bw} Kbps`;
		}
	}

	rtmpIngestStats = newStats;
	prevRtmpBytesIn = bytesIn;
}

export function initRTMPIngestStats() {
	setInterval(async () => {
		try {
			await updateRtmpStats();
		} catch (err) {
			console.log(err);
		}
	}, 1000);
}

export function getRTMPIngestStats() {
	return rtmpIngestStats;
}
