import {
	AUDIO_DELAY_MAX,
	AUDIO_DELAY_MIN,
	BITRATE_DEFAULT_MAX,
	BITRATE_DEFAULT_MIN,
	BITRATE_MAX,
	BITRATE_MIN,
	HOTSPOT_NAME_MAX,
	HOTSPOT_NAME_MIN,
	HOTSPOT_PASSWORD_MAX,
	HOTSPOT_PASSWORD_MIN,
	PORT_MAX,
	PORT_MIN,
	SIM_PIN_MAX_LENGTH,
	SIM_PIN_MIN_LENGTH,
	SRT_LATENCY_MAX,
	SRT_LATENCY_MIN,
	WIFI_PASSWORD_MIN,
} from "@ceraui/rpc/schemas";

export const streamingConstraints = {
	bitrate: {
		min: BITRATE_MIN,
		max: BITRATE_MAX,
		defaultMin: BITRATE_DEFAULT_MIN,
		defaultMax: BITRATE_DEFAULT_MAX,
	},
	srtLatency: { min: SRT_LATENCY_MIN, max: SRT_LATENCY_MAX },
	audioDelay: { min: AUDIO_DELAY_MIN, max: AUDIO_DELAY_MAX },
	port: { min: PORT_MIN, max: PORT_MAX },
} as const;

export const networkConstraints = {
	hotspot: {
		name: { min: HOTSPOT_NAME_MIN, max: HOTSPOT_NAME_MAX },
		password: { min: HOTSPOT_PASSWORD_MIN, max: HOTSPOT_PASSWORD_MAX },
	},
	wifi: {
		password: { min: WIFI_PASSWORD_MIN },
	},
	auth: {
		password: { min: WIFI_PASSWORD_MIN },
	},
	modem: {
		simPin: { min: SIM_PIN_MIN_LENGTH, max: SIM_PIN_MAX_LENGTH },
	},
} as const;
