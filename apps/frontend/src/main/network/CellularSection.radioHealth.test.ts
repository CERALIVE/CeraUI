// @vitest-environment jsdom
/**
 * Radio health says "No SIM" only for a slot read as empty. The row's legacy
 * `no_sim` fold also covers a slot that could not be read, and a panel that
 * reads that as absence tells the operator to insert a SIM that may be there.
 */
import type { Modem, RadioHealth, RadioMetric } from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import CellularSection from "./CellularSection.svelte";

vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { configure: vi.fn() } },
}));
vi.mock("$lib/rpc", () => ({
	rpc: { modems: { getRadioHealth: vi.fn(async () => ({})) } },
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
}));

const at = Date.now();
const absent: RadioMetric = {
	value: null,
	source: "ModemManager",
	unit: "",
	technology: "unknown",
	capturedAt: at,
};
const radio: RadioHealth = {
	capturedAt: at,
	registration: absent,
	layer: {
		value: "LTE",
		source: "QENG servingcell",
		unit: "",
		technology: "lte",
		capturedAt: at,
	},
	band: absent,
	metrics: {},
	neighbours: [],
	usb: { available: false, events: [] },
	finding: { kind: "unknown", confidence: "unknown", evidence: [] },
	timeline: [],
};

function modem(sim: Partial<Modem>): Modem {
	return {
		ifname: "wwan0",
		name: "Quectel RM520N-GL - 00000",
		network_type: { supported: ["4G"], active: null },
		device_class: "usb",
		status: {
			connection: "registered",
			network: "Example",
			network_type: "LTE",
			signal: 60,
			roaming: false,
		},
		radio_health: radio,
		...sim,
	} as Modem;
}

async function openRow(entry: Modem) {
	const view = render(CellularSection, {
		props: {
			modemEntries: [["0", entry]],
			netif: { wwan0: { tp: 0, enabled: false } },
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConfigure: vi.fn(),
		},
	});
	await fireEvent.click(view.getByTestId("modem-details-toggle"));
	return {
		status: view.getByTestId("radio-health").dataset.status,
		detail: view.queryByTestId("modem-detail")?.textContent ?? "",
	};
}

describe("radio health SIM verdict follows the slot reading", () => {
	it("an unreadable slot folded into no_sim is not checked, never No SIM", async () => {
		const { status, detail } = await openRow(
			modem({ no_sim: true, sim_presence: "unknown" }),
		);
		expect(status).not.toBe("no-sim");
		// The card names the network type, so the row line leaves it out.
		expect(detail).not.toContain("LTE");
	});

	it("a slot read as empty is No SIM, and the row keeps its own network line", async () => {
		const { status, detail } = await openRow(
			modem({ no_sim: true, sim_presence: "absent" }),
		);
		expect(status).toBe("no-sim");
		expect(detail).toContain("LTE");
	});

	it("a backend that sends only the legacy no_sim fold still reads as No SIM", async () => {
		const { status } = await openRow(modem({ no_sim: true }));
		expect(status).toBe("no-sim");
	});
});
