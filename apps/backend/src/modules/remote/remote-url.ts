import { formatUrlHost } from "../network/internet.ts";

export function buildRemoteWsUrl(
	protocol: "ws" | "wss",
	host: string,
	path: string,
): URL {
	const url = new URL(`${protocol}://${formatUrlHost(host)}`);
	url.pathname = path;
	return url;
}
