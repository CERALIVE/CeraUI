import type { StartParams } from "@ceralive/cerastream";

export const forcedLegacy: StartParams = {
	pipeline: "usb",
	input_id: "usb",
	input_mode: "uvc_h264",
	codec: "h264",
	video_passthrough: "force",
	srt: { host: "127.0.0.1", port: 9000, latency_ms: 2000 },
	bitrate: { min_bitrate: 500, max_bitrate: 5000, balancer: "fixed" },
};
