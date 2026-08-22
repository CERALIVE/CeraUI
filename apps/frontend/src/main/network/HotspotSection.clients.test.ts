// @vitest-environment jsdom
/**
 * The joined-client list, rendered while the AP is active.
 *
 * Asserted against the RENDERED DOM because each state is a claim to an
 * operator, and the three of them are genuinely three:
 *
 *   · `clients` ABSENT  → zero nodes. An older backend, or an AP whose first
 *     read has not landed — rendering "0 devices connected" there would assert
 *     a measurement the device never made. This is the regression lock.
 *   · `count: 0`        → a calm line saying nobody is connected. A MEASURED
 *     zero is a reading and is worth showing.
 *   · a populated roster→ the count plus one row per station.
 *
 * The signal cell additionally proves the dBm scale reaches the colour ramp
 * correctly: a -47 dBm client is STRONG, and the app-wide percent ramp would
 * have painted it as weak.
 */
import type { HotspotConfig, WifiInterface } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import HotspotSection from "./HotspotSection.svelte";

function iface(hotspot: Partial<HotspotConfig> = {}): WifiInterface {
	return {
		ifname: "wlan0",
		conn: "hotspot-uuid",
		hw: "58:02:05:e1:79:1c",
		saved: {},
		mode: "hotspot",
		hotspot: {
			name: "CERALIVE_791c",
			password: "correcthorse",
			available_channels: { auto: { name: "Automatic" } },
			channel: "auto",
			...hotspot,
		},
	};
}

function mount(target: WifiInterface) {
	return render(HotspotSection, {
		props: {
			hotspotInterfaces: [["0", target]],
			hotspotTarget: ["0", target],
			onSetup: () => {},
		},
	});
}

const TWO_CLIENTS: HotspotConfig["clients"] = {
	count: 2,
	stations: [
		{
			mac: "8c:85:90:1a:2b:3c",
			signal_dbm: -47,
			tx_bitrate_mbps: 144.4,
			rx_bitrate_mbps: 130,
		},
		{ mac: "3c:22:fb:0e:91:7d", signal_dbm: -71 },
	],
};

describe("HotspotSection — connected clients", () => {
	it("renders one row per joined station, keyed by MAC", () => {
		const { container } = mount(iface({ clients: TWO_CLIENTS }));
		expect(
			container.querySelector(
				'[data-testid="hotspot-client-8c:85:90:1a:2b:3c"]',
			),
		).not.toBeNull();
		expect(
			container.querySelector(
				'[data-testid="hotspot-client-3c:22:fb:0e:91:7d"]',
			),
		).not.toBeNull();
	});

	it("states the count", () => {
		const { container } = mount(iface({ clients: TWO_CLIENTS }));
		expect(
			container.querySelector('[data-testid="hotspot-clients-count-0"]')
				?.textContent,
		).toContain("2");
	});

	it("renders a station's signal and both bitrates", () => {
		const { container } = mount(iface({ clients: TWO_CLIENTS }));
		expect(
			container.querySelector(
				'[data-testid="hotspot-client-signal-8c:85:90:1a:2b:3c"]',
			)?.textContent,
		).toContain("-47");
		expect(
			container.querySelector(
				'[data-testid="hotspot-client-rate-8c:85:90:1a:2b:3c"]',
			)?.textContent,
		).toContain("144 / 130");
	});

	// -47 dBm is a STRONG client. Feeding dBm to the 0-100 percent ramp would
	// resolve `weak` and paint a healthy row red.
	it("colours a strong client with the strong tier, not the weak one", () => {
		const { container } = mount(iface({ clients: TWO_CLIENTS }));
		const strong = container.querySelector(
			'[data-testid="hotspot-client-signal-8c:85:90:1a:2b:3c"]',
		);
		const weak = container.querySelector(
			'[data-testid="hotspot-client-signal-3c:22:fb:0e:91:7d"]',
		);
		expect(strong?.className).toContain("text-signal-excellent");
		expect(weak?.className).toContain("text-signal-weak");
	});

	// Absence renders as absence — never a dash, which reads as a measured zero.
	it("omits the rate cell for a station that reported no bitrate", () => {
		const { container } = mount(iface({ clients: TWO_CLIENTS }));
		expect(
			container.querySelector(
				'[data-testid="hotspot-client-rate-3c:22:fb:0e:91:7d"]',
			),
		).toBeNull();
	});

	it("renders a MEASURED zero as a calm 'nobody is connected' line", () => {
		const { container } = mount(iface({ clients: { count: 0, stations: [] } }));
		const count = container.querySelector(
			'[data-testid="hotspot-clients-count-0"]',
		);
		expect(count?.getAttribute("data-empty")).toBe("true");
		expect(
			container.querySelectorAll("[data-testid^='hotspot-client-']"),
		).toHaveLength(0);
	});

	it("says a capped roster is capped, so the count is not read as the row count", () => {
		const { container } = mount(
			iface({
				clients: { count: 40, stations: [{ mac: "aa:bb:cc:dd:ee:01" }] },
			}),
		);
		expect(
			container.querySelector('[data-testid="hotspot-clients-capped-0"]'),
		).not.toBeNull();
	});

	it("forces the MAC to LTR so an RTL locale cannot reorder its hex pairs", () => {
		const { container } = mount(iface({ clients: TWO_CLIENTS }));
		const row = container.querySelector(
			'[data-testid="hotspot-client-8c:85:90:1a:2b:3c"]',
		);
		expect(row?.querySelector('[dir="ltr"]')?.textContent?.trim()).toBe(
			"8c:85:90:1a:2b:3c",
		);
	});

	// THE REGRESSION LOCK: a backend that predates the station-dump read sends
	// no block at all, and the section must render exactly what it did before.
	describe("regression lock — a device that reported no roster", () => {
		it("renders no clients block whatsoever", () => {
			const { container } = mount(iface());
			expect(
				container.querySelector('[data-testid="hotspot-clients-0"]'),
			).toBeNull();
			expect(
				container.querySelector('[data-testid="hotspot-clients-count-0"]'),
			).toBeNull();
		});

		it("is byte-identical to a roster-bearing row minus the clients block", () => {
			const legacy = mount(iface());
			const legacyHtml = legacy.container.innerHTML;
			legacy.unmount();

			const withClients = mount(iface({ clients: TWO_CLIENTS }));
			withClients.container
				.querySelector('[data-testid="hotspot-clients-0"]')
				?.remove();
			expect(withClients.container.innerHTML).toBe(legacyHtml);
		});

		it("still renders the hotspot name, interface and Setup control", () => {
			const { container } = mount(iface());
			expect(container.textContent).toContain("CERALIVE_791c");
			expect(container.textContent).toContain("wlan0");
			expect(
				container.querySelector('[data-testid="open-hotspot-dialog"]'),
			).not.toBeNull();
		});
	});
});
