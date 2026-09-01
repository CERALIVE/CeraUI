import {
	mintLinkId,
	type PhysicalDeviceRecord,
} from "../../modules/modems/physical-identity.ts";
import {
	getNetworkInterfaces,
	netIfBuildMsg,
	processIfconfigOutput,
	resetBondOptOut,
} from "../../modules/network/network-interfaces.ts";
import { setNetifState } from "../../modules/network/state/netif-state.ts";
import { setBondIdentityResolverForTest } from "../../modules/streaming/srtla.ts";
import type { AppWebSocket, RPCContext } from "../../rpc/types.ts";

export const HUAWEI_TWIN_IP = "192.168.8.100";
export const HUAWEI_PORT_IDENTITIES = {
	eth1: "usb-port:platform-fc880000.usb-usb-0:1.3.1",
	enx0c5b8f279a64: "usb-port:platform-fc880000.usb-usb-0:1.3.2",
} as const;

function ifconfigStanza(name: string, ip: string): string {
	return [
		`${name}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`,
		`        inet ${ip}  netmask 255.255.255.0  broadcast 192.168.8.255`,
		"        ether 0c:5b:8f:27:9a:64  txqueuelen 1000  (Ethernet)",
		"        RX packets 200  bytes 20000 (20.0 KB)",
		"        TX packets 100  bytes 1000 (1.0 KB)",
	].join("\n");
}

export function physicalRecord(
	ifname: string,
	identityKey: string,
): PhysicalDeviceRecord {
	return {
		identityKey,
		anchor: "id-path",
		linkId: mintLinkId(identityKey),
		stableKey: identityKey,
		ifname,
		idPath: identityKey,
		displayName: "Huawei E3372",
	};
}

export function installHuaweiIdentityResolver(
	aliases: Readonly<Record<string, string>> = HUAWEI_PORT_IDENTITIES,
): void {
	setBondIdentityResolverForTest((ifname) => {
		const identity = aliases[ifname];
		if (identity === undefined) {
			return physicalRecord(ifname, `physical:${ifname}`);
		}
		return physicalRecord(ifname, identity);
	});
}

export function attachHuaweiTwins(
	firstIfname = "eth1",
	secondIfname = "enx0c5b8f279a64",
): void {
	processIfconfigOutput(
		[
			ifconfigStanza(firstIfname, HUAWEI_TWIN_IP),
			ifconfigStanza(secondIfname, HUAWEI_TWIN_IP),
			ifconfigStanza("eth0", "192.168.78.132"),
		].join("\n\n"),
	);
	netIfBuildMsg();
}

export function resetBondFixture(): void {
	clearBondNetworkFixture();
	resetBondOptOut();
	setBondIdentityResolverForTest(null);
}

export function clearBondNetworkFixture(): void {
	const interfaces = getNetworkInterfaces();
	for (const name of Object.keys(interfaces)) delete interfaces[name];
	setNetifState({});
}

export function makeRpcContext(sent: string[] = []): RPCContext {
	const ws = {
		send: (message: string) => sent.push(message),
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => undefined,
		deauthenticate: () => undefined,
		markActive: () => undefined,
		getLastActive: () => 0,
		setSenderId: () => undefined,
		getSenderId: () => undefined,
		clearSenderId: () => undefined,
	};
}

export function lastNetifEnabled(
	frames: readonly string[],
	ifname: string,
): boolean | undefined {
	for (let index = frames.length - 1; index >= 0; index -= 1) {
		const frame = frames[index];
		if (frame === undefined) continue;
		const parsed: unknown = JSON.parse(frame);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"netif" in parsed &&
			typeof parsed.netif === "object" &&
			parsed.netif !== null
		) {
			const entry = Reflect.get(parsed.netif, ifname);
			if (typeof entry === "object" && entry !== null) {
				const enabled = Reflect.get(entry, "enabled");
				if (typeof enabled === "boolean") return enabled;
			}
		}
	}
	return undefined;
}
