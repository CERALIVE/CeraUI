import type { ModemList, NetifMessage } from "@ceraui/rpc/schemas";
import type { Page, WebSocketRoute } from "@playwright/test";

// Complete twin netif entries captured on Rock, 2026-09-07T18:44:18.755Z.
export const TWIN_NETIF: NetifMessage = {
	enx0c5b8f279a64: {
		ip: "192.168.8.100", tp: 0, enabled: true, tx_bps: 0, rx_bps: 0,
		error: "duplicate IPv4 addr", policy_route_missing: false, ethRole: "uplink",
		router_cellular: {
			vendor: "Huawei", model: "E3372 LTE/UMTS/GSM HiLink Modem/Networkcard",
			vid_pid: "12d1:14dc", kind: "router-cellular", duplicate_model: true,
		},
	},
	eth1: {
		ip: "192.168.8.100", tp: 495, enabled: true, tx_bps: 792, rx_bps: 8924,
		error: "duplicate IPv4 addr", policy_route_missing: false, ethRole: "uplink",
		router_cellular: {
			vendor: "Huawei", model: "E3372 LTE/UMTS/GSM HiLink Modem/Networkcard",
			vid_pid: "12d1:14dc", kind: "router-cellular", duplicate_model: true,
		},
	},
};

const modems: ModemList = {
	"1002": { ifname: "enx0c5b8f279a64", name: "Huawei E3372", network_type: { supported: [], active: null }, device_class: "router-ethernet", availability_reason: "router_direct" },
	"1003": { ifname: "eth1", name: "Huawei E3372", network_type: { supported: [], active: null }, device_class: "router-ethernet", availability_reason: "router_direct" },
};

/** Replay at the socket boundary, never at the derived HUD or component props. */
export async function installTwinBondWire(page: Page): Promise<(netif: NetifMessage) => void> {
	let netif = TWIN_NETIF;
	let route: WebSocketRoute | undefined;
	await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
		route = socket;
		const server = socket.connectToServer();
		server.onMessage((message) => {
			if (typeof message !== "string") { socket.send(message); return; }
			const frame = JSON.parse(message);
			if (frame.netif) frame.netif = netif;
			if (frame.modems) frame.modems = modems;
			if (frame.wifi) frame.wifi = {};
			if (frame.status) frame.status = { ...frame.status, modems, wifi: {}, is_streaming: false, linkTelemetry: null, bond_mapping: null };
			socket.send(JSON.stringify(frame));
		});
	});
	return (next) => {
		netif = next;
		if (!route) throw new Error("app websocket has not connected");
		route.send(JSON.stringify({ netif, modems, wifi: {} }));
	};
}
