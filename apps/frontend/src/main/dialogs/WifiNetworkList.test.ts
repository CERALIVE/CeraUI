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
