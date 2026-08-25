// @vitest-environment jsdom
/**
 * WifiNetworkList — scan-in-progress feedback (Todo 31).
 *
 * While a manual scan is in flight the Scan button is disabled and a progress
 * indicator (`wifi-scan-status`) is shown, so the operator can't queue a second
 * scan mid-flight. The `scanning` flag is fed by the dialog's async-operation
 * phase; here we drive it directly.
 */
import { render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import WifiNetworkList from "./WifiNetworkList.svelte";

const baseProps = {
	iface: undefined,
	networks: [],
	ifaceBusy: false,
	deviceId: "0",
	connecting: undefined,
	disconnecting: undefined,
	forgetting: undefined,
	pendingNew: undefined,
	confirmForget: undefined,
	passwordMin: 8,
	password: "",
	showPassword: false,
	onScan: vi.fn(),
	onConnectSaved: vi.fn(),
	onDisconnect: vi.fn(),
	onConnectNew: vi.fn(),
	onForget: vi.fn(),
	onConfirmForget: vi.fn(),
	onSubmitNew: vi.fn(),
	onResetInteraction: vi.fn(),
};

const scanButton = () =>
	screen.getByTestId("wifi-scan-button") as HTMLButtonElement;

describe("WifiNetworkList — scan progress", () => {
	it("disables the Scan button and shows progress while scanning", () => {
		render(WifiNetworkList, { props: { ...baseProps, scanning: true } });

		expect(scanButton().disabled).toBe(true);
		expect(screen.getByTestId("wifi-scan-status")).toBeTruthy();
	});

	it("enables the Scan button when not scanning", () => {
		render(WifiNetworkList, { props: { ...baseProps, scanning: false } });

		expect(scanButton().disabled).toBe(false);
		expect(screen.queryByTestId("wifi-scan-status")).toBeNull();
	});
});

describe("WifiNetworkList — scan error state", () => {
	it("renders the scan-error state (not the empty state) when a scan failed", () => {
		render(WifiNetworkList, {
			props: { ...baseProps, scanning: false, scanError: true },
		});

		expect(screen.getByTestId("wifi-scan-error")).toBeTruthy();
		expect(screen.queryByTestId("wifi-empty-state")).toBeNull();
	});

	it("shows the settled empty state when there is no scan error", () => {
		render(WifiNetworkList, {
			props: { ...baseProps, scanning: false, scanError: false },
		});

		expect(screen.getByTestId("wifi-empty-state")).toBeTruthy();
		expect(screen.queryByTestId("wifi-scan-error")).toBeNull();
	});

	it("prefers the scanning state over the error state while a scan is in flight", () => {
		render(WifiNetworkList, {
			props: { ...baseProps, scanning: true, scanError: true },
		});

		expect(screen.getByTestId("wifi-scanning-state")).toBeTruthy();
		expect(screen.queryByTestId("wifi-scan-error")).toBeNull();
	});
});

/**
 * The supersession register (todo 16).
 *
 * The three states above all describe an EMPTY list, so a list with rows on it
 * was unmarked however old it was — and a background tick that FAILED left a
 * fresh-looking list on screen with nothing said about it at all.
 */
describe("WifiNetworkList — the rows on screen say how fresh they are", () => {
	const NETWORK = {
		ssid: "CERALIVE",
		signal: 71,
		security: "WPA2",
		freq: 5180,
		active: false,
	};
	const withRows = {
		...baseProps,
		networks: [NETWORK],
		iface: {
			ifname: "wlan0",
			conn: "",
			hw: "",
			saved: {},
			available: [NETWORK],
		},
	};

	it("says nothing about a settled list", () => {
		render(WifiNetworkList, {
			props: { ...withRows, scanning: false, scanError: false },
		});

		expect(screen.queryByTestId("wifi-scan-freshness")).toBeNull();
	});

	it("marks the rows as being replaced while a BACKGROUND scan runs", () => {
		render(WifiNetworkList, {
			props: { ...withRows, scanning: false, scanInFlight: true },
		});

		const mark = screen.getByTestId("wifi-scan-freshness");
		expect(mark.dataset.state).toBe("refreshing");
		expect(mark.getAttribute("role")).toBe("status");
		// Never a raw dotted key.
		expect(mark.textContent).not.toContain("wifiSelector.");
		expect((mark.textContent ?? "").trim().length).toBeGreaterThan(0);
	});

	it("marks a list the last scan failed to replace, where nothing rendered before", () => {
		render(WifiNetworkList, {
			props: { ...withRows, scanning: false, scanError: true },
		});

		const mark = screen.getByTestId("wifi-scan-freshness");
		expect(mark.dataset.state).toBe("stale");
		// The empty-list panel is NOT how a populated list reports a failure.
		expect(screen.queryByTestId("wifi-scan-error")).toBeNull();
	});

	it("reads the two supersessions differently — one word cannot serve both", () => {
		const refreshing = render(WifiNetworkList, {
			props: { ...withRows, scanning: false, scanInFlight: true },
		});
		const refreshingText = refreshing
			.getByTestId("wifi-scan-freshness")
			.textContent?.trim();
		refreshing.unmount();

		const stale = render(WifiNetworkList, {
			props: { ...withRows, scanning: false, scanError: true },
		});

		expect(
			stale.getByTestId("wifi-scan-freshness").textContent?.trim(),
		).not.toBe(refreshingText);
	});

	// A caller that predates the freshness register must render exactly as before.
	it("omitting `scanInFlight` leaves a settled list unmarked", () => {
		render(WifiNetworkList, { props: { ...withRows, scanning: false } });

		expect(screen.queryByTestId("wifi-scan-freshness")).toBeNull();
	});
});
