import { mock, spyOn } from "bun:test";
import type { WifiAdapterCapabilities } from "@ceraui/rpc/schemas";
import * as dns from "../../modules/network/dns.ts";
import { getRemoteWebSocket, initRemote } from "../../modules/remote/remote.ts";
import * as ssh from "../../modules/system/ssh.ts";
import * as capabilities from "../../modules/wifi/wifi-capabilities.ts";
import * as compat from "../../rpc/compat.ts";
import { StubRemoteSocket } from "./status-client.ts";

mock.module("ws", () => ({ default: StubRemoteSocket }));

export const caps: WifiAdapterCapabilities = {
	phy: "phy1",
	generation: "wifi4",
	bands: ["2.4"],
	maxWidthMhz: { "2.4": 20 },
	apModes: ["2.4"],
	staApCombo: { supported: false, sameChannelOnly: false },
	wpa3Sae: "unknown",
	regulatory: { country: "US", is6GhzLegal: false, self_managed: false },
};

export function wifiStatusFrames(frames: readonly string[]): string[] {
	return frames.filter((bytes) => "wifi" in (JSON.parse(bytes).status ?? {}));
}

export function stubRemoteWifiStatus(): void {
	spyOn(compat, "broadcastMsg").mockRestore();
	spyOn(dns, "dnsCacheResolve").mockResolvedValue({
		addrs: ["127.0.0.1"],
		fromCache: false,
	});
	spyOn(ssh, "getSshStatus").mockResolvedValue(undefined);
	spyOn(capabilities, "getWifiCapabilitiesForInterface").mockReturnValue(caps);
}

export async function connectRemoteWifiStatus() {
	await initRemote();
	const remote = getRemoteWebSocket();
	if (!(remote instanceof StubRemoteSocket))
		throw new Error("Missing fake legacy socket");
	const authenticate = () =>
		remote.emit("message", Buffer.from('{"remote":{"auth/encoder":true}}'));
	return { remote, authenticate };
}
