import type {
	WifiAdapterModeStatus,
	WifiInterface,
	WifiStatus,
} from "@ceraui/rpc/schemas";
import type { WebSocketRoute } from "@playwright/test";
import { expect, test } from "./fixtures/index.js";
import { ensureAuthenticated } from "./helpers/index.js";
import { NetworkPage } from "./pages/network.js";

const station: WifiInterface = {
	ifname: "wlan734",
	hw: "Wi-Fi observation fixture",
	conn: "uplink-uuid",
	saved: {},
	incarnation: "wifi-observation-control",
	mode: "station",
	supports_hotspot: true,
	supports_ap_sta_concurrency: true,
};

const cached: WifiAdapterModeStatus = {
	"0": {
		ifname: station.ifname,
		mode: "hotspot",
		options: [
			{ mode: "station", available: true },
			{ mode: "hotspot", available: true },
			{ mode: "hybrid", available: true },
		],
	},
};

test("settled Wi-Fi mode replaces a stale Hotspot badge without guessing when unreadable", async ({
	page,
	pageRpc,
}) => {
	let socket: WebSocketRoute | undefined;
	await page.routeWebSocket(
		(url) => url.hostname === "localhost" && url.pathname === "/ws",
		(ws) => {
			socket = ws;
			const server = ws.connectToServer();
			pageRpc.bindConnectionLifecycle(ws, server);
			ws.onMessage((message) => {
				const request = JSON.parse(message.toString()) as {
					id?: string;
					path?: string[];
				};
				if (request.path?.join(".") !== "wifi.getAdapterModes") {
					server.send(message);
					return;
				}
				if (!request.id) throw new Error("Missing offering request id");
				ws.send(JSON.stringify({ id: request.id, result: cached }));
			});
			server.onMessage((message) => {
				pageRpc.acceptServerMessage(message);
				const frame = JSON.parse(message.toString()) as {
					status?: { wifi?: WifiStatus };
				};
				// Keep the real socket and replace only the Wi-Fi status under test.
				if (frame.status?.wifi) {
					delete frame.status.wifi;
					ws.send(JSON.stringify(frame));
				} else {
					ws.send(message);
				}
			});
		},
	);

	await page.goto("/");
	await ensureAuthenticated(page);
	await new NetworkPage(page).open();
	const push = (seq: number, radio: WifiInterface) => {
		if (!socket) throw new Error("No browser Wi-Fi connection");
		socket.send(JSON.stringify({ seq, status: { wifi: { "0": radio } } }));
	};
	const row = page.locator('[data-testid="wifi-row"][data-device="0"]');
	const badge = row.getByTestId("wifi-mode-badge");
	push(10_001, station);
	await expect(row).toHaveAttribute("data-ifname", station.ifname);
	await expect(badge).toHaveAttribute("data-mode", "hotspot");

	push(10_002, { ...station, observed_mode: null });
	await expect(badge).toHaveCount(0);

	push(10_003, { ...station, observed_mode: "station" });
	await expect(badge).toHaveAttribute("data-mode", "station");
	await row.getByTestId("open-wifi-mode").click();
	const selector = page
		.getByTestId("wifi-mode-popover-0")
		.getByTestId("wifi-mode-selector");
	await expect(selector).toHaveAttribute("data-device-answered", "true");
	await expect(selector.getByTestId("wifi-mode-option-0-station")).toHaveAttribute(
		"aria-checked",
		"true",
	);
	await expect(selector.getByTestId("wifi-mode-option-0-hotspot")).toHaveAttribute(
		"aria-checked",
		"false",
	);

	push(10_004, {
		...station,
		observed_mode: "hybrid",
		hotspot: { name: "Observation proof", available_channels: {} },
	});
	await expect(badge).toHaveAttribute("data-mode", "hybrid");
});
