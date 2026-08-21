// @vitest-environment jsdom
/**
 * The "Open admin UI" affordance on a router-mode dongle's row.
 *
 * A router dongle's real configuration surface is its OWN embedded web UI, and
 * until now the row could only STATE that address — the operator's browser is
 * not on the dongle's network, so an anchor would have been a control that
 * cannot work. CeraUI now carries that page itself, so the address becomes
 * reachable and the row gains a button.
 *
 * What this file pins is the property that makes the button safe: it is keyed on
 * the ROW ID, never on the address. The bench fixture is the real collision —
 * two Huawei E3372 units that share one factory LAN subnet, both leasing the
 * host `192.168.8.100` and both publishing `192.168.8.1` as their admin address
 * — so a button that carried the address would open whichever of the pair the
 * kernel happened to pick.
 */
import type { Modem, NetifMessage } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";

import CellularSection from "./CellularSection.svelte";
import {
	openRouterAdminUi,
	routerAdminOpenReasonKey,
} from "./router-admin-open";

const openRouterAdmin = vi.fn();

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		network: { configure: vi.fn() },
		modems: {
			openRouterAdmin: (...args: unknown[]) => openRouterAdmin(...args),
		},
	},
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConnectionState: () => "connected",
}));

/** The bench twins: distinct units, distinct serials, ONE shared address. */
function twin(ifname: string, serial: string): Modem {
	return {
		ifname,
		name: "Huawei E3372 LTE/UMTS/GSM HiLink Modem/Networkcard",
		model: "E3372 LTE/UMTS/GSM HiLink Modem/Networkcard",
		manufacturer: "Huawei",
		network_type: { supported: [], active: null },
		device_class: "router-ethernet",
		availability_reason: "router_direct",
		router_admin: {
			admin_url: "http://192.168.8.1",
			reachable: true,
			model: "E3372",
			serial,
			sim: "absent",
			connection: "disconnected",
		},
	} as Modem;
}

function mmManaged(): Modem {
	return {
		ifname: "wwan0",
		name: "Quectel RM530N-GL",
		network_type: { supported: [], active: null },
		device_class: "usb",
		status: { connection: "connected", network: "Carrier", roaming: false },
	} as unknown as Modem;
}

const BENCH_NETIF: NetifMessage = {
	enx0c5b8f279a64: { tp: 0, enabled: false, ip: "192.168.8.100" },
	eth1: { tp: 0, enabled: false, ip: "192.168.8.100" },
};

function renderRoster(entries: [string, Modem][]) {
	return render(CellularSection, {
		props: {
			modemEntries: entries,
			netif: BENCH_NETIF,
			isFullyStale: false,
			staleInterfaces: new Set<string>(),
			onConfigure: vi.fn(),
		},
	});
}

describe("the admin-UI affordance on a router-ethernet row", () => {
	it("renders once per router-ethernet dongle, keyed on the ROW ID", () => {
		const { container } = renderRoster([
			["7", twin("enx0c5b8f279a64", "Y4QDU17621000872")],
			["8", twin("eth1", "Y4QDU17621000793")],
		]);

		const buttons = container.querySelectorAll<HTMLElement>(
			'[data-testid="open-router-admin"]',
		);
		expect(buttons).toHaveLength(2);

		// The two units are indistinguishable by address — this is exactly the
		// collision the board carries — so the DEVICE key must separate them.
		const devices = [...buttons].map((b) => b.dataset.device);
		expect(devices).toEqual(["7", "8"]);
		expect(devices[0]).not.toBe(devices[1]);

		// Nothing on the control carries the shared address.
		for (const button of buttons) {
			expect(button.outerHTML).not.toContain("192.168.8.1");
		}
	});

	it("is absent on a directly-managed modem, which has no such web UI", () => {
		const { container } = renderRoster([["1", mmManaged()]]);
		expect(
			container.querySelector('[data-testid="open-router-admin"]'),
		).toBeNull();
	});

	it("is absent when the dongle's admin API was never read", () => {
		const bare = twin("eth1", "Y4QDU17621000793");
		const { router_admin: _dropped, ...withoutAdmin } = bare as Modem & {
			router_admin?: unknown;
		};
		const { container } = renderRoster([["8", withoutAdmin as Modem]]);
		expect(
			container.querySelector('[data-testid="open-router-admin"]'),
		).toBeNull();
	});

	it("still renders for a dongle whose admin API did not answer", () => {
		// The address is a ROUTING fact, so it is worth offering even when the
		// last read failed — the device may simply have been busy.
		const unreachable = twin("eth1", "Y4QDU17621000793");
		(unreachable as Modem).router_admin = {
			admin_url: "http://192.168.8.1",
			reachable: false,
		} as Modem["router_admin"];
		const { container } = renderRoster([["8", unreachable]]);
		expect(
			container.querySelector('[data-testid="open-router-admin"]'),
		).not.toBeNull();
	});
});

describe("opening a session", () => {
	it("dispatches the ROW ID and navigates the tab the gesture opened", async () => {
		const tab = { location: { replace: vi.fn() }, close: vi.fn() };
		const request = vi.fn().mockResolvedValue({
			success: true,
			url: "/dongle-admin/8/?dongle_token=t",
		});

		const outcome = await openRouterAdminUi("8", {
			openTab: () => tab as unknown as Window,
			request,
		});

		expect(request).toHaveBeenCalledWith("8");
		expect(outcome).toEqual({ ok: true });
		expect(tab.location.replace).toHaveBeenCalledWith(
			"/dongle-admin/8/?dongle_token=t",
		);
		expect(tab.close).not.toHaveBeenCalled();
	});

	it("a refusal closes the tab it opened rather than stranding a blank one", async () => {
		const tab = { location: { replace: vi.fn() }, close: vi.fn() };
		const outcome = await openRouterAdminUi("8", {
			openTab: () => tab as unknown as Window,
			request: vi
				.fn()
				.mockResolvedValue({ success: false, error: "interface_unresolved" }),
		});

		expect(outcome).toEqual({ ok: false, reason: "interface_unresolved" });
		expect(tab.close).toHaveBeenCalled();
		expect(tab.location.replace).not.toHaveBeenCalled();
	});

	it("the tab is opened in the GESTURE, before the RPC is awaited", async () => {
		// A popup blocker only trusts a `window.open` inside the user gesture, so
		// the ORDER here is the whole reason the tab exists before the answer does.
		const order: string[] = [];
		const tab = { location: { replace: vi.fn() }, close: vi.fn() };
		await openRouterAdminUi("8", {
			openTab: () => {
				order.push("open");
				return tab as unknown as Window;
			},
			request: async () => {
				order.push("request");
				return { success: true, url: "/dongle-admin/8/" };
			},
		});
		expect(order).toEqual(["open", "request"]);
	});

	it("a blocked popup still navigates rather than doing nothing", async () => {
		// `window.open` answering `null` is also what `noopener` does BY SPEC —
		// which is why the real opener must not pass it: with no handle there is
		// nothing to navigate, and the operator's own tab is taken instead.
		const assign = vi.fn();
		const original = window.location;
		Object.defineProperty(window, "location", {
			configurable: true,
			value: { ...original, assign },
		});
		try {
			const outcome = await openRouterAdminUi("8", {
				openTab: () => null,
				request: vi
					.fn()
					.mockResolvedValue({ success: true, url: "/dongle-admin/8/" }),
			});
			expect(outcome).toEqual({ ok: true });
			expect(assign).toHaveBeenCalledWith("/dongle-admin/8/");
		} finally {
			Object.defineProperty(window, "location", {
				configurable: true,
				value: original,
			});
		}
	});

	it("a thrown RPC is an honest failure, not a hang", async () => {
		const tab = { location: { replace: vi.fn() }, close: vi.fn() };
		const outcome = await openRouterAdminUi("8", {
			openTab: () => tab as unknown as Window,
			request: vi.fn().mockRejectedValue(new Error("socket closed")),
		});
		expect(outcome).toEqual({ ok: false });
		expect(tab.close).toHaveBeenCalled();
	});

	it("every refusal resolves to real copy, never a raw token", () => {
		const reasons = [
			"unknown_device",
			"interface_unresolved",
			"admin_unreachable",
		] as const;
		for (const reason of reasons) {
			expect(routerAdminOpenReasonKey(reason)).toBe(
				`network.routerCellular.adminOpenReason.${reason}`,
			);
		}
		expect(routerAdminOpenReasonKey(undefined)).toBe(
			"network.routerCellular.adminOpenFailed",
		);
	});
});
