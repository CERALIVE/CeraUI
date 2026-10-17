export const STREAM_LAUNCH_ORIGINS = [
	"ui",
	"autostart",
	"set-profile",
	"remote-control",
	"restoration",
] as const;
export type StreamLaunchOrigin = (typeof STREAM_LAUNCH_ORIGINS)[number];
export const INTERNAL_LAUNCH_ORIGINS: ReadonlySet<StreamLaunchOrigin> = new Set(
	["autostart", "restoration"],
);
export const RECONFIGURE_STOP_TIMEOUT_REASON = "reconfigure_stop_timeout";
