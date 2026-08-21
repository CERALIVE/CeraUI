// @vitest-environment jsdom
/**
 * EthernetSection — router-mode cellular dongle row (modem-stack Phase B, todo 43).
 *
 * The backend classifies a USB network interface from its DEVICE DESCRIPTORS and
 * stamps `router_cellular` on the row. This is INDEPENDENT of the `dongle`
 * marker: it needs no netns manager, so it is what labels a HiLink/MF79U-class
 * dongle honestly on the image every board actually runs today.
 *
 * The rows below are the real bench topology: two physically distinct Huawei
 * HiLink units sharing one factory MAC — which is why one is named
 * `enx0c5b8f279a64` and its twin fell back to `eth1` — both leasing the host the
 * identical 192.168.8.100, plus a lone ZTE MF79U-class unit on its own subnet.
 */
import type { NetifEntry, RouterCellularMarker } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import { elementShape } from "./__fixtures__/element-shape";
import EthernetSection from "./EthernetSection.svelte";

vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { configure: vi.fn() } },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const HILINK: RouterCellularMarker = {
	vendor: "HUAWEI_MOBILE",
	model: "HUAWEI_MOBILE",
	vid_pid: "12d1:14dc",
	kind: "router-cellular",
	duplicate_model: true,
};

const ZTE: RouterCellularMarker = {
	vendor: "ZTE,Incorporated",
	model: "ZTE Mobile Boardband",
	vid_pid: "19d2:1405",
	kind: "router-cellular",
	duplicate_model: false,
};

const PLAIN_ROW: NetifEntry = { tp: 1234, enabled: true, ip: "192.168.1.2" };

function renderRows(rows: [string, NetifEntry][]) {
	return render(EthernetSection, {
		props: {
			wiredEntries: rows,
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConfigure: vi.fn(),
		},
	});
}

const BENCH_ROWS: [string, NetifEntry][] = [
	[
		"enx0c5b8f279a64",
		{
			tp: 0,
			enabled: false,
			ip: "192.168.8.100",
			error: "duplicate IPv4 addr",
			router_cellular: HILINK,
		},
	],
	[
		"eth1",
		{
			tp: 0,
			enabled: false,
			ip: "192.168.8.100",
			error: "duplicate IPv4 addr",
			router_cellular: HILINK,
		},
	],
	[
		"enx344b50000000",
		{ tp: 4096, enabled: true, ip: "192.168.0.169", router_cellular: ZTE },
	],
	["eth0", PLAIN_ROW],
];

describe("EthernetSection — router-mode cellular row", () => {
	it("badges every classified row, whatever it is named", () => {
		const { container } = renderRows(BENCH_ROWS);
		const badges = container.querySelectorAll(
			'[data-testid="netif-router-cellular"]',
		);
		expect(badges.length).toBe(3);
		for (const badge of badges) {
			expect(badge.textContent).toContain("Cellular (Router Mode)");
		}
		// `eth1` carries the badge even though nothing about its name suggests a
		// dongle — the classification never read it.
		const rows = container.querySelectorAll(".divide-y > div");
		expect(rows[1]?.textContent).toContain("Cellular (Router Mode)");
	});

	it("explains what router mode means where the claim is made", () => {
		const { getAllByTestId } = renderRows(BENCH_ROWS);
		const title = getAllByTestId("netif-router-cellular")[0]?.getAttribute(
			"title",
		);
		expect(title).toContain("USB descriptors");
		expect(title).toContain("router mode");
	});

	it("names the unit by its own descriptors, deduplicating a doubled string", () => {
		const { container } = renderRows(BENCH_ROWS);
		const ids = [
			...container.querySelectorAll(
				'[data-testid="netif-router-cellular-identity"]',
			),
		].map((el) => el.textContent?.trim());
		// Huawei publishes the SAME string as manufacturer and product; printing
		// it twice would be noise, not honesty.
		expect(ids[0]).toBe("HUAWEI_MOBILE · 12d1:14dc");
		expect(ids[2]).toBe("ZTE,Incorporated ZTE Mobile Boardband · 19d2:1405");
	});

	it("always states where the address came from, on screen", () => {
		// A tooltip is unreachable on the kiosk touchscreen this device ships with,
		// so the one fact an operator will otherwise try to change must be visible.
		const { getAllByTestId } = renderRows(BENCH_ROWS);
		const notes = getAllByTestId("netif-router-cellular-address-note");
		expect(notes.length).toBe(3);
		expect(notes[0]?.textContent).toContain("DHCP");
	});

	it("raises the collision band ONLY for a proven same-model pair", () => {
		const { container } = renderRows(BENCH_ROWS);
		const bands = container.querySelectorAll(
			'[data-testid="netif-router-cellular-collision"]',
		);
		expect(bands.length).toBe(2);
		expect(bands[0]?.textContent).toContain("HUAWEI_MOBILE");
		expect(bands[0]?.textContent).toContain("same factory LAN subnet");
		// The lone ZTE has no sibling, so it makes no collision claim.
		const rows = container.querySelectorAll(".divide-y > div");
		expect(
			rows[2]?.querySelector('[data-testid="netif-router-cellular-collision"]'),
		).toBeNull();
	});

	it("carries a GLYPH and a WORD, not colour alone", () => {
		const { getAllByTestId } = renderRows(BENCH_ROWS);
		const badge = getAllByTestId("netif-router-cellular")[0];
		expect(badge?.querySelector("svg")).not.toBeNull();
		const band = getAllByTestId("netif-router-cellular-collision")[0];
		expect(band?.querySelector("svg")).not.toBeNull();
		expect(band?.getAttribute("role")).toBe("status");
	});

	it("renders NOTHING router-cellular for an unmarked wired row", () => {
		const { queryByTestId } = renderRows([["eth0", PLAIN_ROW]]);
		expect(queryByTestId("netif-router-cellular")).toBeNull();
		expect(queryByTestId("netif-router-cellular-identity")).toBeNull();
		expect(queryByTestId("netif-router-cellular-address-note")).toBeNull();
		expect(queryByTestId("netif-router-cellular-collision")).toBeNull();
	});

	// A retraction must clear the claim, not retire the interface — unlike the
	// `dongle` marker, whose `null` frame is the row's last.
	it("renders an explicitly retracted row as a plain wired row", () => {
		const plain = renderRows([["eth0", PLAIN_ROW]]);
		const plainShape = elementShape(
			plain.container.querySelector(".divide-y > div") as Element,
		);
		plain.unmount();

		const retracted = renderRows([
			["eth0", { ...PLAIN_ROW, router_cellular: null }],
		]);
		const row = retracted.container.querySelector(".divide-y > div") as Element;
		expect(elementShape(row)).toBe(plainShape);
	});

	it("leaves a neighbouring plain row untouched", () => {
		const alone = renderRows([["eth0", PLAIN_ROW]]);
		const aloneShape = elementShape(
			alone.container.querySelector(".divide-y > div") as Element,
		);
		alone.unmount();

		const mixed = renderRows(BENCH_ROWS);
		const rows = mixed.container.querySelectorAll(".divide-y > div");
		expect(rows.length).toBe(4);
		expect(elementShape(rows[3] as Element)).toBe(aloneShape);
	});
});
