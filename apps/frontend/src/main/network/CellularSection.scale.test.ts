// @vitest-environment jsdom
/**
 * CellularSection at FLEET SCALE, and the identity that has to survive a replug.
 *
 * TWO NUMBERS APPEAR HERE AND THEY ARE NOT THE SAME CLAIM. `HARDWARE_VERIFIED_FLEET`
 * (8) is the size a real bench has actually run; `SOFTWARE_UPPER_BOUND_FIXTURE`
 * (16) is a FIXTURE bound, mirrored from modem-stack's
 * `control/src/providers/conformance-scale.test.ts`, which says in as many words
 * that it must never be reported as hardware. Nothing in this file raises either
 * one, and every assertion states which of the two it is exercising.
 *
 * The row-order rule (`sortModemEntries`) is unit-tested in `cellular-row.test.ts`;
 * what this file proves is that the RENDERED tree honours it — that a replug, an
 * MM restart renumbering and a twin pair swapping interface names all leave the
 * operator's rows exactly where they were, as the same DOM nodes, with their open
 * disclosures intact.
 */
import type { Modem } from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import CellularSection from "./CellularSection.svelte";

vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { configure: vi.fn() } },
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
}));

/** The fleet a real bench has run. Hardware-verified. */
const HARDWARE_VERIFIED_FLEET = 8;
/** modem-stack's fixture bound. FIXTURE — never quote this as hardware. */
const SOFTWARE_UPPER_BOUND_FIXTURE = 16;

type Entry = [string, Modem];

function radio(port: number, over: Partial<Modem> = {}): Modem {
	return {
		ifname: `wwan${port}`,
		name: `RM520N-GL - ${port}`,
		device_class: "usb",
		slot_label: `SIM ${port + 1}`,
		stable_key: `pci-0000:00:14.0-usb-0:1.${port}`,
		network_type: { supported: ["5G", "4G"], active: "4G" },
		status: {
			connection: "connected",
			signal: 71,
			roaming: false,
			network: "Test Carrier",
			network_type: "LTE",
		},
		...over,
	} as Modem;
}

/**
 * The shape the renderer actually receives.
 *
 * Every wire id is `String(number)`, so `Object.entries` hands the roster over in
 * ASCENDING NUMERIC ID order whatever the backend emitted — a fixture built on
 * emission order proves nothing, because the object canonicalises it away. What
 * IS variable is which port each id describes, since mmcli re-issues the index.
 * So this fleet is ascending by id and DESCENDING by port: sorted correctly it
 * reads `wwan0 … wwan{n-1}`, and unsorted it reads exactly backwards.
 */
function fleet(size: number): Entry[] {
	return Array.from(
		{ length: size },
		(_unused, i) => [`${100 + i}`, radio(size - 1 - i)] as Entry,
	);
}

function props(entries: Entry[]) {
	return {
		modemEntries: entries,
		netif: Object.fromEntries(
			entries.map(([, entry], i) => [
				entry.ifname,
				{ tp: 0, enabled: true, ip: `10.0.0.${i + 5}` },
			]),
		),
		isFullyStale: false,
		staleInterfaces: new Set<string>(),
		onConfigure: vi.fn(),
	};
}

function rows(container: HTMLElement): HTMLElement[] {
	return [
		...container.querySelectorAll<HTMLElement>('[data-testid="modem-row"]'),
	];
}

const rowIds = (container: HTMLElement): (string | undefined)[] =>
	rows(container).map((row) => row.dataset.modemId);

const rowIfnames = (container: HTMLElement): (string | undefined)[] =>
	rows(container).map((row) => row.dataset.ifname);

function within(row: HTMLElement, testid: string): HTMLElement | null {
	return row.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
}

afterEach(() => {
	document.documentElement.removeAttribute("data-layout-mode");
	vi.clearAllMocks();
});

describe("a fleet renders one complete row per device", () => {
	it.each([
		["the hardware-verified fleet", HARDWARE_VERIFIED_FLEET],
		["the fixture upper bound (NOT hardware)", SOFTWARE_UPPER_BOUND_FIXTURE],
	])("Given %s, Then every device gets its own row", (_label, size) => {
		const { container } = render(CellularSection, {
			props: props(fleet(size)),
		});

		expect(rows(container)).toHaveLength(size);
		expect(new Set(rowIds(container)).size).toBe(size);
	});

	it("Given the fixture bound, Then no row loses an element to scale", () => {
		const { container } = render(CellularSection, {
			props: props(fleet(SOFTWARE_UPPER_BOUND_FIXTURE)),
		});

		for (const row of rows(container)) {
			for (const testid of [
				"modem-name",
				"modem-state-badge",
				"modem-signal",
				"modem-details-toggle",
				"modem-details-body",
				"open-modem-config-dialog",
			]) {
				expect(
					within(row, testid),
					`${row.dataset.modemId}: ${testid}`,
				).not.toBeNull();
			}
		}
	});

	it("Given the fixture bound, Then every disclosure body id is distinct", () => {
		const { container } = render(CellularSection, {
			props: props(fleet(SOFTWARE_UPPER_BOUND_FIXTURE)),
		});

		const bodyIds = rows(container).map(
			(row) => within(row, "modem-details-body")?.id,
		);

		expect(bodyIds.every((id) => typeof id === "string" && id.length > 0)).toBe(
			true,
		);
		expect(new Set(bodyIds).size).toBe(SOFTWARE_UPPER_BOUND_FIXTURE);
	});

	/**
	 * The todo-64 badge budget is a PER-ROW ceiling, and every earlier proof of it
	 * rendered exactly one row. Sixteen rows is where a per-row ceiling would stop
	 * being a section-wide one if anything ever leaked between them.
	 */
	it("Given the fixture bound, Then the four-badge primary budget holds on EVERY row", () => {
		const { container } = render(CellularSection, {
			props: props(fleet(SOFTWARE_UPPER_BOUND_FIXTURE)),
		});

		for (const row of rows(container)) {
			const body = within(row, "modem-details-body");
			const primary = [
				...row.querySelectorAll<HTMLElement>(
					"[data-status-badge],[data-no-sim]",
				),
			].filter((el) => body === null || !body.contains(el));

			expect(primary.length, `${row.dataset.modemId}`).toBeGreaterThan(0);
			expect(primary.length, `${row.dataset.modemId}`).toBeLessThanOrEqual(4);
		}
	});

	it("Given the fixture bound, Then one row's disclosure opens alone", async () => {
		const { container } = render(CellularSection, {
			props: props(fleet(SOFTWARE_UPPER_BOUND_FIXTURE)),
		});

		const target = rows(container)[7];
		if (!target) throw new Error("no eighth row rendered");
		const toggle = within(target, "modem-details-toggle");
		if (!toggle) throw new Error("no disclosure toggle rendered");

		await fireEvent.click(toggle);

		const open = rows(container).filter(
			(row) => within(row, "modem-details-body")?.dataset.open === "true",
		);
		expect(open).toHaveLength(1);
		expect(open[0]).toBe(target);
	});
});

describe("the rendered order is the hardware's, and a re-issued id does not disturb it", () => {
	const byPort = (size: number): string[] =>
		Array.from({ length: size }, (_unused, i) => `wwan${i}`);

	it("Given ids that no longer describe the ports in order, Then the port decides", () => {
		const { container } = render(CellularSection, {
			props: props(fleet(HARDWARE_VERIFIED_FLEET)),
		});

		expect(rowIfnames(container)).toEqual(byPort(HARDWARE_VERIFIED_FLEET));
	});

	it("Given a replug hands one device a FRESH higher index, Then its row keeps its position", async () => {
		const entries = fleet(HARDWARE_VERIFIED_FLEET);
		const { container, rerender } = render(CellularSection, {
			props: props(entries),
		});

		// mmcli drops the device and re-adds it at the top of the index space, so
		// ascending-id order alone would drag its row to the bottom of the list.
		await rerender(
			props(
				entries.map(([id, m]) =>
					m.ifname === "wwan2" ? (["200", m] as Entry) : ([id, m] as Entry),
				),
			),
		);

		expect(rowIfnames(container)).toEqual(byPort(HARDWARE_VERIFIED_FLEET));
	});

	it("Given an MM restart renumbers every id, Then the ports keep the rows in place", async () => {
		const { container, rerender } = render(CellularSection, {
			props: props(
				[0, 1, 2, 3].map((p, i) => [`${11 + i}`, radio(p)] as Entry),
			),
		});
		expect(rowIfnames(container)).toEqual(byPort(4));

		// 11,13,14,15 -> 0,1,2,3, and MM re-probed the ports in the other order.
		await rerender(
			props([3, 2, 1, 0].map((p, i) => [`${i}`, radio(p)] as Entry)),
		);

		expect(rowIfnames(container)).toEqual(byPort(4));
	});

	it("Given the id SURVIVES a replug, Then so do the row's node and its open disclosure", async () => {
		const entries = fleet(HARDWARE_VERIFIED_FLEET);
		const { container, rerender } = render(CellularSection, {
			props: props(entries),
		});

		const replugged = rows(container)[2];
		if (!replugged) throw new Error("no third row rendered");
		const toggle = within(replugged, "modem-details-toggle");
		if (!toggle) throw new Error("no disclosure toggle rendered");
		await fireEvent.click(toggle);

		// The device comes back on a different interface name — the bench twins do
		// this to each other — under the id it already had.
		await rerender(
			props(
				entries.map(([id, m]) =>
					m.ifname === "wwan2"
						? ([id, { ...m, ifname: "wwanX" }] as Entry)
						: ([id, m] as Entry),
				),
			),
		);

		expect(rows(container)[2]).toBe(replugged);
		expect(replugged.dataset.ifname).toBe("wwanX");
		expect(within(replugged, "modem-details-body")?.dataset.open).toBe("true");
	});
});

/**
 * The FAILURE scenario this todo owns. The bench HiLink pair are two physically
 * distinct dongles publishing ONE factory MAC, so systemd can name only one of
 * them predictably and the other falls back to `eth1` — and which unit loses the
 * race can change on any replug.
 */
describe("a same-MAC twin pair neither merges nor swaps", () => {
	// One factory MAC (0c:5b:8f:27:9a:64), one factory LAN subnet, one model
	// name: nothing on the wire separates these two units except the PORT.
	function twin(port: string, ifname: string): Modem {
		return {
			ifname,
			name: "Huawei E3372",
			device_class: "router-ethernet",
			availability_reason: "router_direct",
			stable_key: `pci-0000:00:14.0-usb-0:${port}`,
			network_type: { supported: [], active: null },
			router_admin: {
				admin_url: "http://192.168.8.1",
				reachable: true,
				sim: "present",
				connection: "connected",
			},
		} as unknown as Modem;
	}

	const pair = (aName: string, bName: string): Entry[] => [
		["2001", twin("1.4.1", aName)],
		["2002", twin("1.4.3", bName)],
	];

	it("Given one MAC across two ports, Then TWO rows render", () => {
		const { container } = render(CellularSection, {
			props: props(pair("enx0c5b8f279a64", "eth1")),
		});

		expect(rows(container)).toHaveLength(2);
		expect(rowIds(container)).toEqual(["2001", "2002"]);
	});

	it("Given the twins rename against each other, Then no row swaps and none remounts", async () => {
		const { container, rerender } = render(CellularSection, {
			props: props(pair("enx0c5b8f279a64", "eth1")),
		});

		const before = rows(container);
		expect(rowIfnames(container)).toEqual(["enx0c5b8f279a64", "eth1"]);

		// Replug: the names swap, and the backend re-emits them in the other order.
		await rerender(props([...pair("eth1", "enx0c5b8f279a64")].reverse()));

		expect(rowIds(container)).toEqual(["2001", "2002"]);
		expect(rowIfnames(container)).toEqual(["eth1", "enx0c5b8f279a64"]);
		expect(rows(container)[0]).toBe(before[0]);
		expect(rows(container)[1]).toBe(before[1]);
	});

	it("Given a fresh allocation SWAPS their ids, Then the ports still decide", async () => {
		const { container, rerender } = render(CellularSection, {
			props: props(pair("enx0c5b8f279a64", "eth1")),
		});
		expect(rowIfnames(container)).toEqual(["enx0c5b8f279a64", "eth1"]);

		// A dongle's id is an allocated index, and a backend restart re-walks the
		// sources — so the unit at 1.4.3 can come back holding the lower one.
		await rerender(
			props([
				["2001", twin("1.4.3", "eth1")],
				["2002", twin("1.4.1", "enx0c5b8f279a64")],
			]),
		);

		expect(rowIfnames(container)).toEqual(["enx0c5b8f279a64", "eth1"]);
		expect(rowIds(container)).toEqual(["2002", "2001"]);
	});

	it("Given only one twin is expanded, Then the rename leaves its sibling collapsed", async () => {
		const { container, rerender } = render(CellularSection, {
			props: props(pair("enx0c5b8f279a64", "eth1")),
		});

		const first = rows(container)[0];
		if (!first) throw new Error("no first twin rendered");
		const toggle = within(first, "modem-details-toggle");
		if (!toggle) throw new Error("no disclosure toggle rendered");
		await fireEvent.click(toggle);

		await rerender(props([...pair("eth1", "enx0c5b8f279a64")].reverse()));

		const open = rows(container).map(
			(row) => within(row, "modem-details-body")?.dataset.open,
		);
		expect(open).toEqual(["true", "false"]);
	});
});
