// @vitest-environment jsdom
/**
 * RouterDongleDialog — the expanded read-only telemetry the dongle's own admin
 * API states about its NETWORK (todo 23).
 *
 * Todo 20 normalized the SIGNAL; this is everything else the ZTE and UFI
 * dialects publish — network type, operator, serving cell, band, and the UFI's
 * WAN/SIM/product record. The gate is the same honesty rule the identity grid
 * above it already follows: a field the device did not state renders NO row.
 * A dash there would read as "the dongle reported nothing for this", which is
 * a different claim from "this dialect has no such field", and neither is one
 * the dialog is entitled to make.
 *
 * The second half is the fence: this surface reads, and it must never grow a
 * control for either dialect — the backend refuses every ZTE and UFI write by
 * measurement (`router-cellular-admin.ts`'s header), so a control here could
 * only ever claim a change it did not make.
 */
import { m } from "@ceraui/i18n/svelte";
import type { Modem, RouterAdminDetails } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { beforeAll, describe, expect, it, vi } from "vitest";

import RouterDongleDialog from "./RouterDongleDialog.svelte";

vi.mock("$lib/rpc", () => ({
	rpc: { modems: { setRouterControl: vi.fn() } },
}));

beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
});

/** The bench MF79U's own key set, once a SIM is in it. */
const ZTE_DETAILS: RouterAdminDetails = {
	network_type: "LTE",
	provider: "Claro",
	cell_id: "134318388",
	band: "B4",
};

/** The bench UFI publishes an entirely different set — hence one shared surface. */
const UFI_DETAILS: RouterAdminDetails = {
	provider: "Claro",
	network_mode: "1",
	ssid: "4G-UFI-611A",
	wan_ip: "10.64.12.9",
	imsi: "732101234567890",
	iccid: "8957011234567890123",
	product: "HM-UFI-01",
};

function open(details?: RouterAdminDetails): void {
	const modem = {
		ifname: "enx344b50000000",
		name: "ZTE MF79U",
		router_admin: {
			admin_url: "http://192.168.0.1",
			reachable: true,
			model: "MF79U",
			...(details === undefined ? {} : { details }),
		},
	} as unknown as Modem;
	render(RouterDongleDialog, {
		props: { open: true, deviceId: "router-1", modem },
	});
}

const detail = (id: keyof RouterAdminDetails): string | undefined =>
	document
		.querySelector(`[data-testid="dongle-detail-${id}"]`)
		?.textContent?.trim();

describe("RouterDongleDialog — the dongle's own network telemetry", () => {
	it("renders every ZTE field the device stated", () => {
		open(ZTE_DETAILS);

		expect(
			document.querySelector('[data-testid="dongle-details"]'),
		).not.toBeNull();
		expect(detail("network_type")).toBe("LTE");
		expect(detail("provider")).toBe("Claro");
		expect(detail("cell_id")).toBe("134318388");
		expect(detail("band")).toBe("B4");
	});

	it("renders the UFI's entirely different field set from the same surface", () => {
		open(UFI_DETAILS);

		expect(detail("network_mode")).toBe("1");
		expect(detail("ssid")).toBe("4G-UFI-611A");
		expect(detail("wan_ip")).toBe("10.64.12.9");
		expect(detail("imsi")).toBe("732101234567890");
		expect(detail("iccid")).toBe("8957011234567890123");
		expect(detail("product")).toBe("HM-UFI-01");
	});

	it("renders NO row for a field the device did not state", () => {
		open(ZTE_DETAILS);

		for (const absent of [
			"wan_ip",
			"imsi",
			"iccid",
			"ssid",
			"product",
		] as const) {
			expect(detail(absent)).toBeUndefined();
		}
	});

	it("renders no detail surface at all for a device that stated nothing", () => {
		open();

		expect(document.querySelector('[data-testid="dongle-details"]')).toBeNull();
		expect(
			document.querySelector('[data-testid="dongle-identity"]'),
		).not.toBeNull();
	});

	it("labels every field with real copy, never a dotted key", () => {
		open(UFI_DETAILS);

		const rendered = document.body.textContent ?? "";
		expect(rendered).not.toMatch(/network\.routerCellular\./);
		expect(rendered).toContain(m["network.routerCellular.providerLabel"]());
		expect(rendered).toContain(m["network.routerCellular.wanIpLabel"]());
		expect(rendered).toContain(m["network.routerCellular.detailTitle"]());
	});

	it("offers no control for a dialect with no proven write", () => {
		open(ZTE_DETAILS);

		expect(
			document.querySelector('[data-testid="dongle-controls"]'),
		).toBeNull();
		expect(
			document.querySelector('[data-testid="dongle-no-controls"]'),
		).not.toBeNull();
		expect(
			document.querySelectorAll('[data-testid="dongle-details"] button'),
		).toHaveLength(0);
		expect(
			document.querySelectorAll('[data-testid="dongle-details"] input'),
		).toHaveLength(0);
	});
});
