// @vitest-environment jsdom
/**
 * RouterDongleDialog — the router-family ACTION surface (todo 23).
 *
 * Three claims, each of which the rendered DOM is the only place to settle:
 *
 *   1. A `112008` net-mode refusal renders BLOCKED-WITH-THE-CODE. The section
 *      stays on screen with the firmware's own error code and no control —
 *      hiding it would report a modem that answered as a modem with no network
 *      mode at all.
 *   2. There is NO Wi-Fi write affordance anywhere in the dialog, and an honest
 *      unavailability sentence renders instead. The pinned control package's
 *      Huawei provider exposes exactly `status`/`signal`/`mode`/`data`, so there
 *      is no Wi-Fi write in the stack to gate — and the dongle's Wi-Fi name
 *      being READABLE is not evidence it can be changed.
 *   3. The LAN-subnet rewrite keeps its confirmation and its interlock: it is
 *      offered only where a write was proven, it dispatches nothing until an
 *      explicit second act, and every request carries `confirm: true`.
 *
 * `AppDialog` portals its content out of `render()`'s container, so every query
 * here goes through `document` and every absence sweep is paired with a positive
 * control.
 */
import { m } from "@ceraui/i18n/svelte";
import type {
	Modem,
	RouterAdminCapabilities,
	RouterAdminControls,
	SetRouterSubnetOutput,
} from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import RouterDongleDialog from "./RouterDongleDialog.svelte";

const setRouterSubnet =
	vi.fn<(input: unknown) => Promise<SetRouterSubnetOutput>>();
const setRouterControl = vi.fn();
const setRouterNetMode = vi.fn();
const openRouterAdmin = vi.fn();

vi.mock("$lib/rpc", () => ({
	rpc: {
		modems: {
			setRouterControl: (input: unknown) => setRouterControl(input),
			setRouterNetMode: (input: unknown) => setRouterNetMode(input),
			setRouterSubnet: (input: unknown) => setRouterSubnet(input),
			openRouterAdmin: (input: unknown) => openRouterAdmin(input),
		},
	},
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

beforeEach(() => {
	document.body.innerHTML = "";
	setRouterSubnet.mockReset();
	setRouterControl.mockReset();
	setRouterNetMode.mockReset();
	openRouterAdmin.mockReset();
	setRouterSubnet.mockResolvedValue({ status: "applied" });
});

/** The bench unit's own answer: it declines to discuss its network modes. */
const REFUSED_CATALOG: RouterAdminCapabilities = {
	net_mode: { state: "unavailable", reason: "refused", code: "112008" },
};

const REPORTED_CATALOG: RouterAdminCapabilities = {
	net_mode: {
		state: "reported",
		modes: [
			{ id: "00", name: "AUTO" },
			{ id: "03", name: "LTE ONLY" },
		],
		current: "03",
	},
};

/** The two writes a round-trip on real hardware actually proved. */
const PROVEN_CONTROLS: RouterAdminControls = {
	mobile_data: true,
	roaming_autoconnect: false,
};

function open(
	options: {
		capabilities?: RouterAdminCapabilities;
		controls?: RouterAdminControls;
	} = {},
): void {
	const modem = {
		ifname: "enx0c5b8f279a64",
		name: "Huawei E3372",
		router_admin: {
			admin_url: "http://192.168.8.1",
			reachable: true,
			model: "E3372",
			// The dongle reports its Wi-Fi name and its client count — READINGS the
			// dialog renders, and the exact evidence a control must NOT be inferred
			// from.
			details: { ssid: "HUAWEI-4B21", wifi_clients: "2" },
			...(options.capabilities === undefined
				? {}
				: { capabilities: options.capabilities }),
			...(options.controls === undefined ? {} : { controls: options.controls }),
		},
	} as unknown as Modem;
	render(RouterDongleDialog, {
		props: { open: true, deviceId: "7", modem },
	});
}

const testid = (id: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** Every control an operator could actually act on, anywhere in the dialog. */
function interactiveControls(): readonly HTMLElement[] {
	return Array.from(
		document.querySelectorAll<HTMLElement>(
			'button, input, select, textarea, [role="switch"], [role="checkbox"]',
		),
	);
}

function describeControl(element: HTMLElement): string {
	return [
		element.dataset.testid ?? "",
		element.getAttribute("aria-label") ?? "",
		element.getAttribute("name") ?? "",
		element.getAttribute("id") ?? "",
		element.textContent ?? "",
	]
		.join(" ")
		.toLowerCase();
}

async function typeSubnet(address: string): Promise<void> {
	const field = testid("dongle-subnet-address");
	expect(field).not.toBeNull();
	await fireEvent.input(field as HTMLInputElement, {
		target: { value: address },
	});
}

describe("RouterDongleDialog — a refused net-mode catalog is BLOCKED, not hidden", () => {
	it("keeps the section on screen and marks it blocked", () => {
		open({ capabilities: REFUSED_CATALOG });

		const section = testid("dongle-net-mode");
		expect(section).not.toBeNull();
		// The load-bearing assertion: `blocked`, never `absent`. A refusal is a
		// READING about the device, so hiding the control would claim this modem
		// has no network mode rather than that its firmware declined to say.
		expect(section?.dataset.capabilityState).toBe("blocked");
	});

	it("puts the firmware's OWN error code on screen", () => {
		open({ capabilities: REFUSED_CATALOG });

		const reason = testid("dongle-net-mode-reason");
		expect(reason?.textContent).toContain("112008");
		expect(reason?.textContent?.trim()).toBe(
			m["network.routerCellular.netMode.refused"]({ code: "112008" }),
		);
	});

	it("offers no control in the blocked arm, and dispatches nothing", async () => {
		open({ capabilities: REFUSED_CATALOG });

		const section = testid("dongle-net-mode");
		expect(section?.querySelectorAll("button")).toHaveLength(0);
		expect(section?.querySelectorAll("input")).toHaveLength(0);
		expect(section?.querySelectorAll('[role="switch"]')).toHaveLength(0);
		expect(setRouterNetMode).not.toHaveBeenCalled();
	});

	it("…and a REPORTED catalog is `available` with its real chips (control)", () => {
		// The non-vacuity half: the same fixture shape with a firmware that DID
		// name its catalog reaches the opposite state, so `blocked` above is a
		// verdict about the device rather than a surface that never renders.
		open({ capabilities: REPORTED_CATALOG });

		expect(testid("dongle-net-mode")?.dataset.capabilityState).toBe(
			"available",
		);
		expect(testid("dongle-net-mode-03")?.dataset.current).toBe("true");
		expect(testid("dongle-net-mode-reason")).toBeNull();
	});
});

describe("RouterDongleDialog — Wi-Fi is stated unavailable, never offered", () => {
	const WIFI_WRITE_VOCABULARY = /wi-?fi|ssid|wlan|hotspot|broadcast/;

	it("renders NO Wi-Fi control of any kind", () => {
		open({ capabilities: REPORTED_CATALOG, controls: PROVEN_CONTROLS });

		const offenders = interactiveControls().filter((element) =>
			WIFI_WRITE_VOCABULARY.test(describeControl(element)),
		);
		expect(offenders.map(describeControl)).toEqual([]);
	});

	it("…and the sweep is non-vacuous — this fixture DOES render controls", () => {
		open({ capabilities: REPORTED_CATALOG, controls: PROVEN_CONTROLS });

		// If the enumeration matched nothing at all the assertion above would pass
		// on a blank dialog. It does not: the proven toggles are right there.
		expect(interactiveControls().length).toBeGreaterThan(0);
		expect(testid("dongle-control-mobile_data")).not.toBeNull();
	});

	it("renders the unavailability reason instead", () => {
		open({ capabilities: REPORTED_CATALOG, controls: PROVEN_CONTROLS });

		const row = testid("dongle-unavailable-wifi");
		expect(row).not.toBeNull();
		expect(testid("dongle-unavailable-wifi-reason")?.textContent?.trim()).toBe(
			m["network.routerCellular.unavailable.wifi.reason"](),
		);
		// The row is a STATEMENT: nothing on it can be pressed.
		expect(
			row?.querySelectorAll("button, input, select, [role='switch']"),
		).toHaveLength(0);
	});

	it("says the same for a restart, which no provider ships either", () => {
		open({ controls: PROVEN_CONTROLS });

		expect(
			testid("dongle-unavailable-reboot-reason")?.textContent?.trim(),
		).toBe(m["network.routerCellular.unavailable.reboot.reason"]());
	});

	it("still RENDERS the dongle's Wi-Fi readings — a read is not a write", () => {
		// This is why the absence sweep matches on controls rather than on text: the
		// dialog legitimately reports the SSID the dongle published, and inferring a
		// write from that reading is the hearsay this surface exists to refuse.
		open({ controls: PROVEN_CONTROLS });

		expect(testid("dongle-detail-ssid")?.textContent).toContain("HUAWEI-4B21");
	});

	it("never leaks a dotted key onto this surface", () => {
		open({ capabilities: REPORTED_CATALOG, controls: PROVEN_CONTROLS });

		expect(document.body.textContent ?? "").not.toMatch(
			/network\.routerCellular\./,
		);
	});
});

describe("RouterDongleDialog — the subnet rewrite keeps its confirmation", () => {
	it("is offered only for a dongle whose writes were proven", () => {
		open({ controls: PROVEN_CONTROLS });
		expect(testid("dongle-subnet")?.dataset.capabilityState).toBe("available");
	});

	it("renders ZERO nodes for a dialect with no proven write", () => {
		// A ZTE/UFI dongle, and a HiLink whose login is still outstanding, both
		// publish no `controls` — the device would answer `unsupported` before it
		// built a request document.
		open({ capabilities: REPORTED_CATALOG });

		expect(testid("dongle-subnet")).toBeNull();
		expect(testid("dongle-subnet-form")).toBeNull();
		expect(testid("dongle-subnet-start")).toBeNull();
	});

	it("is not a toggle — no switch anywhere in the section", () => {
		open({ controls: PROVEN_CONTROLS });

		const section = testid("dongle-subnet");
		expect(section?.querySelectorAll('[role="switch"]')).toHaveLength(0);
	});

	it("refuses to arm until the target is a usable private address", async () => {
		open({ controls: PROVEN_CONTROLS });

		expect((testid("dongle-subnet-start") as HTMLButtonElement).disabled).toBe(
			true,
		);

		await typeSubnet("8.8.8.8");
		expect((testid("dongle-subnet-start") as HTMLButtonElement).disabled).toBe(
			true,
		);
		expect(testid("dongle-subnet-invalid")).not.toBeNull();

		await typeSubnet("192.168.9.1");
		expect((testid("dongle-subnet-start") as HTMLButtonElement).disabled).toBe(
			false,
		);
		expect(testid("dongle-subnet-invalid")).toBeNull();
	});

	it("DISPATCHES NOTHING until the confirmation is explicitly accepted", async () => {
		open({ controls: PROVEN_CONTROLS });

		await typeSubnet("192.168.9.1");
		await fireEvent.click(testid("dongle-subnet-start") as HTMLButtonElement);

		const panel = testid("dongle-subnet-confirm");
		expect(panel).not.toBeNull();
		expect(panel?.textContent).toContain(
			m["network.routerCellular.subnet.confirmBody"](),
		);
		// The whole point of the second act: arming the confirmation is not the
		// write, and nothing has left the browser yet.
		expect(setRouterSubnet).not.toHaveBeenCalled();
	});

	it("names the target in the confirmation, so it is re-read before it is accepted", async () => {
		open({ controls: PROVEN_CONTROLS });

		await typeSubnet("192.168.9.1");
		await fireEvent.click(testid("dongle-subnet-start") as HTMLButtonElement);

		expect(testid("dongle-subnet-confirm")?.textContent).toContain(
			"192.168.9.1",
		);
	});

	it("cancelling withdraws the confirmation and still dispatches nothing", async () => {
		open({ controls: PROVEN_CONTROLS });

		await typeSubnet("192.168.9.1");
		await fireEvent.click(testid("dongle-subnet-start") as HTMLButtonElement);
		await fireEvent.click(testid("dongle-subnet-cancel") as HTMLButtonElement);

		expect(testid("dongle-subnet-confirm")).toBeNull();
		expect(setRouterSubnet).not.toHaveBeenCalled();
	});

	it("sends the device's own `confirm: true` literal exactly once", async () => {
		open({ controls: PROVEN_CONTROLS });

		await typeSubnet("192.168.9.1");
		await fireEvent.click(testid("dongle-subnet-start") as HTMLButtonElement);
		await fireEvent.click(testid("dongle-subnet-apply") as HTMLButtonElement);

		expect(setRouterSubnet).toHaveBeenCalledTimes(1);
		expect(setRouterSubnet).toHaveBeenCalledWith({
			device: "7",
			address: "192.168.9.1",
			confirm: true,
		});
	});

	it("renders the applied outcome", async () => {
		open({ controls: PROVEN_CONTROLS });

		await typeSubnet("192.168.9.1");
		await fireEvent.click(testid("dongle-subnet-start") as HTMLButtonElement);
		await fireEvent.click(testid("dongle-subnet-apply") as HTMLButtonElement);
		await vi.waitFor(() => {
			expect(testid("dongle-subnet-outcome")).not.toBeNull();
		});

		expect(testid("dongle-subnet-outcome")?.dataset.outcome).toBe("applied");
	});

	it("renders a BLOCKED rewrite as unknown — never applied, never refused", async () => {
		// The device answered at NEITHER address, so nothing about the write can be
		// asserted in either direction.
		setRouterSubnet.mockResolvedValue({
			status: "blocked",
			detail: "unreachable",
		});
		open({ controls: PROVEN_CONTROLS });

		await typeSubnet("192.168.9.1");
		await fireEvent.click(testid("dongle-subnet-start") as HTMLButtonElement);
		await fireEvent.click(testid("dongle-subnet-apply") as HTMLButtonElement);
		await vi.waitFor(() => {
			expect(testid("dongle-subnet-outcome")?.dataset.outcome).toBe("unknown");
		});

		expect(testid("dongle-subnet-outcome")?.textContent).toContain(
			m["network.routerCellular.subnet.blocked"](),
		);
	});

	it("renders the device's mutation interlock refusal rather than a success", async () => {
		setRouterSubnet.mockResolvedValue({
			status: "refused",
			mutationRefusal: "streaming_active",
		});
		open({ controls: PROVEN_CONTROLS });

		await typeSubnet("192.168.9.1");
		await fireEvent.click(testid("dongle-subnet-start") as HTMLButtonElement);
		await fireEvent.click(testid("dongle-subnet-apply") as HTMLButtonElement);
		await vi.waitFor(() => {
			expect(testid("dongle-subnet-outcome")?.dataset.outcome).toBe("refused");
		});

		expect(testid("dongle-subnet-outcome")?.textContent).toContain(
			m["network.routerCellular.subnet.refused.interlock"](),
		);
	});

	it("names the colliding interface a conflict refusal reported", async () => {
		setRouterSubnet.mockResolvedValue({
			status: "refused",
			error: "subnet_conflict",
			conflict: "eth1",
		});
		open({ controls: PROVEN_CONTROLS });

		await typeSubnet("192.168.9.1");
		await fireEvent.click(testid("dongle-subnet-start") as HTMLButtonElement);
		await fireEvent.click(testid("dongle-subnet-apply") as HTMLButtonElement);
		await vi.waitFor(() => {
			expect(testid("dongle-subnet-outcome")?.dataset.outcome).toBe("refused");
		});

		expect(testid("dongle-subnet-outcome")?.textContent).toContain("eth1");
	});
});

describe("RouterDongleDialog — the admin affordance stays reachable", () => {
	it("keeps the proxied web-UI button on the action surface", () => {
		open({ controls: PROVEN_CONTROLS });

		expect(testid("dongle-actions")).not.toBeNull();
		expect(testid("dongle-open-admin")).not.toBeNull();
		expect(testid("dongle-admin-note")?.textContent).toContain("192.168.8.1");
	});
});
