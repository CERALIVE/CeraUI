interface EnvVariables {
	SOCKET_ENDPOINT: string;
	SOCKET_PORT: string;
	// Loopback/LAN port where the cerastream engine serves the preview WebSocket
	// directly (ADR-0002 preview-ws addendum) — NOT the CeraUI backend port.
	PREVIEW_PORT: string;
}

interface BuildInfo {
	MODE: string;
	NODE_ENV: string;
	IS_DEV: boolean;
	IS_PROD: boolean;
	IS_SSR: boolean;
}

// Development defaults (backend runs on port 3002)
const DEV_DEFAULTS = {
	SOCKET_ENDPOINT: `ws://${typeof window !== "undefined" ? window.location.hostname : "localhost"}`,
	SOCKET_PORT: "3002",
	PREVIEW_PORT: "9997",
};

// Production defaults (backend runs on port 80)
const PROD_DEFAULTS = {
	SOCKET_ENDPOINT: `ws://${typeof window !== "undefined" ? window.location.hostname : "localhost"}`,
	SOCKET_PORT: "80",
	PREVIEW_PORT: "9997",
};

export const ENV_VARIABLES: EnvVariables = {
	SOCKET_ENDPOINT: getEnvVariable("SOCKET_ENDPOINT"),
	SOCKET_PORT: getEnvVariable("SOCKET_PORT"),
	PREVIEW_PORT: getEnvVariable("PREVIEW_PORT"),
};

export function getPreviewSocketUrl(): string {
	const host =
		typeof window !== "undefined" ? window.location.hostname : "localhost";
	const scheme =
		typeof window !== "undefined" && window.location.protocol === "https:"
			? "wss"
			: "ws";
	return `${scheme}://${host}:${ENV_VARIABLES.PREVIEW_PORT}`;
}

export const BUILD_INFO: BuildInfo = {
	MODE: import.meta.env.MODE,
	NODE_ENV: import.meta.env.NODE_ENV || import.meta.env.MODE || "development",
	IS_DEV: import.meta.env.DEV,
	IS_PROD: import.meta.env.PROD,
	IS_SSR: import.meta.env.SSR,
};

function getEnvVariable(
	variable: "SOCKET_ENDPOINT" | "SOCKET_PORT" | "PREVIEW_PORT",
): string {
	// Retrieve the value from the environment variables (prefixed with 'VITE_' in Vite)
	const envValue = import.meta.env[`VITE_${variable}`];

	// If environment variable is set, use it
	if (envValue) {
		return envValue;
	}

	// Use appropriate defaults based on environment
	// Development: port 3002 (backend dev server)
	// Production: port 80 (standard HTTP)
	const defaults = import.meta.env.DEV ? DEV_DEFAULTS : PROD_DEFAULTS;
	return defaults[variable];
}
