// @vitest-environment jsdom
/**
 * NetworkView — one interface, one live switch, through an isolated dongle's handover.
 *
 * An isolated router dongle reaches the host through a `dg<N>h` veth that carries
 * the `dongle` marker, and its Cellular row owns that veth's bond switch. The
 * backend can retire the veth (`dongle: null`) and later report an UNMARKED
 * interface under the same name while the old modem frame still names it:
 * `netif` and `modems` are separate broadcasts. Ethernet then lists the
 * interface, so the stale Cellular row must not arm a second switch for it.
 *
 * Frames go through the real subscription handler, so the store's merge and
 * retraction rules are part of what is tested.
 */
import type { Modem, NetifEntry } from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const configure = vi.hoisted(() =>
	vi.fn(() => Promise.resolve({ success: true, applied: { enabled: false } })),
);
let push: ((type: string, data: unknown) => void) | undefined;
vi.mock("$lib/rpc/client", () => ({
	rpc: { network: { configure } },
	rpcClient: {
		onMessage: (handler: (type: string, data: unknown) => void) => {
			push = handler;
			return () => {};
		},
		onConnectionChange: () => () => {},
		connect: () => {},
		getSocket: () => null,
		sendLegacy: () => {},
	},
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("$lib/stores/hud.svelte", () => ({
	getHudState: () => ({
		links: [],
		isFullyStale: false,
		staleInterfaces: new Set<string>(),
		unbondedLinkCount: 0,
	}),
}));

import { initSubscriptions, resetState } from "$lib/rpc/subscriptions.svelte";

import NetworkView from "./NetworkView.svelte";

const VETH = "dg0h";
const ETH0: NetifEntry = { tp: 0, enabled: true, ip: "192.168.1.100" };
const DONGLE: Modem = {
	ifname: VETH,
	name: "dongle0",
	slot_label: "dongle0",
	device_class: "router-ethernet",
	availability_reason: "router_managed",
	network_type: { supported: [], active: null },
};

async function send(type: "modems" | "netif", data: unknown): Promise<void> {
	if (!push) throw new Error("message handler was never registered");
	push(type, data);
	await tick();
}

function liveOwners(root: HTMLElement): (string | null | undefined)[] {
	return [
		...root.querySelectorAll<HTMLButtonElement>(
			`[data-testid="bond-toggle-${VETH}"]`,
		),
	]
		.filter((toggle) => !toggle.disabled)
		.map((toggle) =>
			toggle.closest("[data-net-row]")?.getAttribute("data-testid"),
		);
}

function switchIn(root: HTMLElement, owner: string): HTMLButtonElement {
	const toggle = root.querySelector<HTMLButtonElement>(
		`[data-testid="${owner}"] [data-testid="bond-toggle-${VETH}"]`,
	);
	if (!toggle) throw new Error(`no ${VETH} switch under ${owner}`);
	return toggle;
}

beforeEach(() => {
	resetState();
	initSubscriptions();
	configure.mockClear();
});

describe("an isolated dongle's interface has one live switch through a handover", () => {
	it("moves the switch from Cellular to Ethernet, and the stale row never sends", async () => {
		await send("modems", { "1000": DONGLE });
		await send("netif", {
			eth0: ETH0,
			[VETH]: {
				tp: 0,
				enabled: true,
				ip: "192.0.2.5",
				dongle: { slot: 0, state: "up" },
			},
		});
		const { container } = render(NetworkView);
		await tick();

		// The marked, claimed veth: Cellular owns it and sends the veth's own RPC.
		expect(liveOwners(container)).toEqual(["modem-row"]);
		await fireEvent.click(switchIn(container, "modem-row"));
		expect(configure).toHaveBeenCalledWith({
			name: VETH,
			ip: "192.0.2.5",
			enabled: false,
		});
		configure.mockClear();

		// The backend retracts the marker; the old modem frame is still held.
		await send("netif", {
			eth0: ETH0,
			[VETH]: { tp: 0, enabled: true, dongle: null },
		});
		expect(liveOwners(container)).toEqual([]);
		await fireEvent.click(switchIn(container, "modem-row"));

		// An unmarked interface with an address takes the name; the old frame still names it.
		await send("netif", {
			eth0: ETH0,
			[VETH]: { tp: 0, enabled: false, ip: "192.0.2.6" },
		});
		expect(liveOwners(container)).toEqual(["netif-row"]);
		await fireEvent.click(switchIn(container, "modem-row"));
		expect(configure).not.toHaveBeenCalled();

		// The new roster drops the dongle; Ethernet stays the one owner, and its switch works.
		await send("modems", {});
		expect(container.querySelector('[data-testid="modem-row"]')).toBeNull();
		expect(liveOwners(container)).toEqual(["netif-row"]);
		await fireEvent.click(switchIn(container, "netif-row"));
		expect(configure).toHaveBeenCalledWith({
			name: VETH,
			ip: "192.0.2.6",
			enabled: true,
		});
	});
});
