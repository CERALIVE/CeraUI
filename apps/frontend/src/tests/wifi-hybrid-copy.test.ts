// @vitest-environment jsdom
import { m, setLocale } from "@ceraui/i18n/svelte";
import type { WifiInterface } from "@ceraui/rpc/schemas";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	beginOperation,
	destroyAsyncOperations,
	getOperationReason,
	initAsyncOperations,
} from "$lib/rpc/async-operation.svelte";
import { initSubscriptions, resetState } from "$lib/rpc/subscriptions.svelte";
import { setWifiAdapterModesForTest } from "$lib/rpc/wifi-adapter-modes.svelte";
import HotspotDialog from "$main/dialogs/HotspotDialog.svelte";
import {
	wifiHotspotConfigOpKey,
	wifiModeOpKey,
} from "$main/network/wifi-station-lock";

const handlers: { message?: (type: string, data: unknown) => void } = {};
vi.mock("$lib/rpc/client", () => ({
	rpc: {
		wifi: {
			getAdapterModes: vi.fn(async () => ({})),
			setAdapterMode: vi.fn(async () => ({
				success: false,
				error: "activation-failed",
				reason: "hybrid-channel-not-permitted",
			})),
			hotspotPrepare: vi.fn(async () => ({
				success: true,
				name: "Fixture AP",
				password: "fixture-password",
			})),
			hotspotStart: vi.fn(async () => ({
				success: false,
				error: "activation-failed",
				reason: "hybrid-channel-not-permitted",
			})),
		},
	},
	rpcClient: {
		onMessage: (handler: (type: string, data: unknown) => void) => {
			handlers.message = handler;
			return () => undefined;
		},
		onConnectionChange: () => () => undefined,
		connect: () => undefined,
		getSocket: () => null,
		getConnectionState: () => "connected",
		sendLegacy: () => undefined,
	},
}));
vi.mock("qrcode", () => ({
	default: { toDataURL: vi.fn(async () => "data:image/png;base64,fixture") },
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

beforeEach(() => {
	resetState();
	initAsyncOperations();
	initSubscriptions();
});
afterEach(() => {
	cleanup();
	destroyAsyncOperations();
	setLocale("en");
});

for (const [locale, sentence] of [
	[
		"en",
		"Hybrid is unavailable because the connected Wi-Fi channel does not permit starting a hotspot. Wi-Fi stays connected.",
	],
	[
		"es",
		"No se puede iniciar el hotspot porque el canal de la red Wi-Fi conectada no lo permite. Wi-Fi sigue conectado.",
	],
] as const) {
	it(`renders the device channel refusal from the deferred mode frame in ${locale}`, async () => {
		setLocale(locale);
		render(HotspotDialog, {
			open: true,
			deviceId: "0",
			iface: {
				ifname: "wlan0",
				hw: "Fixture card",
				conn: "station",
				saved: {},
				mode: "station",
				supports_hotspot: true,
				supports_ap_sta_concurrency: true,
				hotspot: {
					name: "Fixture AP",
					password: "fixture-password",
					available_channels: {},
				},
			},
		});
		handlers.message?.("wifi", {
			adapter_mode: { device: 0, mode: "hybrid", pending: true },
		});
		handlers.message?.("wifi", {
			adapter_mode: {
				device: 0,
				error: "activation-failed",
				reason: "hybrid-channel-not-permitted",
			},
		});
		const reason = getOperationReason(wifiModeOpKey("0"));
		expect(reason).toBe("hybrid-channel-not-permitted");
		await tick();
		expect(
			document.querySelector('[data-testid="wifi-mode-error-0"]')?.textContent,
		).toContain(sentence);
	});
}

it("renders the immediate mode refusal through the actual dialog control", async () => {
	setWifiAdapterModesForTest({
		"0": {
			ifname: "wlan0",
			mode: "hybrid",
			desired: "hybrid",
			options: [
				{ mode: "station", available: true },
				{ mode: "hotspot", available: true },
				{ mode: "hybrid", available: true },
			],
		},
	});
	render(HotspotDialog, {
		open: true,
		deviceId: "0",
		iface: {
			ifname: "wlan0",
			hw: "Fixture card",
			incarnation: "fixture",
			conn: "station",
			saved: {},
			mode: "station",
			supports_hotspot: true,
			supports_ap_sta_concurrency: true,
			hotspot: {
				name: "Fixture AP",
				password: "fixture-password",
				available_channels: {},
			},
		},
	});
	const option = document.querySelector<HTMLElement>(
		'[data-testid="wifi-mode-option-0-hotspot"]',
	);
	if (!option) throw new Error("Missing mode option");
	await fireEvent.click(option);
	const apply = document.querySelector<HTMLElement>(
		'[data-testid="wifi-mode-confirm-apply-0"]',
	);
	if (!apply) throw new Error("Missing mode confirmation");
	await fireEvent.click(apply);
	await waitFor(() =>
		expect(
			document.querySelector('[data-testid="wifi-mode-error-0"]')?.textContent,
		).toContain(
			"Hybrid is unavailable because the connected Wi-Fi channel does not permit starting a hotspot. Wi-Fi stays connected.",
		),
	);
});

it("renders a direct Start refusal after the actual credential confirmation", async () => {
	const view = render(HotspotDialog, {
		open: true,
		deviceId: "0",
		iface: {
			ifname: "wlan0",
			hw: "Fixture card",
			incarnation: "fixture",
			conn: "station",
			saved: {},
			mode: "station",
			supports_hotspot: true,
			supports_ap_sta_concurrency: true,
		},
	});
	await fireEvent.click(
		view.getByRole("button", { name: m["network.status.enableHotspot"]() }),
	);
	await waitFor(() =>
		expect(
			document.querySelector('[data-testid="hotspot-confirm-ack"]'),
		).not.toBeNull(),
	);
	const ack = document.querySelector<HTMLElement>(
		'[data-testid="hotspot-confirm-ack"]',
	);
	const activate = document.querySelector<HTMLButtonElement>(
		'[data-testid="hotspot-confirm-activate"]',
	);
	if (!ack || !activate) throw new Error("Missing credential confirmation");
	await fireEvent.click(ack);
	await waitFor(() => expect(activate.disabled).toBe(false));
	await fireEvent.click(activate);
	await waitFor(() =>
		expect(document.body.textContent).toContain(
			"Hybrid is unavailable because the connected Wi-Fi channel does not permit starting a hotspot. Wi-Fi stays connected.",
		),
	);
});

it("renders a deferred config refusal in the settings dialog", async () => {
	render(HotspotDialog, {
		open: true,
		deviceId: "0",
		iface: {
			ifname: "wlan0",
			hw: "Fixture card",
			conn: "station",
			saved: {},
			mode: "station",
			supports_hotspot: true,
			supports_ap_sta_concurrency: true,
			hotspot: {
				name: "Fixture AP",
				password: "fixture-password",
				available_channels: {},
			},
		},
	});
	beginOperation(wifiHotspotConfigOpKey("0"));
	handlers.message?.("wifi", {
		hotspot: {
			config: {
				device: 0,
				error: "activation-failed",
				reason: "hybrid-channel-not-permitted",
			},
		},
	});
	await tick();
	expect(document.body.textContent).toContain(
		"Hybrid is unavailable because the connected Wi-Fi channel does not permit starting a hotspot. Wi-Fi stays connected.",
	);
});

for (const sameChannelOnly of [true, false]) {
	it(`shows the hybrid channel hint only for the driver's SCC restriction=${sameChannelOnly}`, () => {
		setWifiAdapterModesForTest({
			"0": {
				ifname: "wlan0",
				mode: "hybrid",
				desired: "hybrid",
				options: [
					{ mode: "station", available: true },
					{ mode: "hotspot", available: true },
					{ mode: "hybrid", available: true },
				],
			},
		});
		const iface: WifiInterface = {
			ifname: "wlan0",
			hw: "Fixture radio",
			conn: "station",
			saved: {},
			mode: "station",
			supports_hotspot: true,
			supports_ap_sta_concurrency: true,
			hotspot: {
				name: "Fixture AP",
				password: "fixture-password",
				channel: "auto",
				available_channels: { auto: { name: "Auto" } },
			},
			capabilities: {
				phy: "phy0",
				generation: "wifi7",
				bands: ["2.4"],
				maxWidthMhz: {},
				apModes: ["2.4"],
				staApCombo: { supported: true, sameChannelOnly },
				wpa3Sae: "supported",
				regulatory: { country: "00", is6GhzLegal: false, self_managed: false },
			},
		};
		render(HotspotDialog, { open: true, deviceId: "0", iface });
		const hint = document.querySelector(
			'[data-testid="hotspot-hybrid-channel-hint"]',
		);
		expect(hint !== null).toBe(sameChannelOnly);
	});
}
