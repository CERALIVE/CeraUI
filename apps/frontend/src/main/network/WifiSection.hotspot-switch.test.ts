// @vitest-environment jsdom
/**
 * WifiSection — icon-only "Switch to Hotspot" trigger (ceraui-refinement-pass Todo 2).
 *
 * The station-row hotspot trigger was a text+icon button that crowded the row
 * alongside the per-row Connect button (Todo 1). It is now icon-only (Router
 * glyph) to match the row's action-button density, while staying a11y-safe:
 *   (a) it renders as a button whose ACCESSIBLE NAME is the switchToHotspot copy
 *       (via aria-label) — assistive tech still announces it,
 *   (b) it renders NO visible text node (icon-only, no empty text either),
 *   (c) it keeps the 44px touch-target min sizing tokens,
 *   (d) the isSwitching spinner placeholder gets the SAME icon-only treatment.
 *
 * The destructive-confirm SimpleAlertDialog flow itself is unchanged (covered by
 * the f3-manual-qa e2e); this file locks only the icon-only + a11y contract.
 */
import type { NetifMessage, WifiInterface } from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import WifiSection from "./WifiSection.svelte";

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		network: { configure: vi.fn() },
		wifi: { hotspotStart: vi.fn(), hotspotStop: vi.fn() },
	},
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
}));

const SWITCH_TO_HOTSPOT = "Switch to Hotspot";
const TOUCH_MIN_CLASS = "min-h-[var(--touch-target-min)]";
const TOUCH_MIN_W_CLASS = "min-w-[var(--touch-target-min)]";

function wifiIface(overrides: Partial<WifiInterface> = {}): WifiInterface {
	return {
		ifname: "wlan0",
		conn: "MyNet",
		hw: "hw0",
		available: [
			{ active: true, ssid: "MyNet", signal: 72, security: "WPA2", freq: 5200 },
		],
		saved: {},
		// Station mode + capable of hotspot → the switch trigger renders.
		supports_hotspot: true,
		...overrides,
	} as WifiInterface;
}

function renderSection(iface: Partial<WifiInterface> = {}) {
	const netif: NetifMessage = {
		wlan0: { tp: 1000, enabled: true, ip: "192.168.1.5" },
	} as unknown as NetifMessage;
	return render(WifiSection, {
		props: {
			wifiRadios: [["wifi0", wifiIface(iface)]],
			netif,
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConnect: vi.fn(),
		},
	});
}

afterEach(() => {
	document.documentElement.removeAttribute("data-layout-mode");
	vi.clearAllMocks();
});

describe("WifiSection — icon-only Switch-to-Hotspot trigger", () => {
	it("(a) exposes a button whose accessible name is the switchToHotspot copy", () => {
		const { getByRole } = renderSection();
		const trigger = getByRole("button", { name: SWITCH_TO_HOTSPOT });
		expect(trigger).toBeTruthy();
	});

	it("(b) renders NO visible text node in the trigger (icon-only)", () => {
		const { getByRole } = renderSection();
		const trigger = getByRole("button", { name: SWITCH_TO_HOTSPOT });
		// The accessible name comes from aria-label, not visible text.
		expect(trigger.textContent?.trim()).toBe("");
		// But an SVG icon (Router) IS present.
		expect(trigger.querySelector("svg")).not.toBeNull();
	});

	it("(c) keeps the 44px touch-target min sizing tokens", () => {
		const { getByRole } = renderSection();
		const trigger = getByRole("button", { name: SWITCH_TO_HOTSPOT });
		expect(trigger.className).toContain(TOUCH_MIN_CLASS);
		expect(trigger.className).toContain(TOUCH_MIN_W_CLASS);
	});

	it("(d) the isSwitching spinner placeholder is also icon-only + a11y-named", async () => {
		const { getByRole, getAllByRole } = renderSection();
		// Open the confirm dialog, then confirm to dispatch the switch op. Once the
		// op is pending the row re-renders into the spinner-placeholder branch,
		// which replaces the SimpleAlertDialog trigger with an icon-only spinner
		// button that carries the SAME switchToHotspot accessible name.
		await fireEvent.click(getByRole("button", { name: SWITCH_TO_HOTSPOT }));
		await tick();
		// The AlertDialog Action confirm carries the confirm copy (also
		// "Switch to Hotspot"); pick the one inside the open alertdialog.
		const confirm = getAllByRole("button", { name: SWITCH_TO_HOTSPOT }).find(
			(b) => b.closest('[role="alertdialog"]') !== null,
		);
		expect(confirm, "confirm action must exist in the open dialog").toBeTruthy();
		await fireEvent.click(confirm as HTMLElement);
		await tick();
		// Now the spinner placeholder is the sole Switch-to-Hotspot-named button.
		const placeholder = getByRole("button", { name: SWITCH_TO_HOTSPOT });
		expect(placeholder.textContent?.trim()).toBe("");
		expect(placeholder.querySelector("svg")).not.toBeNull();
		expect(placeholder.className).toContain(TOUCH_MIN_CLASS);
	});
});
