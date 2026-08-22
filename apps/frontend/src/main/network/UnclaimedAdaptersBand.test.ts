// @vitest-environment jsdom
/**
 * UnclaimedAdaptersBand — "the adapter is there; nothing is driving it".
 *
 * Two properties carry this component and both are asserted against the rendered
 * DOM rather than the markup:
 *
 *   1. It says NOTHING unless the device positively reported an undriven
 *      adapter. `undefined` (never probed) and `[]` (every adapter is driven)
 *      are different facts upstream, but neither is something to show.
 *   2. It NEVER GATES. There is not one interactive element inside it — a band
 *      that could disable a control would be a different, much louder thing.
 */

import type { UnclaimedAdapter } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";

import UnclaimedAdaptersBand from "./UnclaimedAdaptersBand.svelte";

const MEDIATEK_PCIE_WIFI: UnclaimedAdapter = {
	bus: "pci",
	vendorId: "14c3",
	deviceId: "7961",
	kind: "wifi",
};

const REALTEK_USB_BT: UnclaimedAdapter = {
	bus: "usb",
	vendorId: "0bda",
	deviceId: "b82c",
	kind: "bluetooth",
};

function mount(adapters?: UnclaimedAdapter[]) {
	return render(UnclaimedAdaptersBand, { props: { adapters } });
}

describe("UnclaimedAdaptersBand — absence renders as absence", () => {
	it("says NOTHING when the device never answered the question", () => {
		expect(
			mount(undefined).queryByTestId("unclaimed-adapters-info"),
		).toBeNull();
	});

	it("says NOTHING when every adapter on the host is driven", () => {
		expect(mount([]).queryByTestId("unclaimed-adapters-info")).toBeNull();
	});
});

describe("UnclaimedAdaptersBand — it names the device", () => {
	it("renders one calm info band naming the id, the kind and the bus", () => {
		const { queryByTestId, getAllByTestId } = mount([MEDIATEK_PCIE_WIFI]);

		const band = queryByTestId("unclaimed-adapters-info");
		expect(band, "an undriven adapter must be operator-visible").not.toBeNull();
		expect(band?.getAttribute("role")).toBe("status");
		// The CALM register, never the amber warning one: nothing is broken and
		// nothing the operator did caused it.
		expect(band?.className).toContain("status-info");
		expect(band?.className).not.toContain("status-warning");

		const rows = getAllByTestId("unclaimed-adapter");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.dataset.bus).toBe("pci");
		expect(rows[0]?.dataset.kind).toBe("wifi");
		expect(rows[0]?.textContent).toContain("14c3:7961");
		expect(rows[0]?.textContent).toContain("Wi-Fi adapter");
		expect(rows[0]?.textContent).toContain("PCIe");
	});

	it("names the count, and each device, when several are undriven", () => {
		const { queryByTestId, getAllByTestId } = mount([
			MEDIATEK_PCIE_WIFI,
			REALTEK_USB_BT,
		]);

		expect(queryByTestId("unclaimed-adapters-title")?.textContent).toContain(
			"2",
		);
		const rows = getAllByTestId("unclaimed-adapter");
		expect(rows.map((r) => r.dataset.kind)).toEqual(["wifi", "bluetooth"]);
		expect(rows[1]?.textContent).toContain("0bda:b82c");
		expect(rows[1]?.textContent).toContain("Bluetooth adapter");
		expect(rows[1]?.textContent).toContain("USB");
	});

	it("resolves every kind through i18n rather than printing the wire token", () => {
		const { getAllByTestId } = mount([
			MEDIATEK_PCIE_WIFI,
			REALTEK_USB_BT,
			{ bus: "usb", vendorId: "05c6", deviceId: "9024", kind: "wireless" },
		]);

		for (const row of getAllByTestId("unclaimed-adapter")) {
			const text = row.textContent ?? "";
			expect(text).not.toContain("network.unclaimedAdapters");
			expect(text).toContain("adapter");
		}
	});
});

describe("UnclaimedAdaptersBand — it NEVER gates", () => {
	it("renders no interactive element of any kind", () => {
		const { queryByTestId } = mount([MEDIATEK_PCIE_WIFI, REALTEK_USB_BT]);
		const band = queryByTestId("unclaimed-adapters-info");
		expect(band).not.toBeNull();

		expect(
			band?.querySelectorAll(
				"button, a, input, select, textarea, [role='button'], [role='switch'], [tabindex]",
			).length,
		).toBe(0);
	});

	it("carries no disabled control and no aria-disabled anywhere", () => {
		const { queryByTestId } = mount([MEDIATEK_PCIE_WIFI]);
		const band = queryByTestId("unclaimed-adapters-info");
		expect(band?.querySelectorAll("[disabled], [aria-disabled]").length).toBe(
			0,
		);
	});
});
