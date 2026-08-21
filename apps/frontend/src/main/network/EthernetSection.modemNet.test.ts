// @vitest-environment jsdom
/**
 * EthernetSection — an MM-managed modem's own data function (todo 66).
 *
 * The bench Fibocom FM350-GL is fully represented as a modem, and its RNDIS
 * data path ALSO enumerated as its own Ethernet row: one physical device drawn
 * twice, the second time as a bare `enx000011121314` with no address and no
 * explanation. `NetworkView` moves the row to Cellular once the modem roster
 * claims it, but `netif` and `modems` are independent broadcasts — during the
 * handover window, and on a modem the roster never registers, the row is still
 * here. Naming it is what stops it reading as a mystery second adapter.
 */
import type { NetifEntry, UsbModemNetMarker } from "@ceraui/rpc/schemas";
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

const FM350: UsbModemNetMarker = {
	vendor: "Fibocom Wireless Inc.",
	model: "FM350-GL",
	vid_pid: "0e8d:7127",
	kind: "modem-net",
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

const FM350_ROW: [string, NetifEntry][] = [
	["enx000011121314", { tp: 0, enabled: false, usb_modem_net: FM350 }],
	["eth0", PLAIN_ROW],
];

describe("the row says what the device is", () => {
	it("names the modem behind the interface", () => {
		const { getByTestId } = renderRows(FM350_ROW);

		expect(getByTestId("netif-modem-net-identity").textContent).toContain(
			"Fibocom Wireless Inc. FM350-GL",
		);
		expect(getByTestId("netif-modem-net-identity").textContent).toContain(
			"0e8d:7127",
		);
		expect(getByTestId("netif-modem-net").getAttribute("data-vid-pid")).toBe(
			"0e8d:7127",
		);
	});

	// A kiosk touchscreen cannot hover, so "this is one device, not two" must be
	// on screen rather than only in the badge's tooltip.
	it("states the association in visible text, not only in a title", () => {
		const { getByTestId } = renderRows(FM350_ROW);

		const note = getByTestId("netif-modem-net-note");
		expect(note.textContent).toContain("FM350-GL");
		expect(note.textContent?.trim().length).toBeGreaterThan(0);
	});

	it("never renders a dotted i18n key", () => {
		const { getByTestId } = renderRows(FM350_ROW);

		for (const id of ["netif-modem-net", "netif-modem-net-note"]) {
			expect(getByTestId(id).textContent).not.toMatch(/network\.modemNet\./);
		}
	});
});

describe("the marker touches nothing else", () => {
	it("leaves a plain wired row byte-identical", () => {
		const marked = renderRows(FM350_ROW);
		const plain = renderRows([["eth0", PLAIN_ROW]]);

		const fromMarked = marked.container.querySelectorAll(".divide-y > div")[1];
		const fromPlain = plain.container.querySelectorAll(".divide-y > div")[0];
		expect(fromMarked).toBeDefined();
		expect(fromPlain).toBeDefined();
		expect(elementShape(fromMarked as Element)).toEqual(
			elementShape(fromPlain as Element),
		);
	});

	it("draws nothing for a row that never carried the marker", () => {
		const { queryByTestId } = renderRows([["eth0", PLAIN_ROW]]);

		expect(queryByTestId("netif-modem-net")).toBeNull();
		expect(queryByTestId("netif-modem-net-note")).toBeNull();
	});

	// The retraction is the ingestion deleting the key, so the component only
	// ever has to render "unclassified" — and the row must survive it.
	it("renders a retracted row as a plain interface, not as a missing one", () => {
		const { getByText, queryByTestId } = renderRows([
			["enx000011121314", { tp: 0, enabled: false }],
		]);

		expect(getByText("enx000011121314")).toBeDefined();
		expect(queryByTestId("netif-modem-net")).toBeNull();
	});
});
