// @vitest-environment jsdom
/**
 * CellularSection — the todo-64 primary/secondary split.
 *
 * Ten todos each deposited one fact on this row and nobody ever removed one, so
 * a seven-device bench rendered an 864px wall of prose. The redesign is pure
 * INFORMATION ARCHITECTURE: nothing was deleted, four things moved behind one
 * per-row disclosure, and this file is the contract for WHICH four.
 *
 * Two assertions here are the ones that actually matter, and they pull in
 * opposite directions:
 *
 *   - REACHABILITY. Every fact the pre-todo-64 row rendered is still in this
 *     row's DOM. A "less noisy" row that quietly stopped reporting a dongle's
 *     IMEI would be a deletion wearing a redesign's clothes, so the moved
 *     elements are asserted PRESENT — inside the disclosure body, by ancestry,
 *     not merely somewhere on the page.
 *   - THE FLOOR. The four things the operator reads under time pressure —
 *     identity, state, signal, and every "why isn't this working" line — are
 *     asserted OUTSIDE that body. The reason lines are the load-bearing half:
 *     each one is also a disabled control's reason, and the shipped kiosk
 *     touchscreen cannot hover to reveal it anywhere else, so folding them
 *     would trade a real honesty invariant for pixels.
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

/** A radio the network is actively refusing — the todo-49 carrier-refusal case. */
function refusedRadio(): Modem {
	return {
		ifname: "wwan0",
		name: "RM530N-GL - 16855",
		device_class: "usb",
		slot_label: "SIM 1",
		network_type: { supported: ["5G", "4G"], active: "4G" },
		registration_rejection: { error: "location-area-not-allowed" },
		status: {
			connection: "searching",
			signal: 81,
			roaming: false,
			network: "TIGO",
			network_type: "LTE",
		},
	} as Modem;
}

/** The bench HiLink: a router dongle whose admin probe answered in full. */
function hilink(): Modem {
	return {
		ifname: "enx0c5b8f279a64",
		name: "Huawei E3372",
		device_class: "router-ethernet",
		availability_reason: "router_direct",
		router_admin: {
			admin_url: "http://192.168.8.1",
			reachable: true,
			sim: "absent",
			connection: "disconnected",
			signal_bars: 0,
			signal_max_bars: 5,
			apn: "3gnet",
			firmware: "22.333.01.00.00",
			imei: "866850029360451",
			serial: "Y4QDU17621000872",
		},
	} as Modem;
}

function renderRows(entries: [string, Modem][]) {
	return render(CellularSection, {
		props: {
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
		},
	});
}

function row(container: HTMLElement): HTMLElement {
	const el = container.querySelector<HTMLElement>('[data-testid="modem-row"]');
	if (!el) throw new Error("no modem row rendered");
	return el;
}

function detailsBody(container: HTMLElement): HTMLElement {
	const el = container.querySelector<HTMLElement>(
		'[data-testid="modem-details-body"]',
	);
	if (!el) throw new Error("no details body rendered");
	return el;
}

/**
 * Read `inert` as the PROPERTY, not the attribute: jsdom implements the
 * property but does not reflect it back to an attribute the way the HTML spec
 * (and every real browser) does, so `hasAttribute("inert")` is permanently
 * false here and would silently pass a component that never set it at all.
 */
function isInert(el: HTMLElement): boolean {
	return (el as HTMLElement & { inert?: boolean }).inert === true;
}

/** Is `testid` rendered INSIDE the row's disclosure body (not merely present)? */
function insideDetails(container: HTMLElement, testid: string): boolean {
	const el = container.querySelector(`[data-testid="${testid}"]`);
	return el !== null && detailsBody(container).contains(el);
}

afterEach(() => {
	document.documentElement.removeAttribute("data-layout-mode");
	vi.clearAllMocks();
});

describe("the primary row answers four questions and no more", () => {
	it("keeps identity, lifecycle, carrier and signal out of the disclosure", () => {
		const { container } = renderRows([["0", refusedRadio()]]);

		for (const testid of [
			"modem-name",
			"modem-slot-badge",
			"modem-state-badge",
			"modem-carrier-badge",
			"modem-signal",
		]) {
			expect(
				container.querySelector(`[data-testid="${testid}"]`),
				`${testid} must render`,
			).not.toBeNull();
			expect(
				insideDetails(container, testid),
				`${testid} must stay inline`,
			).toBe(false);
		}
	});

	it("keeps EVERY reason line inline — they are disabled controls' reasons", () => {
		const { container } = renderRows([["0", refusedRadio()]]);
		const notes = [
			...container.querySelectorAll<HTMLElement>('[data-testid="modem-note"]'),
		];

		expect(notes.length).toBeGreaterThan(0);
		for (const note of notes) {
			expect(
				detailsBody(container).contains(note),
				`note ${note.dataset.noteKey} was folded away`,
			).toBe(false);
		}
	});

	it("renders the carrier's refusal on the row itself, unabridged", () => {
		const { container } = renderRows([["0", refusedRadio()]]);
		const rejection = container.querySelector<HTMLElement>(
			'[data-note-key="network.cellular.rejection.areaNotAllowed"]',
		);

		expect(rejection).not.toBeNull();
		expect(rejection?.textContent?.trim()).toBeTruthy();
		expect(detailsBody(container).contains(rejection as Node)).toBe(false);
	});

	it("keeps the bond toggle and the row action inline", () => {
		const { container } = renderRows([["0", refusedRadio()]]);
		expect(insideDetails(container, "open-modem-config-dialog")).toBe(false);
		expect(
			detailsBody(container).querySelector("[data-slot='switch']"),
		).toBeNull();
	});
});

describe("the secondary disclosure holds everything that moved, and loses nothing", () => {
	it("files the class band, the detail line and both dongle readings", () => {
		const { container } = renderRows([["0", hilink()]]);

		for (const testid of [
			"modem-class-badge",
			"router-admin-facts",
			"router-admin-note",
		]) {
			expect(
				insideDetails(container, testid),
				`${testid} should have moved into the disclosure`,
			).toBe(true);
		}
	});

	it("files the hardware/technology detail line", () => {
		const { container } = renderRows([["0", refusedRadio()]]);
		expect(insideDetails(container, "modem-detail")).toBe(true);
	});

	it("still reports every dongle reading the probe returned", () => {
		const { container } = renderRows([["0", hilink()]]);
		const text = detailsBody(container).textContent ?? "";

		for (const reading of [
			"3gnet",
			"22.333.01.00.00",
			"866850029360451",
			"Y4QDU17621000872",
			"192.168.8.1",
		]) {
			expect(text, `${reading} is no longer reachable`).toContain(reading);
		}
	});

	it("PRINTS the class explanation that used to be a hover-only title", () => {
		const { container } = renderRows([["0", hilink()]]);
		const badge = container.querySelector<HTMLElement>(
			'[data-testid="modem-class-badge"]',
		);

		expect(badge?.getAttribute("title")).toBeNull();
		expect(detailsBody(container).textContent).toContain("runs its own router");
	});
});

describe("the disclosure is a real disclosure", () => {
	it("starts collapsed and inert, and opens on the labelled button", async () => {
		const { container, getByTestId } = renderRows([["0", hilink()]]);
		const body = detailsBody(container);
		const toggle = getByTestId("modem-details-toggle");

		expect(body.dataset.open).toBe("false");
		expect(isInert(body)).toBe(true);
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(toggle.getAttribute("aria-controls")).toBe(body.id);
		expect(toggle.textContent?.trim()).toBeTruthy();

		await fireEvent.click(toggle);

		expect(detailsBody(container).dataset.open).toBe("true");
		expect(isInert(detailsBody(container))).toBe(false);
		expect(
			getByTestId("modem-details-toggle").getAttribute("aria-expanded"),
		).toBe("true");
	});

	it("toggles ONE row without touching its siblings", async () => {
		const { container } = renderRows([
			["0", refusedRadio()],
			["1", hilink()],
		]);
		const bodies = () => [
			...container.querySelectorAll<HTMLElement>(
				'[data-testid="modem-details-body"]',
			),
		];
		const toggles = [
			...container.querySelectorAll<HTMLElement>(
				'[data-testid="modem-details-toggle"]',
			),
		];

		expect(toggles.length).toBe(2);
		// biome-ignore lint/style/noNonNullAssertion: length asserted above
		await fireEvent.click(toggles[1]!);

		expect(bodies().map((b) => b.dataset.open)).toEqual(["false", "true"]);
	});

	it("gives each row's body a distinct id so aria-controls cannot collide", () => {
		const { container } = renderRows([
			["0", refusedRadio()],
			["1", hilink()],
		]);
		const ids = [
			...container.querySelectorAll<HTMLElement>(
				'[data-testid="modem-details-body"]',
			),
		].map((el) => el.id);

		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.every((id) => id !== "")).toBe(true);
	});

	it("carries the 44px touch target under data-layout-mode=touch", () => {
		document.documentElement.dataset.layoutMode = "touch";
		const { getByTestId } = renderRows([["0", hilink()]]);
		expect(getByTestId("modem-details-toggle").className).toContain(
			"min-h-[var(--touch-target-min)]",
		);
	});

	it("offers the disclosure on EVERY row, whatever the device class", () => {
		const { container } = renderRows([
			["0", refusedRadio()],
			["1", hilink()],
		]);
		expect(
			container.querySelectorAll('[data-testid="modem-details-toggle"]').length,
		).toBe(
			row(container).ownerDocument.querySelectorAll('[data-testid="modem-row"]')
				.length,
		);
	});
});
