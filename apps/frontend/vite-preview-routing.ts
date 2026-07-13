import type { Duplex } from "node:stream";
import type { Plugin } from "vite";

export const DEVICE_WS_PROXY_CONTEXT = "^/(?:ws|preview)(?:\\?[^#]*)?$";
export const E2E_BACKEND_PORT_COOKIE = "ceraui_e2e_backend_port";
export const E2E_WORKER_SECRET_HEADER = "x-ceraui-worker-secret";

const E2E_WORKER_ROUTE = /^(31\d{2})\.([0-9a-f]{64})$/;
const ACCEPTED_WS_PATHS = new Set(["/ws", "/preview"]);
const RAW_WS_REQUEST_TARGET = /^\/(?:ws|preview)(?:\?[^#]*)?$/;
const STEERING_QUERY_KEYS = new Set([
	E2E_BACKEND_PORT_COOKIE,
	"backendport",
	"port",
	"workerport",
	"workersecret",
	E2E_WORKER_SECRET_HEADER,
]);
const STEERING_HEADERS = new Set([
	E2E_WORKER_SECRET_HEADER,
	"x-ceraui-e2e-backend-port",
	"x-ceraui-e2e-proxy-auth",
	"x-ceraui-worker-port",
]);

export interface PreviewWebSocketRequest {
	url?: string;
	headers: Record<string, string | string[] | undefined>;
}

export interface PreviewWebSocketRoute {
	target: string;
	workerPort?: number;
	workerSecret?: string;
	forwardedCookie?: string;
}

export function applyPreviewWebSocketRoute(
	request: PreviewWebSocketRequest,
	route: PreviewWebSocketRoute,
): void {
	if (route.workerSecret === undefined) return;
	if (route.forwardedCookie === undefined) {
		delete request.headers.cookie;
	} else {
		request.headers.cookie = route.forwardedCookie;
	}
	request.headers[E2E_WORKER_SECRET_HEADER] = route.workerSecret;
}

function parseRequestUrl(rawUrl: string | undefined): URL | null {
	if (rawUrl === undefined || !RAW_WS_REQUEST_TARGET.test(rawUrl)) return null;
	try {
		return new URL(rawUrl, "http://localhost");
	} catch {
		return null;
	}
}

function hasSteeringAttempt(
	url: URL,
	headers: PreviewWebSocketRequest["headers"],
): boolean {
	for (const key of url.searchParams.keys()) {
		if (STEERING_QUERY_KEYS.has(key.toLowerCase())) return true;
	}
	for (const key of Object.keys(headers)) {
		if (STEERING_HEADERS.has(key.toLowerCase())) return true;
	}
	return false;
}

function parseRoutingCookie(cookieHeader: string | undefined): {
	port: number;
	secret: string;
	forwardedCookie?: string;
} | null {
	if (cookieHeader === undefined) return null;

	let routeValue: string | undefined;
	const forwardedSegments: string[] = [];
	for (const rawSegment of cookieHeader.split(";")) {
		const segment = rawSegment.startsWith(" ")
			? rawSegment.slice(1)
			: rawSegment;
		const separator = segment.indexOf("=");
		const name = separator < 0 ? segment : segment.slice(0, separator);
		if (name !== E2E_BACKEND_PORT_COOKIE) {
			let decodedName: string | undefined;
			try {
				decodedName = decodeURIComponent(name);
			} catch {
				decodedName = undefined;
			}
			if (
				name.trim() === E2E_BACKEND_PORT_COOKIE ||
				decodedName === E2E_BACKEND_PORT_COOKIE
			) {
				return null;
			}
			forwardedSegments.push(segment);
			continue;
		}
		if (routeValue !== undefined || separator < 0) return null;
		routeValue = segment.slice(separator + 1);
	}

	const routeMatch = E2E_WORKER_ROUTE.exec(routeValue ?? "");
	if (!routeMatch) return null;
	const port = Number.parseInt(routeMatch[1] ?? "", 10);
	const secret = routeMatch[2];
	if (port < 3100 || port > 3199 || secret === undefined) return null;

	const forwardedCookie = forwardedSegments.join("; ");
	return {
		port,
		secret,
		...(forwardedCookie === "" ? {} : { forwardedCookie }),
	};
}

export function isAcceptedPreviewWebSocketPath(
	rawUrl: string | undefined,
): boolean {
	const url = parseRequestUrl(rawUrl);
	return url !== null && ACCEPTED_WS_PATHS.has(url.pathname);
}

export function resolvePreviewWebSocketRoute(
	defaultTarget: string,
	request: PreviewWebSocketRequest,
	allowWorkerRouting: boolean,
): PreviewWebSocketRoute | null {
	const url = parseRequestUrl(request.url);
	if (
		url === null ||
		!ACCEPTED_WS_PATHS.has(url.pathname)
	) {
		return null;
	}
	if (!allowWorkerRouting) return { target: defaultTarget };
	if (hasSteeringAttempt(url, request.headers)) return null;

	const route = parseRoutingCookie(
		typeof request.headers.cookie === "string"
			? request.headers.cookie
			: undefined,
	);
	if (route === null) return null;
	return {
		target: `ws://127.0.0.1:${route.port}`,
		workerPort: route.port,
		workerSecret: route.secret,
		...(route.forwardedCookie === undefined
			? {}
			: { forwardedCookie: route.forwardedCookie }),
	};
}

export function rejectWebSocketUpgrade(
	socket: Pick<Duplex, "destroy" | "on">,
): void {
	// A reset can race the rejection under Node 24. Own the socket's error before
	// destroying it so an attacker disconnect cannot become an uncaught exception.
	socket.on("error", () => undefined);
	socket.destroy();
}

export function previewUpgradeGuard(): Plugin {
	return {
		name: "ceraui-preview-upgrade-guard",
		configurePreviewServer(server) {
			server.httpServer?.prependListener("upgrade", (request, socket) => {
				if (!isAcceptedPreviewWebSocketPath(request.url)) {
					rejectWebSocketUpgrade(socket);
				}
			});
		},
	};
}
